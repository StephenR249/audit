# PitchGym backend

The server-side piece of PitchGym's "Path B". It turns the deterministic
keyword engine in `index.html` into a real LLM-powered prospect, while keeping
your Anthropic API key off the client and putting hard limits on spend.

**One endpoint:** `POST /api/turn` — the browser sends who the prospect is plus
the conversation so far; the server calls Claude and returns the prospect's next
line.

```
Browser (index.html)  ──►  POST /api/turn  ──►  this server  ──►  Anthropic API
        ▲                                                              │
        └──────────────  prospect's reply (JSON)  ◄────────────────────┘
```

The API key lives only in the server's environment. The browser never sees it.

---

## Run it locally

```bash
cd server
cp .env.example .env         # then paste your ANTHROPIC_API_KEY into .env
npm install
npm start                    # http://localhost:3000
```

`npm start` also serves `index.html` at `/` (dev convenience), so you can open
`http://localhost:3000` and have both halves running from one process. Set
`SERVE_STATIC=false` once the frontend is hosted elsewhere.

Health check:

```bash
curl http://localhost:3000/api/health
# { "ok": true, "model": "claude-opus-5" }
```

---

## The `/api/turn` contract

**Request body**

```json
{
  "persona": {
    "name": "Dana Reyes",
    "role": "VP of Operations",
    "company": "Northwind Logistics",
    "personality": "blunt, time-poor, has been burned by vendors before"
  },
  "product": "an AI route-optimization platform for mid-market fleets",
  "stage": "objection",
  "messages": [
    { "role": "prospect", "text": "You've got two minutes. Go." },
    { "role": "rep", "text": "How are you planning routes today?" }
  ]
}
```

- `persona` — who the buyer is. All fields optional; sensible defaults fill gaps.
- `product` — what the rep is selling.
- `stage` — optional hint: `"opening"`, `"objection"`, or `"close"`.
- `messages` — the transcript. `role` is `"rep"` (the human) or `"prospect"`
  (the AI). The server maps rep→user and prospect→assistant.

**Response body**

```json
{ "reply": "Two minutes, and you're asking me to explain my job?", "refused": false }
```

`refused` is `true` on the rare occasion Claude's safety layer declines — the
server still returns an in-character deflection so the UI never breaks.

**Example**

```bash
curl -sX POST http://localhost:3000/api/turn \
  -H 'content-type: application/json' \
  -d '{
    "persona": { "name": "Dana", "role": "VP Ops", "personality": "blunt, skeptical" },
    "product": "AI route optimization",
    "stage": "objection",
    "messages": [{ "role": "rep", "text": "What does a bad route cost you today?" }]
  }'
```

---

## Wiring the frontend (drop into `index.html`)

The current app calls its local `detectResponse()` engine. To use the LLM
prospect instead, replace that with a call to this endpoint. Minimal client
helper:

```js
// Point this at your deployed backend (or leave "" if same-origin).
const API_BASE = "";

async function prospectReply({ persona, product, stage, messages }) {
  const res = await fetch(API_BASE + "/api/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ persona, product, stage, messages })
  });
  if (res.status === 429) throw new Error("rate_limited");
  if (!res.ok) throw new Error("server_error");
  const { reply } = await res.json();
  return reply;
}
```

Then, where a level starts, build `persona`/`product` from that level's
`SCENARIOS` entry, keep a running `messages` array as the rep and prospect
speak, and `await prospectReply(...)` for each prospect turn. Keep the existing
scoring engine as a *grader on top of* the free-form reply — that hybrid
(LLM voice + deterministic scoring) is a strength, not a thing to throw away.

---

## What's built in

- **Key stays server-side** — the browser never holds `ANTHROPIC_API_KEY`.
- **Per-IP rate limiting** — sliding-window requests/minute (`lib/rateLimit.js`).
- **Per-IP token budget** — rolling 30-day cap so one client can't run up the bill.
- **Refusal handling** — `stop_reason: "refusal"` is caught and softened.
- **History + payload caps** — bounded conversation resend and 256 KB body limit.
- **Persona prompt caching** — `cache_control` on the system prompt for cheaper
  multi-turn calls.

## Before you ship this to production

1. **Move rate limiting to Redis.** The in-memory limiter resets on restart and
   is per-process — it won't hold across multiple instances behind a load
   balancer. The logic in `lib/rateLimit.js` ports directly to a shared store.
2. **Add auth.** Right now anyone can call `/api/turn`. Gate it behind your
   login (JWT/session) so usage ties to a real user, and budget per user not per IP.
3. **Tighten CORS** to your real frontend origin via `CORS_ORIGIN`.
4. **Pin the SDK version.** `package.json` uses `"latest"` for convenience;
   pin an exact version for reproducible builds.
5. **Add observability** — log request IDs and token usage; wire Sentry for errors.
6. **Mind the model choice.** `claude-opus-5` is the default and the smartest;
   for high volume, evaluate `claude-sonnet-5` or `claude-haiku-4-5` on your own
   transcripts and set `PITCHGYM_MODEL` accordingly. Every call is real money —
   the token budget above is your backstop.
