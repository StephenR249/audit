// ============================================================
//  PitchGym backend — Express app.
//
//  Exposes POST /api/turn: the browser sends the persona + the
//  conversation so far, the server calls Claude with the secret
//  key, and returns the prospect's next line. The API key never
//  reaches the client.
//
//  Run:  cp .env.example .env  (add your key)  →  npm install  →  npm start
// ============================================================
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTurn } from './lib/claude.js';
import { rateLimit, recordUsage } from './lib/rateLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const app = express();

// Trust the first proxy hop so req.ip reflects the real client on
// Render/Railway/Vercel/nginx (needed for correct per-IP rate limiting).
app.set('trust proxy', 1);

app.use(express.json({ limit: '256kb' }));

// If you host the frontend on a different origin, set CORS_ORIGIN to it
// (e.g. https://pitchgym.io). Left blank => reflect the request origin,
// which is fine for local dev but tighten it for production.
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));

// --- Health check -------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: process.env.PITCHGYM_MODEL || 'claude-opus-5' });
});

// --- The one real endpoint ----------------------------------
// Body: { persona:{name,role,company,personality}, product:string,
//         stage?:'opening'|'objection'|'close',
//         messages:[{role:'rep'|'prospect', text:string}] }
// Reply: { reply:string, refused:boolean }
app.post('/api/turn', rateLimit, async (req, res) => {
  const { persona, product, stage, messages } = req.body || {};

  if (!Array.isArray(messages)) {
    return res
      .status(400)
      .json({ error: 'bad_request', message: '`messages` must be an array.' });
  }

  try {
    const result = await runTurn({ persona, product, stage, messages });
    recordUsage(req.clientIp, result.usage);
    res.json({ reply: result.reply, refused: !!result.refused });
  } catch (err) {
    // Anthropic SDK errors carry a numeric `status`. Surface 429 as 429 so the
    // client can back off; everything else is a generic 500 (don't leak internals).
    const status = err?.status;
    if (status === 429) {
      res.set('Retry-After', '30');
      return res
        .status(429)
        .json({ error: 'upstream_busy', message: 'Busy right now — try again shortly.' });
    }
    console.error('[/api/turn] error:', err?.message || err);
    res
      .status(500)
      .json({ error: 'server_error', message: 'Could not generate a reply. Please retry.' });
  }
});

// --- Optional: serve the app for one-command local dev -------
// Serves ONLY index.html at "/", never the repo root (which would expose
// server/.env). Set SERVE_STATIC=false when the frontend is hosted elsewhere.
if (process.env.SERVE_STATIC !== 'false') {
  app.get('/', (_req, res) => res.sendFile(path.join(REPO_ROOT, 'index.html')));
}

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`PitchGym backend listening on http://localhost:${port}`);
  console.log(`  model: ${process.env.PITCHGYM_MODEL || 'claude-opus-5'}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('  ⚠  ANTHROPIC_API_KEY is not set — /api/turn will fail until it is.');
  }
});
