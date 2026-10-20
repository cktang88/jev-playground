# Cloudflare Workers AI notes: Clairic (extraction) and Clef (decisions)

These notes come from public docs, fetched 2026-10-20. No authenticated calls were made, so
anything that needs a live call is marked **UNCONFIRMED**.

Sources:
- Blog, "Introducing Clairic, a new System One class of extraction models": https://blog.cloudflare.com/clairic-extraction-model
- Clairic model page: https://developers.cloudflare.com/workers-ai/models/clairic/
  (raw schemas: `…/clairic/schema-input.json`, `…/clairic/schema-output.json`)
- Clef: https://developers.cloudflare.com/workers-ai/models/clef/ · Clef Flash: `…/models/clef-flash/`
- Extraction concepts: https://developers.cloudflare.com/workers-ai/concepts/extraction-models/
- REST setup: https://developers.cloudflare.com/workers-ai/get-started/rest-api/

## TL;DR for the playground

| Model | Task | Body `model` | Price | Context | Notes |
| --- | --- | --- | --- | --- | --- |
| `@cf/cloudflare/clairic` | extract | `"clairic"` | $0.10 / M input | 65,536 | preview; vision; open weights "soon" |
| `@cf/cloudflare/clef` | decide | `"clef"` | $0.24 / M input | 65,536 | 27B, weights on Hugging Face (`Cloudflare/clef`; OpenRouter calls it "open-source"); vision |
| `@cf/cloudflare/clef-flash` | decide | `"clef-flash"` | $0.038 / M input | 24,576 | 9B; vision |

System One models bill input tokens only: no output tokens, images tokenized as input.
Workers AI responses do not include a cost, so the playground estimates it from these prices
(`cost_estimated: true`).

The three things most likely to break:

1. **The body needs `model` too.** Both schemas mark `model` as required, even though the URL
   already names the model. Clairic accepts `clairic` or `@cf/cloudflare/clairic`; Clef
   accepts `clef` or `clef-flash`. The adapter sends the short alias.
2. **Clairic's `state` is a string.** Structured state has to be serialized first. The
   playground pretty-prints JSON with `JSON.stringify(state, null, 2)`, and spans index into
   that string.
3. **REST responses are wrapped:** `{ result, success, errors: [{ code, message }], messages }`.
   The answers are in `result`. The binding (`env.AI.run`) returns `result` directly.

## REST call

```
POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/cloudflare/clairic
Authorization: Bearer {API_TOKEN}
Content-Type: application/json
```

The docs' curl examples omit `Content-Type`. The adapter sends it anyway.

## Clairic request (`schema-input.json`)

| Key | Type | Notes |
| --- | --- | --- |
| `model` | string, **required** | pattern `^(clairic\|@cf/cloudflare/clairic)$` |
| `state` | string | must be non-empty unless images are sent; text answers are spans of it |
| `fields` | object, **required**, minProperties 1 | names match `^[A-Za-z_][A-Za-z0-9_.\-]{0,63}$`; no upper limit, and fields that don't fit next to the state in one 8,192-token pass are split across parallel passes |
| `images` | array ≤ 4 | data URL string or `{ content_type, base64 }`; PNG/JPEG/WebP; 4 MiB each, 8 MiB total decoded; body ≤ 16 MiB; remote URLs rejected |
| `reference_date` | string | ISO date that anchors dates written without a year |
| `options.include_quantiles` | bool (false) | adds 99 percentiles to estimates |
| `options.return_state_text` | bool (false) | returns the text that spans index into |

Field spec (`required: ["type"]`):

| Param | Applies to | Notes |
| --- | --- | --- |
| `type` | all | `text number date time datetime duration list estimate forecast` |
| `instructions` | all | "What the field should contain." |
| `unit` | number, duration, estimate | durations: seconds/minutes/hours/days/weeks/months/years (default seconds) |
| `integer` | number, duration | bool |
| `decimals` | number, duration, number lists | int 0–6 |
| `items` | list (**required**) | `text`, `number`, `date` |
| `min`, `max` | estimate, forecast (**required**) | number, or ISO date for date estimates |
| `step` | estimate | positive number (days for date estimates), or `"month"` / `"year"` |
| `scale` | estimate, forecast | `linear` (default) or `log` |
| `null_threshold` | scalar types | (0, 1], default 0.5: p_null above it → `value: null` |
| `horizon` | forecast | int 1–64 |
| `interval` | forecast | `step minute hour day week month quarter year` |

## Clairic response (`schema-output.json`)

Top level: `model`, `answers`, `truncated` (all required), `usage` (required), and
`state_text` (when requested). `usage` has `state_tokens`, `image_tokens`, `schema_tokens`,
`input_tokens`, `output_tokens`, and `passes`.

Each answer requires `type` and `value`. It may also have:
- scalars: `guess`, `p_null`, `confidence`, and `span: [start, end]` for text
- list: `spans: [[s, e], …]`, `confidence`
- estimate: `mean`, `median`, `p10`, `p90`, `p_below`, `p_above`, `quantiles`
- forecast: the blog shows parallel arrays (`value`, `median`, `p10`, `p90`, one entry per
  step), while the schema also describes `steps` ("one estimate per step"). **UNCONFIRMED**
  which one the live API returns, so the UI renders both.

Doc example (verbatim):

```json
{
  "model": "clairic",
  "answers": {
    "invoice_number": {"type": "text", "p_null": 3.8e-10, "span": [8, 16], "guess": "INV-2291", "confidence": 1, "value": "INV-2291"},
    "due_date": {"type": "date", "p_null": 1.9e-08, "guess": "2026-10-02", "confidence": 0.9999, "value": "2026-10-02"},
    "total": {"type": "number", "p_null": 2.3e-08, "guess": 1080, "confidence": 0.9999, "value": 1080},
    "contacts": {"type": "list", "value": ["Dana Ruiz", "Priya Shah"], "spans": [[120, 129], [131, 141]], "confidence": 0.9999},
    "po_number": {"type": "text", "p_null": 1, "span": [8, 16], "guess": "INV-2291", "confidence": 0.9995, "value": null},
    "days_to_pay": {"type": "estimate", "value": 30, "mean": 29.535, "median": 30, "p10": 21, "p90": 38, "p_below": 5.9e-06, "p_above": 1.2e-05}
  },
  "truncated": false,
  "usage": {"state_tokens": 61, "image_tokens": 0, "schema_tokens": 472, "input_tokens": 655, "output_tokens": 0, "passes": 3}
}
```

`po_number` comes back `null` with `p_null: 1`, while `guess` still shows the span the model
would have picked. Treat `guess` as a debugging aid, not an answer.

Guidance from the blog:
- One- and two-step arithmetic (totals, date math) is reliable. Longer chains and
  aggregating many table rows are not, so let code do the math.
- Estimates need evidence in the input (comparables, history).
- Forecasting is "basic", and the intervals can run narrow on unfamiliar data.
- Use `confidence`, `p_null`, and the intervals to decide what to automate.

## Clef / Clef Flash (decision models)

The request is the same System One decision schema as Jev (`model`, `state`, `questions`),
plus a Cloudflare extension `images` (same format as Clairic; 4 MiB and 16 MP each, 8 MiB
total, body ≤ 13 MiB). The adapter enforces these model-specific limits before calling:

- 1–64 questions per request; ids use letters, digits, `_ . -`, up to 100 characters
- `choice`: 2–255 options. `score`: 2–10 levels.
- `noul`, `choice`, `score` only (no `box`)

It does **not** check the 16 MP per-image cap or Clef's 13 MiB body cap, because the server
accepts bodies up to 16 MiB, Clairic's limit. Cloudflare rejects those itself.
- `state`: string, object, or array; long text state is truncated to fit

Response: `{ model, answers, usage: { input_tokens, output_tokens } }`. Here `choice`
requires `probabilities` and `confidence`, and `score` requires `legend`, `probabilities`,
and `confidence`, which is stricter than OpenRouter's schema.

Clef, Clef Flash, and Clef Omni are also listed on OpenRouter's decisions router
(`cloudflare/clef`, `cloudflare/clef-flash`, `cloudflare/clef-omni`), so the playground can
compare the same model served two ways.

## Not used (yet)

- A Workers AI model-search API exists, but it needs an account token, so the Cloudflare
  catalog is curated. Any other `@cf/...` id can be added as a custom model.
- The blog's three-step pipeline (Clairic → Clef → LLM) chains tasks. The playground runs one
  task at a time, though a Clairic result can be pasted into a Decide state as JSON.
