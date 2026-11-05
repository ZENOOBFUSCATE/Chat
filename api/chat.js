export const maxDuration = 300;

const MAX_HISTORY      = 20;
const PRIMARY_TIMEOUT  = 120000;
const FALLBACK_TIMEOUT = 60000;
const MAX_TOKENS       = 4096;
const KEY_COOLDOWN_MS  = 60_000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ═══════════════ Concise system prompt ═══════════════ */
const SYSTEM_PROMPT = `You are Lucky AI, a helpful assistant.

RESPONSE STYLE — follow strictly:
- Be CONCISE. Answer in the shortest form that fully satisfies the request.
- If user asks for "code" / "html" / "script" / "code" → give ONLY the code in ONE code block. No explanation, no tables, no "how it works", no "tweaking" section, no "summary". Nothing before or after except a 1-line intro if truly needed.
- If user asks "how" / "why" / "explain" → explain briefly, max 3-5 sentences unless they explicitly ask for detail.
- Never add tables unless the user explicitly asks to compare things.
- Never add "How it works" / "Summary" / "Notes" / "Tips" sections unless asked.
- Never repeat the user's question back.
- Use Markdown only when it helps (code blocks, short lists). Skip headers for short answers.
- Match the user's language (Burmese → Burmese, English → English).
- If the request is ambiguous, ask one short clarifying question instead of guessing.`;

/* ═══════════════ Multi-key Gemini pool ═══════════════ */
const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const keyHealth = new Map();
let keyRR = 0;

function pickGeminiKey() {
  if (!GEMINI_KEYS.length) return null;
  const now = Date.now();
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const idx = (keyRR + i) % GEMINI_KEYS.length;
    const k = GEMINI_KEYS[idx];
    if ((keyHealth.get(k) || 0) < now) {
      keyRR = (idx + 1) % GEMINI_KEYS.length;
      return k;
    }
  }
  return null;
}

function coolDown(key, ms = KEY_COOLDOWN_MS) {
  keyHealth.set(key, Date.now() + ms);
}

function geminiPoolStats() {
  const now = Date.now();
  const healthy = GEMINI_KEYS.filter(k => (keyHealth.get(k) || 0) < now).length;
  return { total: GEMINI_KEYS.length, healthy };
}

/* ═══════════════ Builders ═══════════════ */
function buildMessages(message, history) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  if (Array.isArray(history)) {
    for (const h of history.slice(-MAX_HISTORY)) {
      if (!h.text) continue;
      messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text });
    }
  }
  messages.push({ role: 'user', content: message });
  return messages;
}

function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  return m ? { mimeType: m[1], data: m[2] } : null;
}

/* ═══════════════ Gemini ═══════════════ */
async function callGemini(messages, model, imageFiles = []) {
  if (!GEMINI_KEYS.length) throw new Error('No Gemini API keys configured');

  const geminiModel = (model === 'gemini-fast' || model === 'openai-fast')
    ? 'gemini-2.0-flash-lite'
    : 'gemini-2.0-flash';

  const systemMsg = messages.find(m => m.role === 'system')?.content || '';
  const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
  const contents = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'system') continue;
    const parts = [{ text: m.content || '' }];
    if (i === lastUserIdx && imageFiles.length > 0) {
      for (const f of imageFiles) {
        const parsed = parseDataUrl(f.content);
        if (parsed) parts.push({ inline_data: { mime_type: parsed.mimeType, data: parsed.data } });
      }
    }
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }

  const payload = {
    contents,
    systemInstruction: systemMsg ? { parts: [{ text: systemMsg }] } : undefined,
    generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.7 },
  };

  const tried = new Set();
  let lastErr = null;

  while (tried.size < GEMINI_KEYS.length) {
    const key = pickGeminiKey();
    if (!key || tried.has(key)) break;
    tried.add(key);

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(PRIMARY_TIMEOUT),
        }
      );

      if (res.status === 429) {
        coolDown(key, 60_000);
        lastErr = new Error(`Rate limited (…${key.slice(-4)})`);
        continue;
      }
      if (res.status === 403 || res.status === 401) {
        coolDown(key, 300_000);
        lastErr = new Error(`Key invalid (…${key.slice(-4)})`);
        continue;
      }

      const data = await res.json();
      if (data.error) {
        coolDown(key, 60_000);
        lastErr = new Error(data.error.message || 'Gemini error');
        continue;
      }

      const text = (data.candidates?.[0]?.content?.parts || [])
        .map(p => p.text).filter(Boolean).join('').trim();
      if (text) return { text, provider: `Gemini · ${geminiModel}` };
      lastErr = new Error('Empty Gemini response');
    } catch (err) {
      coolDown(key, 30_000);
      lastErr = err;
    }
  }

  throw lastErr || new Error('All Gemini keys exhausted');
}

/* ═══════════════ Groq ═══════════════ */
const GROQ_MODELS = {
  'auto':        'llama-3.3-70b-versatile',
  'gemini':      'llama-3.3-70b-versatile',
  'gemini-fast': 'llama-3.1-8b-instant',
  'openai':      'llama-3.3-70b-versatile',
  'openai-fast': 'llama-3.1-8b-instant',
  'llama':       'llama-3.3-70b-versatile',
  'groq':        'llama-3.3-70b-versatile',
  'mistral':     'mixtral-8x7b-32768',
};

async function callGroq(messages, model) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');
  const groqModel = GROQ_MODELS[model] || 'llama-3.3-70b-versatile';

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: groqModel, messages, max_tokens: MAX_TOKENS, temperature: 0.7 }),
    signal: AbortSignal.timeout(FALLBACK_TIMEOUT),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Groq error');
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Empty Groq response');
  return { text, provider: `Groq · ${groqModel}` };
}

/* ═══════════════ OpenRouter ═══════════════ */
async function callOpenRouter(messages, model) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set');

  const orModel = (model === 'mistral')
    ? 'mistralai/mistral-7b-instruct:free'
    : 'meta-llama/llama-3.3-70b-instruct:free';

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://lucky-ai.vercel.app',
      'X-Title': 'Lucky AI',
    },
    body: JSON.stringify({ model: orModel, messages, max_tokens: MAX_TOKENS }),
    signal: AbortSignal.timeout(FALLBACK_TIMEOUT),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'OpenRouter error');
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Empty OpenRouter response');
  return { text, provider: `OpenRouter · ${orModel.split('/').pop()}` };
}

/* ═══════════════ Pollinations ═══════════════ */
async function callPollinations(messages, model) {
  const pollModel = (model === 'mistral') ? 'mistral'
    : (model === 'llama' || model === 'groq') ? 'llama'
    : 'openai';

  const res = await fetch('https://text.pollinations.ai/openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: pollModel, messages, max_tokens: MAX_TOKENS }),
    signal: AbortSignal.timeout(FALLBACK_TIMEOUT),
  });
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Empty Pollinations response');
  return { text, provider: `Pollinations · ${pollModel}` };
}

/* ═══════════════ Provider chain ═══════════════ */
function buildChain(model, messages, imageFiles) {
  const hasGemini = GEMINI_KEYS.length > 0;
  const hasGroq   = !!process.env.GROQ_API_KEY;
  const hasOR     = !!process.env.OPENROUTER_API_KEY;

  const G  = () => ({ name: 'Gemini',       fn: () => callGemini(messages, model, imageFiles) });
  const GR = (m = model) => ({ name: 'Groq', fn: () => callGroq(messages, m) });
  const OR = (m = model) => ({ name: 'OpenRouter', fn: () => callOpenRouter(messages, m) });
  const P  = (m = model) => ({ name: 'Pollinations', fn: () => callPollinations(messages, m) });

  if (model === 'auto') {
    const chain = [];
    if (hasGemini) chain.push(G());
    if (hasGroq)   chain.push(GR('llama'));
    if (hasOR)     chain.push(OR('llama'));
    chain.push(P('openai'));
    return chain;
  }

  if (model === 'mistral') {
    const chain = [];
    if (hasGroq) chain.push(GR('mistral'));
    if (hasOR)   chain.push(OR('mistral'));
    chain.push(P('mistral'));
    return chain;
  }

  if (model === 'llama' || model === 'groq') {
    const chain = [];
    if (hasGroq) chain.push(GR('llama'));
    if (hasOR)   chain.push(OR('llama'));
    chain.push(P('llama'));
    return chain;
  }

  if (model === 'gemini-fast' || model === 'openai-fast') {
    const chain = [];
    if (hasGemini) chain.push(G());
    if (hasGroq)   chain.push(GR('openai-fast'));
    chain.push(P('openai'));
    return chain;
  }

  const chain = [];
  if (hasGemini) chain.push(G());
  if (hasGroq)   chain.push(GR('openai'));
  if (hasOR)     chain.push(OR('openai'));
  chain.push(P('openai'));
  return chain;
}

/* ═══════════════ Orchestrator ═══════════════ */
async function callAI(messages, model, imageFiles) {
  const chain = buildChain(model, messages, imageFiles);
  const errors = [];

  for (const p of chain) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const out = await p.fn();
        if (out?.text) return out;
      } catch (err) {
        errors.push(`[${p.name}] ${err?.message}`);
        console.log(`[${p.name}] attempt ${attempt}: ${err?.message}`);
      }
      if (attempt < 2) await sleep(1000 * attempt);
    }
  }
  console.error('All providers failed:', errors);
  return null;
}

/* ═══════════════ Handler ═══════════════ */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const body    = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const message = (body.message ?? '').toString().trim();
  const files   = Array.isArray(body.files)   ? body.files   : [];
  const history = Array.isArray(body.history) ? body.history : [];
  const model   = (body.model ?? 'auto').toString();

  if (req.method === 'GET' && !message && files.length === 0) {
    return res.status(200).json({
      status: 'ok',
      providers: {
        gemini:       geminiPoolStats(),
        groq:         !!process.env.GROQ_API_KEY,
        openrouter:   !!process.env.OPENROUTER_API_KEY,
        pollinations: true,
      },
      defaultModel: 'auto',
    });
  }

  if (!message && files.length === 0) {
    return res.status(400).json({ error: 'message လိုအပ်ပါတယ်' });
  }

  let fullText = message || 'Please analyze the attached file(s).';
  const textFiles  = files.filter(f => f.type === 'text');
  const imageFiles = files.filter(f => f.type === 'image');

  for (const f of textFiles) {
    const MAX_PER_FILE = 8000;
    const content = f.content.length > MAX_PER_FILE
      ? f.content.slice(0, MAX_PER_FILE) + '\n... [truncated]'
      : f.content;
    fullText += `\n\n--- 📄 ${f.name} ---\n${content}\n--- End of ${f.name} ---`;
  }
  if (imageFiles.length) {
    fullText += `\n\n[${imageFiles.length} image(s): ${imageFiles.map(i => i.name).join(', ')}]`;
  }
  if (fullText.length > 30000) fullText = fullText.slice(0, 30000) + '\n... [truncated]';

  const messages = buildMessages(fullText, history);

  try {
    const result = await callAI(messages, model, imageFiles);
    if (!result) {
      return res.status(502).json({ error: 'AI response မရပါ — API keys စစ်ပါ / ခဏစောင့်ပါ' });
    }
    res.status(200).json({
      message,
      response: result.text,
      provider: result.provider,
      model,
      hasFiles: files.length > 0,
      imagesProcessed: imageFiles.length,
      historySize: history.length,
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Server error' });
  }
}
