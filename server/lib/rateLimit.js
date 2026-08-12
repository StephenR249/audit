// ============================================================
//  Rate limiting + token budget (in-memory).
//
//  Two layers of protection so a single client can't run up a
//  surprise Anthropic bill:
//    1. Requests-per-minute per IP (sliding window)
//    2. Rolling 30-day token budget per IP
//
//  IN-MEMORY ONLY: this resets on restart and is per-process, so
//  it does not hold across multiple instances. For real production
//  behind a load balancer, back this with Redis (same logic, shared
//  store). It is deliberately dependency-free here to show the shape.
// ============================================================

const WINDOW_MS = 60_000;
const MAX_REQ_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 20);
const MONTHLY_TOKEN_BUDGET = Number(process.env.MONTHLY_TOKEN_BUDGET_PER_IP || 200_000);
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

const hits = new Map(); // ip -> number[] (recent request timestamps)
const budgets = new Map(); // ip -> { tokens, resetAt }

// Behind a proxy (Render/Railway/Vercel/nginx) the real IP is in the first
// hop of X-Forwarded-For. app.set('trust proxy', 1) makes req.ip honor it.
export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// The bucket key: a logged-in user when we have one (so budget follows the user
// across IPs), else the IP (for public routes like session-minting). requireAuth
// runs before this middleware on protected routes and sets req.userId.
export function rateKey(req) {
  return req.userId ? 'u:' + req.userId : 'ip:' + clientIp(req);
}

// Express middleware. Rejects with 429 when either limit is exceeded.
export function rateLimit(req, res, next) {
  const key = rateKey(req);
  req.rateKey = key;
  const now = Date.now();

  // 1) Sliding-window request rate
  const recent = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_REQ_PER_MIN) {
    res.set('Retry-After', '60');
    return res
      .status(429)
      .json({ error: 'rate_limited', message: 'Too many requests — slow down a moment.' });
  }
  recent.push(now);
  hits.set(key, recent);

  // 2) Rolling token budget
  const b = budgets.get(key);
  if (b && now < b.resetAt && b.tokens >= MONTHLY_TOKEN_BUDGET) {
    res.set('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
    return res
      .status(429)
      .json({ error: 'budget_exceeded', message: 'Monthly usage cap reached for this account.' });
  }

  next();
}

// Call after a successful Claude turn to charge the account's budget.
// `key` is req.rateKey (set by the rateLimit middleware).
export function recordUsage(key, usage) {
  const now = Date.now();
  const tokens = (usage?.input_tokens || 0) + (usage?.output_tokens || 0);
  let b = budgets.get(key);
  if (!b || now >= b.resetAt) b = { tokens: 0, resetAt: now + MONTH_MS };
  b.tokens += tokens;
  budgets.set(key, b);
}

// Periodically drop stale entries so the maps don't grow unbounded.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const live = arr.filter((t) => now - t < WINDOW_MS);
    if (live.length) hits.set(ip, live);
    else hits.delete(ip);
  }
  for (const [ip, b] of budgets) {
    if (now >= b.resetAt) budgets.delete(ip);
  }
}, WINDOW_MS);
sweep.unref?.(); // don't keep the process alive just for the sweep
