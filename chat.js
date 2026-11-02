export const maxDuration = 300;

const API_URL = 'https://text.pollinations.ai/openai';
const MAX_TOKENS = 4096;
const TIMEOUT = 90000;
const MAX_ATTEMPTS = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildMessages(message, history) {
  const messages = [{
    role: 'system',
    content: `You are Lucky AI, an expert programming assistant.

CRITICAL RULES:
1. ALWAYS write COMPLETE code from beginning to end. NEVER truncate, NEVER say "rest of code" or "..." for code.
2. Wrap ALL code in markdown blocks with language tag:
\`\`\`python
complete code here
\`\`\`
\`\`\`javascript
// complete code here
\`\`\`
3. If code is long, write ALL of it. Do not stop halfway.
4. Use Markdown: **bold**, \`inline\`, lists, tables, headers, > quotes.
5. Respond in the user's language (Myanmar or English).
6. After code, give a short explanation.
7. Be direct and helpful.`
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

function isTruncated(text) {
  if (!text || text.length < 50) return true;
  const codeFences = (text.match(/```/g) || []).length;
  if (codeFences % 2 !== 0) return true;
  const end = text.trim().slice(-60).toLowerCase();
  const bad = ['...', '…', 'rest of', 'continue', 'omitted', 'truncated', 'remaining'];
  for (const b of bad) { if (end.includes(b)) return true; }
  return false;
}

async function callAI(messages, attempt = 0) {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        messages,
        max_tokens: MAX_TOKENS,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';

    if (!text) throw new Error('Empty response');

    if (isTruncated(text) && attempt < MAX_ATTEMPTS) {
      console.log(`Truncated (attempt ${attempt + 1}), retrying...`);
      await sleep(2000);
      return callAI(messages, attempt + 1);
    }

    return text;
  } catch (err) {
    if (attempt < MAX_ATTEMPTS) {
      console.log(`Attempt ${attempt + 1} failed: ${err.message}`);
      await sleep(2000 * (attempt + 1));
      return callAI(messages, attempt + 1);
    }
    throw err;
  }
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
      res.status(502).json({ error: 'AI response မရပါ — ထပ်ကြိုးစားပါ' });
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