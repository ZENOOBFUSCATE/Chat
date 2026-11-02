export const maxDuration = 300;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildMessages(message, history) {
  const messages = [{
    role: 'system',
    content: `You are Lucky AI, an expert programming assistant.

CRITICAL RULES:
1. ALWAYS write COMPLETE code from beginning to end. NEVER truncate.
2. Wrap ALL code in markdown blocks with language tag:
\`\`\`python
complete code here
\`\`\`
3. Use Markdown: **bold**, \`inline\`, lists, tables, headers.
4. Respond in the user's language (Myanmar or English).
5. After code, give a short explanation.`
  }];

  if (Array.isArray(history) && history.length > 0) {
    for (const h of history.slice(-20)) {
      if (h.role === 'user' && h.text)
        messages.push({ role: 'user', content: h.text });
      else if (h.role === 'bot' && h.text)
        messages.push({ role: 'assistant', content: h.text });
    }
  }

  messages.push({ role: 'user', content: message });
  return messages;
}

function extractText(data) {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return data[0]?.generated_text || data[0]?.text || '';
  return data?.choices?.[0]?.message?.content
      || data?.response
      || data?.text
      || data?.generated_text
      || '';
}

function isTruncated(text) {
  if (!text || text.length < 50) return true;
  const fences = (text.match(/```/g) || []).length;
  if (fences % 2 !== 0) return true;
  const end = text.trim().slice(-60).toLowerCase();
  return ['...','…','rest of','continue','omitted','truncated','remaining']
    .some(b => end.includes(b));
}

// ─── Provider 1: Puter.js (free, no key, generous) ───
async function tryPuter(messages) {
  const prompt = messages
    .filter(m => m.role !== 'system')
    .map(m => (m.role === 'user' ? 'User: ' : 'Assistant: ') + m.content)
    .join('\n');

  const res = await fetch('https://api.puter.com/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const text = extractText(data);
  if (!text) throw new Error('Empty');
  return text;
}

// ─── Provider 2: HuggingFace Inference (free tier) ───
async function tryHuggingFace(messages) {
  const token = process.env.HF_TOKEN;
  if (!token) throw new Error('No HF_TOKEN');

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
        parameters: { max_new_tokens: 2048, return_full_text: false },
      }),
      signal: AbortSignal.timeout(60000),
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const text = extractText(data);
  if (!text) throw new Error('Empty');
  return text;
}

// ─── Provider 3: Groq (free, fast — need free key) ───
async function tryGroq(messages) {
  const token = process.env.GROQ_API_KEY;
  if (!token) throw new Error('No GROQ_API_KEY');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: 4096,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const text = extractText(data);
  if (!text) throw new Error('Empty');
  return text;
}

// ─── Provider 4: Pollinations (last resort, 45s rate limit) ───
async function tryPollinations(messages) {
  const res = await fetch('https://text.pollinations.ai/openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'openai',
      messages,
      max_tokens: 4096,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 150)}`);
  }
  const data = await res.json();
  const text = extractText(data);
  if (!text) throw new Error('Empty');
  return text;
}

async function callAI(messages) {
  const providers = [
    { name: 'Puter',       fn: () => tryPuter(messages) },
    { name: 'Groq',        fn: () => tryGroq(messages) },
    { name: 'HuggingFace', fn: () => tryHuggingFace(messages) },
    { name: 'Pollinations',fn: () => tryPollinations(messages) },
  ];

  const errors = [];

  for (const p of providers) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`[${p.name}] attempt ${attempt}`);
        const text = await p.fn();
        if (text && !isTruncated(text)) return text;
        if (text && attempt >= 2) return text;  // accept if last attempt
        if (text) {
          // truncated → retry this provider once more
          await sleep(1500);
          continue;
        }
      } catch (err) {
        const msg = `[${p.name}] attempt ${attempt}: ${err.message}`;
        console.log(msg);
        errors.push(msg);
        if (err.message.includes('402') || err.message.includes('FREE_LIMIT')) {
          // rate limited → skip this provider immediately
          break;
        }
      }
      await sleep(1000 * attempt);
    }
  }

  throw new Error('All providers failed: ' + errors.slice(-3).join(' | '));
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

  if (!message && files.length === 0) {
    res.status(400).json({ error: 'message လိုအပ်ပါတယ်' });
    return;
  }

  let fullText = message || 'Please analyze the attached file(s).';

  for (const f of files.filter(f => f.type === 'text')) {
    const content = f.content.length > 8000
      ? f.content.slice(0, 8000) + '\n...[truncated]'
      : f.content;
    fullText += `\n\n--- 📄 ${f.name} ---\n${content}\n--- End ---`;
  }

  const imgFiles = files.filter(f => f.type === 'image');
  if (imgFiles.length) {
    fullText += `\n\n[${imgFiles.length} image(s): ${imgFiles.map(i => i.name).join(', ')}]`;
  }

  if (fullText.length > 30000) {
    fullText = fullText.slice(0, 30000) + '\n...[truncated]';
  }

  try {
    const messages = buildMessages(fullText, history);
    const text = await callAI(messages);

    if (!text) {
      res.status(502).json({ error: 'AI response မရပါ — ခဏစောင့်ပြီး ထပ်ကြိုးစားပါ' });
      return;
    }

    res.status(200).json({
      'by -> ': '@aantik_mods',
      message,
      response: text,
      hasFiles: files.length > 0,
    });
  } catch (err) {
    res.status(500).json({
      error: err?.message?.includes('timeout') || err?.name === 'TimeoutError'
        ? 'Response ကြာလွန်းပါတယ် — ထပ်ကြိုးစားပါ'
        : (err?.message || 'Server error — ထပ်ကြိုးစားပါ'),
    });
  }
}
