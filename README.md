# Jev Playground

A small, dependency-free playground for **Jev** — TypeSafe's "System One" model.

Jev is not a chatbot. It does not write text. You hand it some **state** (a support
ticket, a review, a JSON record) plus a set of **typed questions**, and it answers with
**calibrated probabilities** your code can act on directly.

## The three question types

| Type | Asks | You get back |
| --- | --- | --- |
| `noul` | a yes/no question | probability from 0 to 1 that the answer is yes |
| `choice` | pick one from a fixed list | the winning option, a probability per option, confidence |
| `score` | rate against ordered levels | a weighted score, a probability per level, confidence |

Ask as many as you like in one call — they run in parallel and share one request.

## Run it

No install step, no build step. Node 20+ is all you need.

```bash
# 1. Instant offline demo — no API key, synthesized answers
JEV_MOCK=1 node server.mjs
# open http://localhost:4321

# 2. Real answers from Jev
export OPENROUTER_API_KEY=sk-or-v1-...
node server.mjs
```

Get a key at https://openrouter.ai/settings/keys, then open http://localhost:4321.

Optional environment variables:

- `OPENROUTER_API_KEY` — required for real answers (not needed when `JEV_MOCK=1`)
- `JEV_MODEL` — defaults to `~typesafe/jev-latest`
- `JEV_MOCK` — set to `1` to skip the network and return sample answers
- `PORT` — defaults to `4321`

## Try these

The page ships with a sample ticket and one question of each type. Press **Ask Jev**.
Then try:

- Flip a `noul` question to its opposite ("Is this customer calm?") and watch the
  probability move. That is the whole idea — it is a probability, not a coin flip.
- Add a `choice` question with options that are genuinely close, and notice that
  **confidence** drops even when one option wins. Probability is *what*; confidence is
  *how sure*. Route the low-confidence ones to a human.
- Put a long, messy state in the box and add five or six speculative questions at once.
  Adding questions barely changes latency, so it is cheap to ask everything your code
  might need and ignore the answers it does not.

## How it works

```
browser  ──POST /api/decide──▶  server.mjs  ──POST openrouter.ai/api/alpha/decisions──▶  Jev
   ▲                                │
   └──────── answers ───────────────┘
```

The browser never sees the API key. `server.mjs` validates the request, forwards it,
and returns a normalized envelope so the UI can render every answer type the same way.

## Files

- `public/index.html` — the whole playground: markup, styles, and logic in one file
- `server.mjs` — static file server plus the `/api/decide` proxy
- `CONTRACT.md` — the exact HTTP interface between the two
- `API_NOTES.md` — research notes on the OpenRouter decisions endpoint

## API

`POST /api/decide`

```json
{
  "state": "My checkout page shows a blank screen after I click Pay.",
  "questions": {
    "is_bug": { "type": "noul", "instructions": "Is the customer reporting a defect?" },
    "team": {
      "type": "choice",
      "instructions": "Which team should own this?",
      "criteria": { "frontend": "Rendering or layout", "payments": "Checkout or billing" }
    },
    "urgency": {
      "type": "score",
      "instructions": "How urgent is this?",
      "criteria": ["Can wait", "This week", "Blocking revenue"]
    }
  }
}
```

Returns `{ ok, model, answers, usage, latency_ms, mock }`. Failures return
`{ ok: false, error, status, hint }`.

`GET /api/health` returns `{ ok, model, mock, key_present }`.
