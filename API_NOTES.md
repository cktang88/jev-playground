# API notes — calling Jev through OpenRouter (evidence)
Public docs/API only, fetched 2026-09-18. No authenticated calls were made.

## TL;DR for the demo
**Send `"model": "typesafe/jev-1.13"`.**

- `typesafe/jev-latest` → **404** (verified on the live models API). Do not use it.
- `~typesafe/jev-latest` → resolves, but `"endpoints":[]` — a metadata row with nothing to route to.
- `typesafe/jev-1.13` → real endpoint `typesafe/jev-1.13-20260917`, `context_length: 32000`,
  `pricing.prompt: 0.000000042` ($42/Mtok), `pricing.completion: 0`.
- Every OpenRouter SDK example for this endpoint literally uses `typesafe/jev-1.13`.

The 3 things most likely to break:

1. **Wrong model string.** The URL/docs say `~typesafe/jev-latest`; the endpoint needs
   `typesafe/jev-1.13`. A bad slug is a 404, which looks like a code bug.
2. **`noul` has no confidence.** `DecisionsNoulAnswer` = `type` + `noul` only. Treat confidence as
   optional / `choice`+`score`-only.
3. **Alpha path + auth + cost.** Route is `POST /api/alpha/decisions` (no `/v1`); unauthenticated
   returns `401 {"error":{"message":"No cookie auth credentials found"}}`; `usage.cost` is optional.

## 1. Exact `model` string — CONFIRMED
https://openrouter.ai/docs/client-sdks/python/sdks/decisions/README.md
> `res = open_router.alpha.decisions.create(model="typesafe/jev-1.13", questions={...`

Same literal in the TS README (`model: "typesafe/jev-1.13",`) and Go README (`Model: "typesafe/jev-1.13",`):
https://openrouter.ai/docs/client-sdks/typescript/sdks/decisions/README.md ,
https://openrouter.ai/docs/client-sdks/go/sdks/decisions/README.md

Live `GET /api/v1/models/{id}/endpoints`:
- `typesafe/jev-1.13` → `{"name":"TypeSafe: Jev 1.13", ... "modality":"text->decisions"}`, 1 endpoint.
- `typesafe/jev-latest` → `{"error":{"message":"Not Found","code":404}}` — **invalid**.
- `~typesafe/jev-latest` → `"This model always redirects to the latest model in the Jev family."`,
  `"endpoints":[]` — **no endpoints**. `typesafe/jev-1.13.0` (TypeSafe's versioned ID) → 404 here.

**`~` alias scope:** https://openrouter.ai/docs/guides/routing/routers/latest-resolution.md
> "`~author/family-latest` slugs always resolve to the newest concrete model in a given family"

Whether the **decisions** router honors `~` at request time is **UNCONFIRMED** — that doc is written
around chat completions ("Send a chat completion request with a `~author/family-latest` slug") and no
SDK example uses `~` for decisions. With an empty endpoint list, treat `~` as unsafe here.

## 2. Response schema — CONFIRMED
https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request.md
(OpenAPI spec embedded in that page, `components.schemas.DecisionsResponse`)
```yaml
answers:  {additionalProperties: {oneOf: [DecisionsNoulAnswer, DecisionsChoiceAnswer, DecisionsScoreAnswer]}, type: object}
id:       {type: string}        # present but NOT required
model:    {type: string}        # required
provider: {type: string}        # present but NOT required
usage:
  properties:
    cost:          {format: double, type: number}   # OPTIONAL
    input_tokens:  {type: integer}                  # required
    output_tokens: {type: integer}                  # required
  required: [input_tokens, output_tokens]
required: [model, answers, usage]
```
`id`/`provider` may be absent; `usage.cost` is optional → always default it. Response `model` reports
the concrete model that served the request.

## 3. Errors and retryability — PARTLY CONFIRMED
Statuses for `POST /api/alpha/decisions` (same page), doc wording verbatim:
`400` "Bad Request - Invalid request parameters or malformed input" · `401` "Unauthorized -
Authentication required or invalid credentials" · `402` "Payment Required - Insufficient credits or
quota to complete request" · `403` "Forbidden - Authentication successful but insufficient
permissions" · `404` "Not Found - Resource does not exist" · `413` "Payload Too Large - Request
payload exceeds size limits" · `429` "Too Many Requests - Rate limit exceeded" · `500` "Internal
Server Error - Unexpected server error" · `502` "Bad Gateway - Provider/upstream API failure" ·
`503` "Service Unavailable - Service temporarily unavailable" · `524` "Infrastructure Timeout -
Provider request timed out at edge network" · `529` "Provider Overloaded - Provider is temporarily
overloaded".

Retry: **429, 502, 503, 524, 529** with backoff; **402** only when a `Retry-After` header is present;
never 400/401/403/404/413; 500 undocumented.

Error body (spec example): `{ "error": { "code": 429, "message": "Rate limit exceeded" } }`

Retry basis, https://openrouter.ai/docs/api_reference/errors-and-debugging.md:
> "On 429 and 503 responses, and on 402 responses whose `error.metadata.limit_source` is
> `openrouter_in_flight_budget` ... OpenRouter may include a standard HTTP `Retry-After` response header"

The spec publishes no per-status retry table, so "Retry?" above is inference from those general error
docs — per-status retryability *for decisions specifically* is **UNCONFIRMED**.

## 4. Limits — PARTLY CONFIRMED
No decisions-specific limits are published by OpenRouter. What exists:

- TypeSafe, https://docs.typesafe.ai/models.md: "Rate limits | 250,000 tokens per second / 1,200
  requests per minute"; "Context length | 64k tokens per request; 32k tokens for `state` plus the
  longest question".
- Live endpoint metadata for `typesafe/jev-1.13`: `"context_length": 32000`,
  `"max_completion_tokens": 28800`, `"max_prompt_tokens": null`.
- TypeSafe on batching questions, https://docs.typesafe.ai/patterns/fan-out.md: "Because TypeSafe
  supports sending many questions in a single API call, we recommend putting all of the questions your
  system needs in a single request ... All questions are evaluated in parallel" → **no documented max
  questions per request**.
- OpenRouter limits are account-level, not per-endpoint: https://openrouter.ai/docs/api_reference/limits.md
  (credit limits → 402, rate limits → 429, `X-RateLimit-*` headers).
- **Alpha gating: UNCONFIRMED.** The tag is literally `alpha.decisions` ("Alpha feature endpoints for
  Decisions (questions and answers) requests"), but no page states an account flag or allowlist is
  required, and no state character budget is documented beyond the token limits above.

## 5. Per-answer confidence — CONFIRMED
From the same `components.schemas` block:
```yaml
DecisionsChoiceAnswer: required: [type, choice]
  properties: {choice: string, confidence: number, probabilities: object, type: [choice]}
DecisionsNoulAnswer:   required: [type, noul]
  properties: {noul: number, type: [noul]}          # NO confidence
DecisionsScoreAnswer:  required: [type, score]
  properties: {confidence: number, legend: object, probabilities: object, score: number, type: [score]}
```
`noul` carries **only** `type` + `noul` — no `confidence`. Matches TypeSafe,
https://docs.typesafe.ai/primitives.md:
> "Noul | `noul` | ... Noul has no separate `confidence`."

Only headline fields are required: on `choice`, `probabilities`/`confidence` are optional; on `score`,
`probabilities`/`confidence`/`legend` are optional. Render defensively.

## 6. `state` shapes — CONFIRMED
`DecisionsRequest.state` in the decisions API-reference page:
```yaml
state:
  anyOf: [{type: string}, {additionalProperties: {}, type: object}, {items: {}, type: array}]
  description: "The content to evaluate: a plain string, or a JSON object or array of related context."
```
Guidance, https://docs.typesafe.ai/concepts/state.md: use an object "for most requests so each part of
the state has a descriptive name and its relationships remain clear"; "Jev accepts text only. State
must be a string, JSON object, or array of text values."

## 7. Headers — CONFIRMED
- Auth: `Authorization: Bearer <key>` (spec defines `apiKey` as `bearer` in `Authorization`).
- `HTTP-Referer` / `X-Title` (SDK `http_referer` / `x_open_router_title`): **optional**, minus-sign in
  the Python param table — "the primary identifier for rankings."
- `x-session-id`: optional. Spec `session_id` description: "If provided in both the request body and
  the x-session-id header, the body value takes precedence. Maximum of 256 characters."
- `x_open_router_categories`: optional, marketplace rankings only. Only the bearer token is required.

## Extra: endpoint path and request shape (verified)
- `POST https://openrouter.ai/api/alpha/decisions` exists (unauthenticated → `401 {"error":{"message":
  "No cookie auth credentials found","code":401}}`); `POST /api/v1/alpha/decisions` → `404`. The OpenAPI
  `servers` block says `https://openrouter.ai/api/v1`, but the real route omits `/v1`.
- Required request fields: `model`, `state`, `questions`; optional: `provider`, `session_id`, `trace`, `user`.
- `DecisionsScoreQuestion.criteria` has `minItems: 1`; TypeSafe docs use >= 2 ordered levels.
- `DecisionsNoulQuestion` requires `type` + `instructions`; when `criteria` is present it requires
  both `true` and `false`.
