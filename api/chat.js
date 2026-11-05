export const maxDuration = 300;

const MAX_HISTORY      = 20;
const PRIMARY_TIMEOUT  = 120000;
const FALLBACK_TIMEOUT = 60000;
const MAX_RETRIES      = 3;
const MAX_TOKENS       = 4096;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SYSTEM_PROMPT = 'You are Lucky AI, a helpful, intelligent assistant like ChatGPT. ' +
  'You remember the entire conversation. Use Markdown formatting: **bold**, `inline code`, ' +
  '```code blocks```, lists, tables, and headers. Respond in the same language the user uses. ' +
  'Be accurate, thorough, and friendly.';

function buildMessages(message, history) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  if (Array.isArray(history)) {
    for (const h of history.slice(-MAX_HISTORY)) {
      if (!h.text) continue;
      messages.push({
        role: h.role === 'user' ? 'user' : 'assistant',
        content: h.text,
      });
    }
  }
  messages.push({ role: 'user', content: message });
  return messages;
}

function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

/* ─────────────────── Gemini (Google — primary, vision-capable) ─────────────────── */
async function callGemini(messages, model, imageFiles = []) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');

  const geminiModel = model === 'openai-fast'
    ? 'gemini-2.0-flash-lite'
    : 'gemini-2.0-flash';

  const systemMsg = messages.find(m => m.role === 'system')?.content || '';
  const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
  const contents = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'system') continue;
    const parts = [{ text: m.content || '' }];

    // Attach images ONLY to the current (last) user turn
    if (i === lastUserIdx && imageFiles.length > 0) {
      for (const f of imageFiles) {
        const parsed = parseDataUrl(f.content);
        if (parsed) {
          parts.push({
            inline_data: { mime_type: parsed.mimeType, data: parsed.data },
          });
        }
      }
    }

    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts,
    });
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: systemMsg ? { parts: [{ text: systemMsg }] } : undefined,
        generationConfig: { maxOutputTokens: MAX_TOKENS, temperature: 0.7 },
      }),
      signal: AbortSignal.timeout(PRIMARY_TIMEOUT),
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Gemini error');
  return (data.candidates?.[0]?.content?.parts || [])
    .map(p => p.text).filter(Boolean).join('');
}

/* ─────────────────── Groq (Meta LLaMA/Mixtral — fast) ─────────────────── */
const GROQ_MODELS = {
  'openai':      'llama-3.3-70b-versatile',
  'openai-fast': 'llama-3.1-8b-instant',
  'mistral':     'mixtral-8x7b-32768',
  'llama':       'llama-3.3-70b-versatile',
};

async function callGroq(messages, model) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');
  const groqModel = GROQ_MODELS[model] || 'llama-3.3-70b-versatile';

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: groqModel,
      messages,
      max_tokens: MAX_TOKENS,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(FALLBACK_TIMEOUT),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Groq error');
  return data?.choices?.[0]?.message?.content || '';
}

/* ─────────────────── OpenRouter (variety) ─────────────────── */
async function callOpenRouter(messages, model) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set');

  const orModel = model === 'mistral'
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
    body: JSON.stringify({
      model: orModel,
      messages,
      max_tokens: MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(FALLBACK_TIMEOUT),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'OpenRouter error');
  return data?.choices?.[0]?.message?.content || '';
}

/* ─────────────────── Pollinations (no key, last resort) ─────────────────── */
async function callPollinations(messages, model) {
  const pollModel = model === 'mistral' ? 'mistral'
    : model === 'llama' ? 'llama'
    : 'openai';

  const res = await fetch('https://text.pollinations.ai/openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: pollModel,
      messages,
      max_tokens: MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(FALLBACK_TIMEOUT),
  });
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

/* ─────────────────── Orchestrator with model-aware routing ─────────────────── */
async function callAI(messages, model, imageFiles) {
  const chain = [];

  if (model === 'mistral') {
    chain.push(
      { name: 'Groq (Mixtral)',        fn: () => callGroq(messages, model) },
      { name: 'OpenRouter (Mistral)',  fn: () => callOpenRouter(messages, model) },
      { name: 'Pollinations (Mistral)', fn: () => callPollinations(messages, model) },
    );
  } else if (model === 'llama') {
    chain.push(
      { name: 'Groq (LLaMA 3.3)',      fn: () => callGroq(messages, model) },
      { name: 'OpenRouter (LLaMA)',    fn: () => callOpenRouter(messages, model) },
      { name: 'Pollinations (LLaMA)', fn: () => callPollinations(messages, model) },
    );
  } else if (model === 'openai-fast') {
    chain.push(
      { name: 'Gemini Flash-Lite', fn: () => callGemini(messages, model, imageFiles) },
      { name: 'Groq (8B instant)', fn: () => callGroq(messages, model) },
      { name: 'Pollinations',      fn: () => callPollinations(messages, model) },
    );
  } else {
    // 'openai' (Smart)
    chain.push(
      { name: 'Gemini 2.0 Flash',  fn: () => callGemini(messages, model, imageFiles) },
      { name: 'Groq (LLaMA 3.3)', fn: () => callGroq(messages, model) },
      { name: 'OpenRouter',       fn: () => callOpenRouter(messages, model) },
      { name: 'Pollinations',     fn: () => callPollinations(messages, model) },
    );
  }

  const errors = [];
  for (const p of chain) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const text = await p.fn();
        if (text && text.trim()) {
          return { text: text.trim(), provider: p.name };
        }
      } catch (err) {
        errors.push(`[${p.name}] ${err?.message}`);
        console.log(`[${p.name}] attempt ${attempt}: ${err?.message}`);
      }
      if (attempt < MAX_RETRIES) await sleep(1500 * attempt);
    }
  }
  console.error('All providers failed:', errors);
  return null;
}

/* ─────────────────── Handler ─────────────────── */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const body    = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const message = (body.message ?? '').toString().trim();
  const files   = Array.isArray(body.files)   ? body.files   : [];
  const history = Array.isArray(body.history) ? body.history : [];
  const model   = (body.model ?? 'openai').toString();

  // Health check (GET with no message)
  if (req.method === 'GET' && !message && files.length === 0) {
    return res.status(200).json({
      status: 'ok',
      providers: {
        gemini:       !!process.env.GEMINI_API_KEY,
        groq:         !!process.env.GROQ_API_KEY,
        openrouter:   !!process.env.OPENROUTER_API_KEY,
        pollinations: true,
      },
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
    fullText += `\n\n[${imageFiles.length} image(s) attached: ${imageFiles.map(i => i.name).join(', ')}]`;
  }

  if (fullText.length > 30000) {
    fullText = fullText.slice(0, 30000) + '\n... [truncated]';
  }

  const messages = buildMessages(fullText, history);

  try {
    const result = await callAI(messages, model, imageFiles);
    if (!result) {
      return res.status(502).json({
        error: 'AI response မရပါ — API keys စစ်ဆေးပြီး ထပ်ကြိုးစားပါ',
      });
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
