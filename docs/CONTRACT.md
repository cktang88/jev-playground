# System One Playground: Interface Contract (v2)

This is the single source of truth for the HTTP interface between the browser and
`server.mjs`. Upstream wire formats are documented in `OPENROUTER_NOTES.md` and
`CLOUDFLARE_NOTES.md`.

## Concepts

- **Task**: what kind of answer you want. `decide` (typed questions → probabilities) or
  `extract` (typed fields → typed values). Each task owns its input key (`questions` /
  `fields`), its types, and its validation.
- **Provider**: who serves the model: `openrouter` or `cloudflare`.
- **Target**: `"<provider>:<model>"`, e.g. `openrouter:typesafe/jev-1.14` or
  `cloudflare:@cf/cloudflare/clairic`. Only the first `:` splits, so
  `openrouter:inception/mercury-decide:free` works.

## Routes

### `GET /api/health`

```json
{
  "ok": true,
  "mock": false,
  "defaults": { "decide": "openrouter:typesafe/jev-1.14", "extract": "cloudflare:@cf/cloudflare/clairic" },
  "model": "typesafe/jev-1.14",
  "key_present": true,
  "providers": [
    { "id": "openrouter", "label": "OpenRouter", "tasks": ["decide"], "configured": true, "missing": [], "docs": "…" },
    { "id": "cloudflare", "label": "Cloudflare Workers AI", "tasks": ["decide", "extract"], "configured": false,
      "missing": ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"], "hint": "Set …" }
  ]
}
```

`model` and `key_present` are kept for v1 clients.

### `GET /api/catalog` (`?refresh=1` bypasses the 10-minute cache)

```json
{
  "ok": true, "mock": false, "defaults": { … }, "providers": [ … ], "warnings": [],
  "tasks": {
    "decide":  { "id": "decide",  "label": "Decide",  "itemsKey": "questions", "itemNoun": "question", "types": { … }, "options": [] },
    "extract": { "id": "extract", "label": "Extract", "itemsKey": "fields",    "itemNoun": "field",    "types": { … }, "options": [ … ] }
  },
  "models": [
    {
      "id": "openrouter:typesafe/jev-1.14", "provider": "openrouter", "model": "typesafe/jev-1.14",
      "label": "TypeSafe: Jev 1.14", "task": "decide", "types": ["noul", "choice", "score", "box"],
      "vision": true, "context_length": 262144, "pricing": { "input_per_mtok": 0.042 },
      "limits": {}, "notes": "…", "source": "live"
    }
  ]
}
```

- `tasks.*.types` is the UI spec for each type. Decide types declare
  `criteria: { kind: "pair" | "map" | "list" | "none", min? }`. Extract types declare
  `params: [{ key, label, kind, required?, min?, max?, options? }]`, where `kind` is one of
  `text | int | number | bool | enum | number_or_date | step`.
- `models[].source`: `curated` (in this repo), `live` (just listed by the provider's
  models API), or `custom` (client-side only).
- `models[].limits` (all optional): `max_items`, `max_images`, `choice_options: [min, max]`,
  `score_levels: [min, max]`.
- If discovery fails, `warnings` explains why and the curated rows are still returned.

### `POST /api/run`

```json
{
  "task": "decide",                        // "decide" (default) | "extract"
  "target": "openrouter:typesafe/jev-1.14", // or "provider" + "model"; omitted → the task's default
  "state": "<string | object | array>",    // required (extract: may be empty when images are sent)
  "questions": { "<id>": <Question> },      // decide
  "fields": { "<name>": <Field> },          // extract
  "images": ["data:image/png;base64,…"],   // optional, ≤ 4, PNG/JPEG/WebP, ≤ 4 MiB each, ≤ 8 MiB total
  "options": { … },                         // optional, task/provider-specific (below)
  "mock": false                             // optional: synthesize answers for this request only
}
```

`POST /api/decide` and `POST /api/extract` are the same endpoint with `task` preset. A v1
body (`{ state, questions, model? }`) sent to `/api/decide` still works and goes to the default
decide target (`DEFAULT_DECIDE_TARGET`, OpenRouter unless you change it).

**Question** (decide):

- `noul`: `instructions`; optional `criteria: { "true": …, "false": … }`, and if
  `criteria` is present it must have both keys.
- `choice`: `instructions`, `criteria: { "<option>": <description | null> }` with ≥ 2 options.
- `score`: `instructions`, `criteria: [<level 0>, <level 1>, …]`, ordered lowest first, ≥ 2 levels.
- `box`: `instructions` only, and the request must include an image.

`instructions` and criteria values may be strings or structured JSON.

**Field** (extract): `{ "type": …, "instructions"?: string, …params }`. Field names must match
`^[A-Za-z_][A-Za-z0-9_.-]{0,63}$`. Parameters per type are listed in the README table.
`estimate` and `forecast` require `min` < `max`: both numbers, or (`estimate` only) both
ISO dates (real calendar dates, `YYYY-MM-DD`). A `log` scale needs `min > 0`. Each type
accepts only `type`, `instructions` and its own parameters. Any other key is rejected, even
if another type uses it.

**Images.** Workers AI receives them as data URLs (`images`), which is its documented
format. OpenRouter receives TypeSafe's `assets` map, with references placed in the state.
OpenRouter's decisions schema has no image field, so whether it forwards images is
**unconfirmed** (see OPENROUTER_NOTES.md).

**Options:**

| Key | Task | Provider | Effect |
| --- | --- | --- | --- |
| `reference_date` | extract | cloudflare | ISO date that anchors dates written without a year |
| `include_quantiles` | extract | cloudflare | adds 99 percentiles to each estimate |
| `return_state_text` | extract | cloudflare | echoes the text that spans index into (`meta.state_text`) |
| `session_id` | decide | openrouter | OpenRouter observability grouping |
| `provider` | decide | openrouter | OpenRouter provider-routing preferences object |

**Success → HTTP 200**

```json
{
  "ok": true,
  "task": "extract",
  "target": "cloudflare:@cf/cloudflare/clairic",
  "provider": "cloudflare",
  "label": "Cloudflare: Clairic",
  "requested_model": "@cf/cloudflare/clairic",
  "model": "clairic",
  "answers": { "<id>": <Answer> },
  "usage": { "input_tokens": 655, "output_tokens": 0, "cost": 0.0000655, "cost_estimated": true, "…": "provider extras" },
  "meta": { "truncated": false },
  "latency_ms": 412,
  "mock": false,
  "upstream": { "method": "POST", "url": "…", "headers": { "Authorization": "Bearer <redacted>" }, "body": { … } }
}
```

- `answers` are passed through exactly as the provider sent them (shapes below).
- `usage.cost` is the provider's figure when it sends one (OpenRouter). Otherwise it is
  `input_tokens × catalog price`, with `cost_estimated: true`. Undefined when the price is unknown.
- `meta`: provider extras, such as OpenRouter's `{ id, served_by }` or Workers AI's
  `{ truncated, state_text? }`.
- `upstream`: the exact request sent upstream, or that would have been sent in mock mode.
  The key and base64 image bytes are redacted.

**Failure → HTTP 4xx/5xx, always this envelope**

```json
{ "ok": false, "error": "Human-readable message", "status": 401, "hint": "Actionable next step",
  "details": {}, "task": "decide", "target": "openrouter:typesafe/jev-1.14", "latency_ms": 3 }
```

| Status | When |
| --- | --- |
| 400 | invalid body, unknown task/provider, invalid model id, a model that cannot do what was asked (wrong task, unsupported type, too many items/levels/images, ids Clef rejects, WebP on OpenRouter) |
| 403 | `/api/*` called with a `Host` that isn't localhost/`HOST`/`ALLOWED_HOSTS`, or a cross-origin `Origin`; also a static path outside `public/` |
| 404 | unknown `/api/*` route (JSON envelope) or missing static file |
| 405 | a method other than GET/HEAD on a static path |
| 413 | body over 16 MiB |
| 415 | POST without `Content-Type: application/json` |
| 401 | the provider has no credentials configured (and `mock` is off), or the provider rejected them |
| 402 / 403 / 404 / 429 / 5xx | also passed through from the provider, with a hint |
| 502 | provider unreachable, or a 2xx without `answers` |
| 504 | upstream timeout (`UPSTREAM_TIMEOUT_MS`, default 60 s) |

## Answer shapes

Decide:

```json
{ "type": "noul",   "noul": 0.92 }
{ "type": "choice", "choice": "billing", "probabilities": { "billing": 0.84, "sales": 0.16 }, "confidence": 0.6 }
{ "type": "score",  "score": 1.035, "legend": { "0": "Low", "1": "High" }, "probabilities": { "0": 0.1, "1": 0.9 }, "confidence": 0.84 }
{ "type": "box",    "box": { "top": 0.25, "bottom": 0.82, "left": 0.44, "right": 0.84 }, "confidence": 0.92 }
```

`noul` has no `confidence`. On OpenRouter, `probabilities`, `confidence`, and `legend`
are optional.

Extract:

```json
{ "type": "text",     "value": "INV-2291", "guess": "INV-2291", "span": [8, 16], "p_null": 3.8e-10, "confidence": 1 }
{ "type": "number",   "value": 1080, "guess": 1080, "p_null": 2.3e-8, "confidence": 0.9999 }
{ "type": "date",     "value": "2026-10-02", "guess": "2026-10-02", "p_null": 1.9e-8, "confidence": 0.9999 }
{ "type": "list",     "value": ["Dana Ruiz", "Priya Shah"], "spans": [[120, 129], [131, 141]], "confidence": 0.9999 }
{ "type": "estimate", "value": 30, "mean": 29.5, "median": 30, "p10": 21, "p90": 38, "p_below": 5.9e-6, "p_above": 1.2e-5, "quantiles?": [ … 99 ] }
{ "type": "forecast", "value": [2416117], "median": [2419283], "p10": [2270774], "p90": [2556769] }
```

`value` is `null` when the input does not determine it. A forecast may instead arrive as
`steps: [{ median, p10, p90 }, …]`, and the UI accepts both forms.

## Rules

- Keys never reach the browser: not in `/api/health`, `/api/catalog`, or `upstream` previews.
- Validate before calling upstream. Bad input → 400 with a `hint`, and no network call (validation runs before the catalog lookup, so not even model discovery).
- Mock mode (`PLAYGROUND_MOCK=1` server-wide, or `"mock": true` per request) skips the
  network and synthesizes answers in the real shapes, with `"mock": true`. Mock extraction
  answers point their spans at real text in the state.
- Static files come from `public/`, with no build step and no external scripts.
