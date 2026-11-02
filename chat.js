export const maxDuration = 300;

const PRIMARY_TIMEOUT  = 120000;
const FALLBACK_TIMEOUT = 60000;
const MAX_RETRIES      = 3;
const MAX_HISTORY      = 20;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildMessages(message, history) {
  const messages = [{
    role: 'system',
    content: 'You are Lucky AI, a helpful assistant like ChatGPT. You remember the entire conversation. Use Markdown formatting: **bold**, `code`, ```code blocks```, lists, tables, headers. Respond in the same language the user uses.'
  }];

  if (Array.isArray(history) && history.length > 0) {
    for (const h of history.slice(-MAX_HISTORY)) {
      if (h.role === 'user' && h.text)
        messages.push({ role: 'user', content: h.text });
      else if (h.role === 'bot' && h.text)
        messages.push({ role: 'assistant', content: h.text });
    }
  }

  messages.push({ role: 'user', content: message });
  return messages;
}

// ─── Pollinations ───
async function callPollinations(messages, model = 'openai') {
  const res = await fetch('https://text.pollinations.ai/openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model || 'openai',
      messages,
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(PRIMARY_TIMEOUT),
  });
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

// ─── Groq ───
async function callGroq(messages) {
  const token = process.env.GROQ_API_KEY;
  if (!token) return '';
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(FALLBACK_TIMEOUT),
  });
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

// ─── HuggingFace ───
async function callHuggingFace(messages) {
  const token = process.env.HF_TOKEN;
  if (!token) return '';
  let prompt = '';
  for (const m of messages) {
    if (m.role === 'system') continue;
    prompt += (m.role === 'user' ? '[INST] ' : '</s>[INST] ') + m.content;
  }
  prompt += '</s>';
  const res = await fetch(
    'https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.3',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: { max_new_tokens: 1024, return_full_text: false },
      }),
      signal: AbortSignal.timeout(FALLBACK_TIMEOUT),
    }
  );
  const data = await res.json();
  if (Array.isArray(data)) return data[0]?.generated_text || '';
  return data?.generated_text || '';
}

async function callAI(messages, model) {
  const providers = [
    { name: 'Pollinations', fn: () => callPollinations(messages, model) },
    { name: 'Groq',         fn: () => callGroq(messages) },
    { name: 'HuggingFace',  fn: () => callHuggingFace(messages) },
  ];

  for (const provider of providers) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const text = await provider.fn();
        if (text) return text;
      } catch (err) {
        console.log(`[${provider.name}] attempt ${attempt}: ${err?.message}`);
      }
      if (attempt < MAX_RETRIES) await sleep(1500 * attempt);
    }
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const body    = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const message = (body.message ?? '').toString().trim();
  const files   = Array.isArray(body.files) ? body.files : [];
  const history = Array.isArray(body.history) ? body.history : [];
  const model   = (body.model ?? 'openai').toString();

  if (!message && files.length === 0) {
    res.status(400).json({ error: 'message လိုအပ်ပါတယ်' });
    return;
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

  if (fullText.length > 30000) {
    fullText = fullText.slice(0, 30000) + '\n... [truncated]';
  }

  const messages = buildMessages(fullText, history);

  try {
    const text = await callAI(messages, model);
    if (!text) {
      res.status(502).json({ error: 'AI response မရပါ — ခဏစောင့်ပြီး ထပ်ကြိုးစားပါ' });
      return;
    }
    res.status(200).json({
      'by -> ': '@aantik_mods',
      message,
      response: text,
      model,
      hasFiles: files.length > 0,
      historySize: history.length,
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Server error' });
  }
}