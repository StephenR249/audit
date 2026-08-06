// ============================================================
//  Claude integration — builds the prospect persona prompt and
//  runs one conversational turn. This is the ONLY place the
//  Anthropic API key is used; it never leaves the server.
// ============================================================
import Anthropic from '@anthropic-ai/sdk';

// The SDK reads ANTHROPIC_API_KEY from the environment automatically.
// One shared client is reused across requests (connection pooling).
const client = new Anthropic();

// --- Tunables (override via env; see .env.example) -----------
// Default to the most capable model. For a high-volume consumer app you may
// well want claude-sonnet-5 or claude-haiku-4-5 — flip PITCHGYM_MODEL and
// weigh the cost/latency trade-off. We do NOT downgrade for you.
const MODEL = process.env.PITCHGYM_MODEL || 'claude-opus-5';

// Prospect replies are short (1–3 sentences). On Opus 5 thinking is ON by
// default and max_tokens caps thinking + reply together, so we keep effort
// "low" (fast, cheap, plenty smart for a role-play line) and leave headroom.
const MAX_TOKENS = Number(process.env.PITCHGYM_MAX_TOKENS || 1024);
const EFFORT = process.env.PITCHGYM_EFFORT || 'low'; // low | medium | high

// Cap how much conversation we resend each turn (cost + latency guard).
const MAX_HISTORY_TURNS = 40;

function clamp(value, max) {
  return String(value == null ? '' : value).slice(0, max);
}

// Build the system prompt that turns Claude into a specific buyer.
// Persona/product come from the client (the game already has this data per
// level). It's role-play, not a trust boundary, so we sanitise lengths only.
export function buildSystemPrompt(persona, product, stage) {
  const name = clamp(persona?.name, 80) || 'the prospect';
  const role = clamp(persona?.role, 120) || 'a decision-maker';
  const company = clamp(persona?.company, 120) || 'their company';
  const personality =
    clamp(persona?.personality, 400) || 'busy, direct, and mildly skeptical';
  const productText = clamp(product, 300) || 'a product or service';

  const stageNote =
    {
      opening: 'The call has just started. React to how the rep opens.',
      objection:
        'You have real objections. Voice them naturally — do not fold on the first answer; make the rep earn it.',
      close:
        'The rep is trying to lock a next step. Only commit if they have genuinely earned it.'
    }[stage] || '';

  return [
    `You are ${name}, ${role} at ${company}.`,
    `Your personality: ${personality}.`,
    `A salesperson is pitching you ${productText}.`,
    '',
    'Stay fully in character as this buyer. Behave like a real, busy person:',
    '- Reply in the first person, in 1–3 short sentences. Conversational, not scripted.',
    '- Be realistically skeptical. Raise genuine objections; do not cave instantly.',
    '- When the rep asks a sharp discovery question or shows real value, acknowledge it and warm up a little.',
    "- Match your persona's tone (blunt, warm, harried, technical — whatever fits).",
    stageNote ? `- ${stageNote}` : '',
    '',
    'Never break character. Never say you are an AI. Never coach, grade, or',
    'evaluate the salesperson, and never write stage directions or narration —',
    'only speak as the buyer would speak out loud.'
  ]
    .filter(Boolean)
    .join('\n');
}

// Map the game's transcript to the Anthropic messages format and run one turn.
// Returns { reply, usage, refused, stop_reason }.
export async function runTurn({ persona, product, stage, messages }) {
  const system = buildSystemPrompt(persona, product, stage);

  // rep -> user, prospect -> assistant. Drop blanks, clamp length, cap history.
  let apiMessages = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .slice(-MAX_HISTORY_TURNS)
    .map((m) => ({
      role: m.role === 'prospect' ? 'assistant' : 'user',
      content: clamp(m.text, 2000)
    }));

  // The API requires messages[0] to be a user turn. If the prospect opened the
  // call (assistant-first) or there's no rep line yet, start from the first rep
  // message — or synthesise an opener request so the server can generate the
  // prospect's first line too.
  const firstUser = apiMessages.findIndex((m) => m.role === 'user');
  if (firstUser === -1) {
    apiMessages = [
      {
        role: 'user',
        content:
          '(The salesperson has just approached to pitch you. Greet them briefly, in character.)'
      }
    ];
  } else {
    apiMessages = apiMessages.slice(firstUser);
  }

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: EFFORT },
    // cache_control caches the persona prompt across turns of the same call.
    // (Silently no-ops if the prompt is under the model's cache minimum.)
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: apiMessages
  });

  // Opus 5 can decline a request (HTTP 200 + stop_reason "refusal"). Check
  // before reading content, and stay in the fiction with a neutral deflection.
  if (response.stop_reason === 'refusal') {
    return {
      reply: "Let's keep this on track — go ahead.",
      usage: response.usage,
      refused: true,
      stop_reason: response.stop_reason
    };
  }

  const reply = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  return {
    reply: reply || '…',
    usage: response.usage,
    refused: false,
    stop_reason: response.stop_reason
  };
}
