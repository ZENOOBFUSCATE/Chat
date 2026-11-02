import { randomBytes } from 'node:crypto';

export const maxDuration = 30;

const hex = (n) => randomBytes(n).toString('hex');

function newMessageId() {
  const timeLow = hex(4);
  const timeMid = hex(2);
  const timeHi = '4' + hex(2).slice(1);
  const clock = (8 + Math.floor(Math.random() * 4)).toString(16) + hex(2).slice(1);
  const node = hex(6);
  return `${timeLow}-${timeMid}-${timeHi}-${clock}-${node}`;
}

function buildPayload(message, files = []) {
  const textFiles  = files.filter(f => f.type === 'text');
  const imageFiles = files.filter(f => f.type === 'image');

  // text file တွေကို message ထဲ ထည့်
  let fullText = message;
  if (textFiles.length) {
    fullText += textFiles.map(f =>
      `\n\n--- 📄 ${f.name} ---\n${f.content}\n--- End of ${f.name} ---`
    ).join('');
  }

  // image ပါရင် multimodal, မပါရင် plain text
  let content;
  if (imageFiles.length) {
    const parts = [{ content_type: 'text', text: fullText }];
    for (const img of imageFiles) {
      parts.push({ content_type: 'image_url', image_url: { url: img.content } });
    }
    content = { parts, content_type: 'multimodal_text' };
  } else {
    content = { parts: [fullText], content_type: 'text' };
  }

  return {
    action: 'next',
    messages: [{
      id: newMessageId(),
      author: { role: 'user' },
      content,
      status: 'finished_successfully',
      recipient: 'all',
      metadata: {
        is_visually_hidden_from_conversation: false,
        exclude_after_next_user_message: false,
        content_references: [],
        search_result_groups: [],
        search_queries: [],
        image_results: [],
        real_time_audio_has_video: false,
        dictation: false,
        image_gen_async: false,
        trigger_async_ux: false,
        writing_blocks: {},
      },
    }],
    model: 'auto',
    history_and_training_disabled: false,
    fork_from_shared_post: false,
    enable_message_followups: false,
    force_use_sse: true,
    force_use_search: null,
    force_paragen: false,
    supported_encodings: ['v1'],
    supports_buffering: true,
    timezone: 'Asia/Ho_Chi_Minh',
    timezone_offset_min: -420,
    system_hints: [],
    is_onboarding_conversation: false,
    stream: true,
  };
}

function parseSSE(raw) {
  let text = '';
  const lines = (raw || '').split('\n');

  for (const line0 of lines) {
    const line = line0.trim();
    if (!line.startsWith('data:')) continue;

    let data;
    try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (data === null || typeof data !== 'object') continue;

    if (Array.isArray(data.v) && data.v[0] !== undefined) {
      for (const patch of data.v) {
        if (patch && patch.p === '/message/content/parts/0' &&
            patch.o === 'append' && typeof patch.v === 'string') {
          text += patch.v;
        }
      }
    }

    const part = data.v?.message?.content?.parts?.[0];
    if (text === '' && data.v?.message?.author?.role === 'assistant' && typeof part === 'string') {
      text = part;
    }
  }
  return text.trim();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const body  = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const message = (body.message ?? '').toString().trim();
  const files   = Array.isArray(body.files) ? body.files : [];

  if (!message && files.length === 0) {
    res.status(400).json({ error: 'message လိုအပ်ပါတယ်' });
    return;
  }

  const effectiveMessage = message || 'Please analyze the attached file(s).';

  const cookie = [
    `__cflb=${hex(20)}`, `__cfuvid=${hex(24)}`,
    `oai-sc=${hex(64)}`, `__cf_bm=${hex(48)}`,
  ].join('; ');

  const headers = {
    'User-Agent': 'ChatGPT/1.2027.000 (Android 12; SM-F741N; build 27230000)',
    'Accept': 'text/event-stream,application/json',
    'Content-Type': 'application/json',
    'oai-device-id': hex(10),
    'Cookie': cookie,
  };

  try {
    const upstream = await fetch(
      'https://android.chat.openai.com/backend-api/f/conversation',
      {
        method: 'POST',
        headers,
        body: JSON.stringify(buildPayload(effectiveMessage, files)),
        signal: AbortSignal.timeout(30000),
      }
    );

    const raw = await upstream.text();
    const text = parseSSE(raw);

    if (!text) {
      res.status(502).json({
        error: 'Upstream response ကနေ text မရရှိပါ',
        upstreamStatus: upstream.status,
      });
      return;
    }

    res.status(200).json({
      'by -> ': '@aantik_mods',
      message: effectiveMessage,
      response: text,
      hasFiles: files.length > 0,
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || 'Request failed' });
  }
}