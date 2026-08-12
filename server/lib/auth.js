// ============================================================
//  Auth gate — stateless HMAC-signed session tokens.
//
//  /api/turn now requires `Authorization: Bearer <token>`. The
//  server mints tokens at /api/auth/session and verifies them on
//  every call, so rate limiting and the token budget bind to a
//  USER (the token's `sub`) instead of a shared IP.
//
//  HONEST SCOPE: this binds identity, it does not yet *verify* it.
//  A client can mint an anonymous device session freely (unless you
//  set SIGNUP_CODE). This is the production SHAPE — signed sessions,
//  bearer auth, per-user budget — with a drop-in slot for real login:
//  replace issueSession() with your OAuth / magic-link callback and
//  keep everything else. No DB required; the token is the session.
//
//  Tokens are JWT-shaped (HS256) but hand-rolled on node:crypto to
//  stay dependency-free and show the mechanism.
// ============================================================
import crypto from 'node:crypto';

const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);
// Optional gate: if set, minting a session requires this code. Leave unset for
// open (anonymous device) signup during development.
const SIGNUP_CODE = process.env.SIGNUP_CODE || '';

// Signing secret. Set AUTH_SECRET in production so tokens survive restarts and
// can't be forged. If unset we generate an ephemeral one and warn — dev only.
const AUTH_SECRET =
  process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.AUTH_SECRET) {
  console.warn(
    '  ⚠  AUTH_SECRET is not set — using an ephemeral secret. Sessions reset on restart. Set AUTH_SECRET in production.'
  );
}

const b64url = (input) => Buffer.from(input).toString('base64url');

function sign(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

// Returns the decoded payload, or null if the token is malformed, tampered, or expired.
function verify(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const data = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('base64url');
  const got = Buffer.from(parts[2]);
  const want = Buffer.from(expected);
  // Constant-time compare; length check first (timingSafeEqual throws on mismatch).
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}

// POST /api/auth/session — mint a session token.
// Body: { deviceId?, email?, signupCode? }
//   - email  -> identity is email:<addr> (NOT verified yet; wire real login here)
//   - deviceId -> stable anonymous identity device:<id> (client persists it)
//   - neither -> a fresh random device identity
export function issueSession(req, res) {
  const { email, deviceId, signupCode } = req.body || {};

  if (SIGNUP_CODE && signupCode !== SIGNUP_CODE) {
    return res
      .status(403)
      .json({ error: 'signup_closed', message: 'A valid signup code is required.' });
  }

  let sub;
  if (email && typeof email === 'string') {
    sub = 'email:' + email.slice(0, 160).toLowerCase().trim();
  } else if (deviceId && typeof deviceId === 'string') {
    sub = 'device:' + deviceId.replace(/[^\w-]/g, '').slice(0, 64);
  } else {
    sub = 'device:' + crypto.randomUUID();
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = now + SESSION_TTL_DAYS * 24 * 60 * 60;
  const token = sign({ sub, email: email || null, iat: now, exp });

  res.json({ token, sub, expiresAt: exp });
}

// Express middleware: require a valid bearer token, expose req.userId.
export function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const payload = match && verify(match[1]);
  if (!payload) {
    return res
      .status(401)
      .json({ error: 'unauthorized', message: 'A valid session is required.' });
  }
  req.userId = payload.sub;
  req.userEmail = payload.email || null;
  next();
}
