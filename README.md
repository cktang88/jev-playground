# System One Playground

A small, dependency-free playground for **System One models**: fast, single-pass models
that never write prose. You hand them some **state** (a ticket, an email, a JSON record,
an image) plus a set of **typed questions or fields**. They answer with calibrated numbers
your code can act on directly.

It started as a playground for TypeSafe's **Jev**. It now runs any System One model from
any provider, and runs the same request against several models side by side:

| Task | Asks | Models (out of the box) |
| --- | --- | --- |
| **Decide** | typed questions, answered with calibrated probabilities | Every OpenRouter decisions model (Jev 1.13/1.14, **OpenAI GPT-6 Luna Decisions**, Cloudflare Clef / Clef Flash / Clef Omni, Perplexity Decider, Liquid, Mercury, …), plus **Cloudflare Clef** and **Clef Flash** on Workers AI |
| **Extract** | typed fields, answered with typed values, spans, null probabilities and intervals | **Cloudflare Clairic** on Workers AI |

The OpenRouter list is discovered live from OpenRouter's public models API, so new
decisions models show up without a code change. Any other model id can be typed in by hand.

## Question and field types

**Decide** (`questions`): the System One decision schema, shared by Jev, Clef, Luna and others.

| Type | Asks | You get back |
| --- | --- | --- |
| `noul` | a yes/no question | probability from 0 to 1 that the answer is yes |
| `choice` | pick one from a fixed list | the winning option, a probability per option, confidence |
| `score` | rate against ordered levels | a probability-weighted score, a probability per level, confidence |
| `box` | find something in an image (experimental, Jev 1.14; see the image caveat below) | four edges as fractions of the image, confidence |

**Extract** (`fields`): the System One extraction schema, from Cloudflare's Clairic.

| Type | Parameters | You get back |
| --- | --- | --- |
| `text` | — | a verbatim span of the input, with `[start, end]` offsets |
| `number` | `unit`, `decimals`, `integer` | a number read from or computed from the input |
| `date` / `time` / `datetime` | — | ISO values, read or computed (e.g. issue date + net 30) |
| `duration` | `unit` (seconds…years), `integer`, `decimals` | a length of time |
| `list` | `items` (`text` / `number` / `date`), `decimals` | every match in input order, with spans |
| `estimate` | `min`, `max`, `step`, `scale` (`linear`/`log`), `unit` | median, mean, 80% interval (`p10`–`p90`), `p_below`/`p_above` |
| `forecast` | `horizon` (1–64), `interval`, `min`, `max`, `scale`, `unit` | one median + 80% interval per future step |

`text`, `number`, `date`, `time`, `datetime` and `duration` also take `null_threshold` (0–1].
Each type accepts only its own parameters plus `instructions`; anything else is rejected.

Every scalar extraction answer also carries `p_null` (the probability that the value is not
in the input) and `confidence`. When `p_null` crosses `null_threshold` (default 0.5), the
value is `null`, and `guess` shows what the model would otherwise have picked.

## Run it

No install step and no build step. Node 20+ is all you need.

```bash
# 1. Instant offline demo: no keys, synthesized answers for every model and type
npm run mock            # or: PLAYGROUND_MOCK=1 node server.mjs
# open http://localhost:4321

# 2. Real answers. Set whichever providers you have.
export OPENROUTER_API_KEY=sk-or-v1-...        # all OpenRouter decisions models
export CLOUDFLARE_ACCOUNT_ID=...              # Clairic, Clef, Clef Flash on Workers AI
export CLOUDFLARE_API_TOKEN=...
npm start               # or: node server.mjs
```

- OpenRouter key: https://openrouter.ai/settings/keys
- Cloudflare: open dash.cloudflare.com, go to AI → Workers AI → *Use REST API*, and create a token with Workers AI permissions.

You don't need keys for every provider. Models whose provider has no key are still listed,
and you can run them by ticking **Mock**.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | — | OpenRouter decisions |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | — | Workers AI (`CLOUDFLARE_AUTH_TOKEN` also accepted) |
| `PLAYGROUND_MOCK` | off | `1` = every run is mocked (`JEV_MOCK=1` still works) |
| `DEFAULT_DECIDE_TARGET` | `openrouter:typesafe/jev-1.14` | model preselected for Decide (`JEV_MODEL` / `OPENROUTER_DECISIONS_MODEL` set just the OpenRouter model) |
| `DEFAULT_EXTRACT_TARGET` | `cloudflare:@cf/cloudflare/clairic` | model preselected for Extract |
| `OPENROUTER_DISCOVER` | on | `0` = skip live model discovery, use the curated list |
| `UPSTREAM_TIMEOUT_MS` | `60000` | per-request upstream timeout |
| `PORT`, `HOST` | `4321`, `127.0.0.1` | where the server listens |
| `ALLOWED_HOSTS` | — | extra comma-separated `Host` names the API accepts besides localhost and `HOST` (`*` = any) |
| `OPENROUTER_BASE_URL`, `CLOUDFLARE_API_BASE` | `https://openrouter.ai`, `https://api.cloudflare.com/client/v4` | upstream base URLs (e.g. for a gateway) |
| `OPENROUTER_REFERER`, `OPENROUTER_TITLE` | `http://localhost`, `System One Playground` | OpenRouter attribution headers |

The API only answers requests that a page on the playground could have sent: a localhost
(or allowed) `Host`, a same-origin `Origin` when a browser sends one, and
`Content-Type: application/json` on POSTs. Other web pages can't spend your keys.

## Using the playground

1. **Task & models.** Pick *Decide* or *Extract*, then tick one or more models. If you
   tick several, one click runs them all in parallel. Each card then shows every model's
   answer to the same question, with an *agree / disagree* line on top. The run table
   compares latency, input tokens, and cost (marked `est.` when computed from list price).
2. **State.** Paste text or JSON, or start from a preset. Attach up to four images (drop,
   paste, or pick a file) for vision models and `box` questions. Workers AI documents its
   image format. OpenRouter's decisions schema has no image field, so the playground sends
   TypeSafe's `assets` format, and whether OpenRouter forwards it is **unconfirmed**. If
   images seem ignored on OpenRouter, that is why.
3. **Questions / fields.** The editors come from the type specs the server publishes, so
   every parameter above has a control.
4. **Raw.** Each model's exact upstream request (with the key and image bytes redacted) and
   its response, plus a *Copy as curl* button so you can replay the call directly.

Things to try:

- Run the support ticket against Jev 1.14, GPT-6 Luna and Clef Flash together, and see
  where they disagree. Flip a `noul` question to its opposite and watch every probability move.
- Add a `choice` whose options are genuinely close. **Confidence** drops even when one option
  wins: probability is *what*, confidence is *how sure*.
- Run the *Damage claim email* preset on Clairic. `tracking_number` comes back `null` with a
  high `p_null` instead of a plausible-looking invention, and `repair_cost` returns an
  interval, not a point guess.
- Run *Forecast a series* and read the fan chart: one 80% interval per day.

## How it works

```
browser ──POST /api/run {task, target, state, questions|fields}──▶ server.mjs
                                                                     │  validate (task) → check limits (model)
                                                                     │  → provider adapter builds the wire request
                                       ┌─────────────────────────────┴─────────────────────────────┐
                    openrouter.ai/api/alpha/decisions            api.cloudflare.com/…/ai/run/@cf/cloudflare/*
```

The browser never sees a key. The server validates the request once, checks it against the
chosen model's limits (supported types, image support, Clef's 64-question and 10-level caps,
…), translates it into the provider's wire format, and returns one normalized envelope, so
the UI renders every provider the same way.

## Files

```
server.mjs                 routes: static files, /api/health, /api/catalog, /api/run (+ /api/decide, /api/extract)
lib/config.mjs             environment → config
lib/run.mjs                the run pipeline shared by every provider
lib/catalog.mjs            curated models + live discovery, cached
lib/tasks/                 one module per task: types (with UI specs), validation, mock answers
lib/providers/             one adapter per provider: status, models, buildRequest, parseResponse
public/index.html          markup; styles in public/styles.css
public/js/                 ES modules: app (wiring), models, editors, renderers, results, presets
test/runner.test.mjs       unit tests for adapters and the pipeline (fetch faked)
smoke-test.mjs             end-to-end test against a mock-mode server
docs/CONTRACT.md           the HTTP interface, exactly
docs/EXTENDING.md          how to add a provider, a model, a task, or a type
docs/OPENROUTER_NOTES.md   research notes: OpenRouter decisions API
docs/CLOUDFLARE_NOTES.md   research notes: Workers AI Clairic and Clef
```

## Tests

```bash
npm test     # unit tests, then the end-to-end smoke test (offline, mock mode)
```

## API in one example

```bash
curl localhost:4321/api/run -H 'Content-Type: application/json' -d '{
  "task": "extract",
  "target": "cloudflare:@cf/cloudflare/clairic",
  "state": "Invoice INV-2291, issued 2026-09-02, net 30. 4 pallets at $250.00 each, shipping $80.00.",
  "fields": {
    "invoice_number": { "type": "text" },
    "due_date": { "type": "date", "instructions": "Issue date plus the net payment days" },
    "total": { "type": "number", "decimals": 2, "unit": "USD" }
  }
}'
```

Returns `{ ok, task, target, provider, model, answers, usage, meta, latency_ms, mock, upstream }`.
Failures return `{ ok: false, error, status, hint, target }`. See [docs/CONTRACT.md](docs/CONTRACT.md).
