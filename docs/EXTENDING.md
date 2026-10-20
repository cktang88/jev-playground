# Extending the playground

The playground is split along three seams. Each kind of change usually touches one file.

| You want to… | Touch |
| --- | --- |
| list a model a provider already speaks | that provider's curated list in `lib/providers/<provider>.mjs` |
| add a provider (a new API) | new `lib/providers/<id>.mjs`, register it in `lib/providers/index.mjs`, add its env vars to `lib/config.mjs` |
| add a question/field type to a task | the task module's `types`, `validate`, and mock (`lib/tasks/*.mjs`), plus a renderer in `public/js/renderers.mjs` |
| add a task (a new kind of model) | new `lib/tasks/<id>.mjs`, register it in `lib/tasks/index.mjs`, add presets in `public/js/presets.mjs` |

The UI is data-driven: the task tabs, model list, type pickers, and parameter editors all
come from `GET /api/catalog`. Only answer **renderers** are hand-written, and an unknown
answer type falls back to a JSON view, so new types are visible right away.

## The run pipeline (`lib/run.mjs`)

Every request goes through the same steps, whatever the provider:

1. resolve the **task** (`body.task`, default `decide`)
2. resolve the **target** (`body.target = "provider:model"`, or `provider` + `model`, or the task default)
3. find the model **descriptor** in the catalog, or build one with `provider.describeCustom()`
4. `task.validate(body)` → normalized input `{ state, items, images, options }`
5. check the descriptor's capabilities: task, `types`, `vision`, and `limits`
6. `provider.validate?(input, descriptor, task)` for provider-only rules
7. `provider.buildRequest(...)` → `{ url, headers, body }`
8. mock (synthesize answers) or `fetch` with a timeout → `provider.parseResponse(...)`
9. wrap the result in the standard envelope: cost estimate, upstream preview with secrets redacted

## Provider adapter interface

```js
export default {
  id: "acme",                      // used in targets: "acme:<model>"
  label: "Acme AI",
  tasks: ["decide"],               // tasks it can serve
  docs: "https://…",

  status(config) {                 // → { configured, missing: ["ACME_API_KEY"], hint }
  },
  curated() {                      // → [descriptor] always listed
  },
  async discover(config, fetch) {  // optional → [descriptor] from a live models API
  },
  describeCustom(model, taskId) {  // → descriptor for a hand-typed model id
  },
  validate(input, descriptor, task) { // optional → null | { message, hint }
  },
  buildRequest({ task, descriptor, input, config }) { // pure → { url, headers, body }
  },
  parseResponse({ status, json, text, descriptor, task }) {
    // → { model, answers, usage: { input_tokens, output_tokens, cost? }, meta }
    // throw upstreamError(status, message, hints) on failure
  },
};
```

A **descriptor** looks like this:

```js
{
  id: "acme:acme/decider-2", provider: "acme", model: "acme/decider-2", label: "Acme Decider 2",
  task: "decide", types: ["noul", "choice", "score"], vision: false,
  context_length: 32768, pricing: { input_per_mtok: 0.05 },
  limits: { max_items: 32, choice_options: [2, 50], score_levels: [2, 10], max_images: 0 },
  notes: "shown under the name", source: "curated" | "live" | "custom",
}
```

Keep `buildRequest` and `parseResponse` pure. Then they can be unit-tested with a fake
`fetch`, as in `test/runner.test.mjs`. Add one test for the wire format and one for the error
envelope.

Things to watch for:
- **Where answers live.** Cloudflare wraps them in `result`; OpenRouter returns them at the top level.
- **The state type.** Extraction models want a string (`stateToText` in `lib/tasks/extract.mjs`).
- **The image format.** OpenRouter uses TypeSafe-style `assets` + reference strings,
  Cloudflare uses data URLs. Images reach the adapter already parsed as
  `{ mime, base64, bytes, dataUrl }`.
- **Cost.** If the API doesn't return it, set `pricing.input_per_mtok` and the pipeline
  estimates it.

## Task module interface

```js
export default {
  id: "extract", label: "Extract", summary: "…",
  itemsKey: "fields",        // request key holding the typed items
  itemNoun: "field",
  types: {                   // published to the UI
    number: { label, summary, params: [{ key: "decimals", label: "Decimals", kind: "int", min: 0, max: 6 }] },
    // decide-style types use `criteria: { kind: "pair" | "map" | "list" | "none", min? }` instead of params
  },
  options: [{ key, label, kind: "bool" | "date" | "text", help }], // request-level options, optional
  validate(body) { },        // throws badRequest(...); returns { state, items, images, options }
  mockAnswers(input) { },    // answers in the real shapes, for mock mode
  mockMeta(input) { },       // optional
};
```

Parameter `kind`s the editor understands: `text`, `int`, `number`, `bool`, `enum`
(with `options`), `number_or_date`, and `step` (number, `month`, or `year`).

## Example: adding a type

Say a provider adds an `email` extraction type:

1. `lib/tasks/extract.mjs`: add `email: { label: "Email", summary: "…", params: [nullThreshold] }`
   to `types`, and a `case "email"` in `mockField`.
2. `lib/providers/cloudflare.mjs`: add `"email"` to `EXTRACT_TYPES`, so Clairic is allowed to receive it.
3. `public/js/renderers.mjs`: map `email: renderScalar` (or write a renderer).
4. Add a smoke-test assertion.
