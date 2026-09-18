# Jev Playground — Interface Contract (v1)

Single source of truth. Backend and frontend must both match this exactly.

## What Jev is
Jev is TypeSafe's "System One" model. It does **not** generate text. You send a
`state` plus typed `questions`; it returns calibrated probabilities.

## Upstream API (backend calls this)
```
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer $OPENROUTER_API_KEY
Content-Type: application/json

{
  "model": "~typesafe/jev-latest",
  "state": <string | object | array>,
  "questions": {
    "<id>": { "type": "noul"|"choice"|"score", "instructions": <string>, "criteria": ... }
  }
}
```

Question types:
- `noul`   -> criteria: `{ "true": "<what yes means>", "false": "<what no means>" }` (optional)
- `choice` -> criteria: `{ "<option>": "<description or null>", ... }` (required, >=2)
- `score`  -> criteria: `[ "<level 0>", "<level 1>", ... ]` (required, >=2, ordered)

Upstream response:
```json
{
  "model": "...", "provider": "...", "id": "...",
  "answers": {
    "<id>": { "type": "noul",   "noul": 0.92 },
    "<id>": { "type": "choice", "choice": "billing", "probabilities": {"billing":0.84,"x":0.16}, "confidence": 0.6 },
    "<id>": { "type": "score",  "score": 1.035, "legend": {"0":"a","1":"b"}, "probabilities": {"0":0.1,"1":0.9}, "confidence": 0.84 }
  },
  "usage": { "input_tokens": 312, "output_tokens": 48, "cost": 0.0012 }
}
```

## Our HTTP API

### `GET /` and static
Serves files from `public/`. `index.html` is the playground.

### `POST /api/decide`
Request body:
```json
{
  "state": <string | object | array>,   // required
  "questions": { "<id>": <Question> },  // required, at least 1
  "model": "~typesafe/jev-latest"       // optional; server default applies
}
```

Success -> HTTP 200:
```json
{
  "ok": true,
  "model": "~typesafe/jev-latest",
  "answers": { "<id>": <Answer> },
  "usage": { "input_tokens": 0, "output_tokens": 0, "cost": 0 },
  "latency_ms": 412,
  "mock": false
}
```

Failure -> HTTP 4xx/5xx, always this envelope:
```json
{
  "ok": false,
  "error": "Human-readable message",
  "status": 401,
  "hint": "Optional actionable next step",
  "details": {}
}
```

Rules:
- Never leak the API key to the client. Backend only.
- Validate before calling upstream: `state` present, `questions` non-empty,
  each question has a valid `type` and required `criteria`. Bad input -> 400.
- Map upstream 401/402/403/429/529 to the same status with a helpful `hint`.
- Timeout upstream at 60s.
- Mock mode: if env `JEV_MOCK=1`, skip upstream and synthesize plausible
  answers matching the shapes above, with `"mock": true`.

## Config (env)
- `OPENROUTER_API_KEY` (required unless JEV_MOCK=1)
- `JEV_MODEL` (default `~typesafe/jev-latest`)
- `JEV_MOCK` (optional)
- `PORT` (default 4321)

## Frontend requirements
- `state` textarea + question builder supporting all 3 types.
- Render results: noul as a 0-100% gauge, choice as a probability bar list
  with the winner highlighted, score as the value + per-level bars.
- Show `confidence` when present, plus `latency_ms`, tokens, cost.
- Show request JSON and raw response (collapsible) for learning.
- Surface `error`/`hint` clearly on failure.
- No build step, no dependencies: plain HTML/CSS/JS in `public/`.
