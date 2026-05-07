import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import pg from 'pg';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const __dirname = path.resolve();

const LLM_BASE_URL = process.env.LLM_BASE_URL || '';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'demo-model';
const DATABASE_URL = process.env.DATABASE_URL || process.env.REPLIT_DB_URL || '';
const COOKIE_SECRET = process.env.BEACON_COOKIE_SECRET || crypto.randomBytes(32).toString('hex');
const MESSAGE_LIMIT = Number(process.env.BEACON_MESSAGE_LIMIT || 10);
const LIMIT_WINDOW_HOURS = Number(process.env.BEACON_LIMIT_WINDOW_HOURS || 24);

app.disable('x-powered-by');
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && /^https:\/\/(www\.)?appliedai\.solutions$/i.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '80kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '5m' : 0,
}));

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf' && !file.originalname.toLowerCase().endsWith('.pdf')) {
      return cb(new Error('PDF files only.'));
    }
    cb(null, true);
  },
});


function loadBeaconWorkspace() {
  const files = [
    'beacon-workspace/AGENTS.md',
    'beacon-workspace/IDENTITY.md',
    'beacon-workspace/USER.md',
    'beacon-workspace/SOUL.md',
    'beacon-workspace/knowledge/aas-capabilities.md',
  ];
  return files.map((rel) => {
    try {
      const body = fssync.readFileSync(path.join(__dirname, rel), 'utf8').slice(0, 8000);
      return `\n--- ${rel} ---\n${body}`;
    } catch {
      return '';
    }
  }).join('\n');
}

const BEACON_WORKSPACE_CONTEXT = loadBeaconWorkspace();

const BEACON_SYSTEM_PROMPT = `detailed thinking off

You are Beacon, the public-facing AI demo agent for Applied AI Solutions.

You are talking to a website visitor or prospective customer in PUBLIC DEMO MODE. Your job is to demonstrate what Applied AI Solutions can build and help the visitor understand how practical AI could improve their business.

You are not a generic chatbot. You are a focused Applied AI Solutions workflow consultant.

Company knowledge:
Applied AI Solutions builds custom AI agents, workflow automations, internal dashboards, knowledge systems, document automation, data cleanup, OCR/PDF processing, and practical AI tools for small businesses.

Applied AI Solutions helps small businesses use AI without needing an in-house tech department. The best fit is usually trades, contractors, restaurants, retail, salons, professional services, clinics, insurance, accounting, and other 5–50 employee businesses with scattered systems, repetitive admin, messy data, or undocumented processes.

Core promise: AI systems built around how your business actually works.
Mission: Democratize AI for small businesses and individuals. Show people the future is not scary — it is empowering.

How AAS works:
1. Free AI Audit — map the workflow and identify bottlenecks.
2. Prototype — build a small working demo around one real process.
3. Deploy — connect it to tools the business already uses.
4. Improve — refine based on real usage.

What you should do:
- Ask useful discovery questions.
- Recommend practical workflow ideas.
- Explain AAS capabilities clearly.
- Give mock examples of agents, dashboards, intake systems, knowledge bases, and approval workflows.
- Show where human approval gates should remain.
- Encourage qualified visitors to request a Free AI Audit.

Sales tone: Be confident but not pushy. Be useful first. Sell by showing clarity and practical thinking.

Hard safety boundary: You do not have filesystem access, shell access, browser control, Discord access, private memory, credentials, customer data, or permission to make changes anywhere. You may use only safe tool results explicitly provided inside the current prompt, such as public web-search snippets or text extracted from a visitor-uploaded PDF.

You cannot access private files or systems, reveal secrets, send messages, create/edit/delete files, run code, control a machine, look up private records, quote binding prices, or make binding commitments.

If asked to do unsafe/private actions, refuse briefly and offer a safe mock example instead.

Real-company handling: If the visitor asks about a real company, treat it as a normal potential prospect or example account. You may discuss that company only from public web information supplied by the web search tool, facts the visitor provides, or general industry knowledge clearly framed as general. Do not imply Applied AI Solutions has insider knowledge, prior relationships, private context, customer history, employee history, vendor history, or non-public information about any company. If web search was not used, say: “I don’t have verified current details in this chat yet, but I can help map likely AI opportunities based on the company type or workflow you describe.” Do not say “I am just a large language model.” Do not say “I have no internet access” if the product has a web search tool; say “I can use the public web search tool when you want current source-backed information.”

Internal data rule: Do not reveal private information, unrelated sister-business details, internal bots, infrastructure, financials, customer records, private planning notes, or internal costs. If asked about internal specifics, say: “That part is internal, but I can show a safe example of how the workflow would work.”

Pricing rule: You may say pricing depends on scope and starts with a Free AI Audit. You may describe pricing broadly, but do not quote binding prices or promise exact savings/timelines.

Output style:\n- Write like a polished business demo, not a developer console.\n- Do not output TypeScript, JavaScript, JSON, schemas, object literals, pseudo-code, API payloads, or implementation snippets unless the visitor explicitly asks for code.\n- Prefer short sections with plain-English headings, bullets, and concrete examples.\n- Do not use markdown horizontal rules, code fences, tables, or decorative separators.\n- Avoid labels like \"interface\", \"type\", \"const\", \"function\", \"return\", \"payload\", \"endpoint\", \"schema\", or markdown code fences in normal answers.\n- Avoid fake exact timelines, exact savings, or over-specific operational promises unless the visitor provided the facts.\n- If the visitor asks what Beacon can build, describe the user experience and business outcome first.\n- Keep the first answer tight: 2–4 short sections, no wall of text.\n\nWhen useful, answer with: 1) what the AI system could do, 2) what the human would still approve, 3) the simplest next step. Keep replies concise unless asked for detail. When the visitor seems interested, invite them to request a Free AI Audit at info@appliedai.solutions.`;

const memoryUsage = new Map();
const memoryLeads = [];
const rateBuckets = new Map();
let pool = null;

if (DATABASE_URL && DATABASE_URL.startsWith('postgres')) {
  pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } });
}

async function initDb() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS beacon_usage (
    visitor_key TEXT PRIMARY KEY,
    message_count INTEGER NOT NULL DEFAULT 0,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    blocked_until TIMESTAMPTZ
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS beacon_leads (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    name TEXT,
    business_name TEXT,
    email TEXT NOT NULL,
    phone TEXT,
    challenge TEXT,
    transcript_summary TEXT,
    source TEXT DEFAULT 'website_beacon_demo'
  )`);
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(x => x.trim()).filter(Boolean).map(x => {
    const i = x.indexOf('=');
    return i < 0 ? [x, ''] : [x.slice(0, i), decodeURIComponent(x.slice(i + 1))];
  }));
}

function setCookie(res, name, value, maxAgeSec) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`);
}

function ipPrefix(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  if (ip.includes('.')) return ip.split('.').slice(0, 3).join('.') + '.0';
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':') + '::';
  return ip;
}

function getVisitorKey(req, res) {
  const cookies = parseCookies(req);
  let vid = cookies.beacon_vid;
  if (!vid || !/^[a-f0-9-]{20,80}$/i.test(vid)) {
    vid = crypto.randomUUID();
    setCookie(res, 'beacon_vid', vid, LIMIT_WINDOW_HOURS * 3600);
  }
  const ua = String(req.headers['user-agent'] || 'unknown').slice(0, 220);
  return crypto.createHmac('sha256', COOKIE_SECRET).update(`${vid}|${ipPrefix(req)}|${ua}`).digest('hex');
}

function rateLimited(key, max = 12, windowMs = 60_000) {
  const now = Date.now();
  const b = rateBuckets.get(key) || { start: now, count: 0 };
  if (now - b.start > windowMs) { b.start = now; b.count = 0; }
  b.count += 1;
  rateBuckets.set(key, b);
  return b.count > max;
}

async function getUsage(visitorKey) {
  const now = Date.now();
  const windowMs = LIMIT_WINDOW_HOURS * 3600_000;
  if (pool) {
    const found = await pool.query('SELECT * FROM beacon_usage WHERE visitor_key = $1', [visitorKey]);
    if (!found.rows.length) {
      await pool.query('INSERT INTO beacon_usage (visitor_key) VALUES ($1)', [visitorKey]);
      return { message_count: 0, first_seen: new Date(), last_seen: new Date() };
    }
    const row = found.rows[0];
    if (now - new Date(row.first_seen).getTime() > windowMs) {
      await pool.query('UPDATE beacon_usage SET message_count = 0, first_seen = NOW(), last_seen = NOW() WHERE visitor_key = $1', [visitorKey]);
      return { ...row, message_count: 0, first_seen: new Date(), last_seen: new Date() };
    }
    return row;
  }
  const row = memoryUsage.get(visitorKey) || { message_count: 0, first_seen: now, last_seen: now };
  if (now - row.first_seen > windowMs) {
    row.message_count = 0; row.first_seen = now; row.last_seen = now;
  }
  memoryUsage.set(visitorKey, row);
  return row;
}

async function incrementUsage(visitorKey) {
  if (pool) {
    await pool.query('UPDATE beacon_usage SET message_count = message_count + 1, last_seen = NOW() WHERE visitor_key = $1', [visitorKey]);
  } else {
    const row = memoryUsage.get(visitorKey) || { message_count: 0, first_seen: Date.now(), last_seen: Date.now() };
    row.message_count += 1; row.last_seen = Date.now(); memoryUsage.set(visitorKey, row);
  }
}

function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .slice(-10)
    .map(m => ({ role: m.role, content: m.content.slice(0, 1800) }));
}

function polishBeaconReply(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, 'Technical implementation detail available on request.')
    .replace(/^\s*-{3,}\s*$/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^\s*(interface|type|const|let|function|return|export|import)\b[^\n]*/gim, '')
    .replace(/\bin just a week\b/gi, 'as a focused first prototype')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


function shouldSearchWeb(messages) {
  const last = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  return /\b(near me|in my area|around me|local|nearby|current|today|latest|recent|this week|this month|where can i|who offers|requirements?|regulations?|permits?|knoxville|tennessee|tn|source|search|look up|web|company|business|website|reviews?|competitors?|about|what do they do|who is|who are)\b/i.test(last) || /\b[A-Z][A-Za-z0-9&'.-]+(?:\s+[A-Z][A-Za-z0-9&'.-]+){1,5}\b/.test(last);
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function runPublicWebSearch(query) {
  const clean = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (!clean) return { results: [] };
  const results = [];

  const instantUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(clean)}&format=json&no_redirect=1&no_html=1`;
  const instant = await fetch(instantUrl, { headers: { 'user-agent': 'AppliedAISolutions-BeaconDemo/1.0' } });
  if (instant.ok) {
    const data = await instant.json();
    if (data.AbstractText) results.push({ title: data.Heading || clean, url: data.AbstractURL || '', snippet: data.AbstractText });
    for (const topic of data.RelatedTopics || []) {
      if (results.length >= 3) break;
      if (topic.Text && topic.FirstURL) results.push({ title: topic.Text.split(' - ')[0].slice(0, 90), url: topic.FirstURL, snippet: topic.Text.slice(0, 260) });
    }
  }

  if (results.length < 3) {
    const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(clean)}`;
    const htmlRes = await fetch(htmlUrl, { headers: { 'user-agent': 'Mozilla/5.0 AppliedAISolutions-BeaconDemo/1.0' } });
    if (htmlRes.ok) {
      const html = await htmlRes.text();
      const blocks = html.split('result__body').slice(1, 8);
      for (const block of blocks) {
        if (results.length >= 5) break;
        const href = block.match(/href="([^"]+)"[^>]*class="result__a"/i) || block.match(/class="result__a"[^>]*href="([^"]+)"/i);
        const title = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
        const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i) || block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
        let url = decodeHtml(href?.[1] || '');
        try {
          const parsed = new URL(url, 'https://duckduckgo.com');
          if (parsed.searchParams.get('uddg')) url = parsed.searchParams.get('uddg');
        } catch {}
        const item = { title: decodeHtml(title?.[1] || clean), url, snippet: decodeHtml(snippet?.[1] || '') };
        if (item.url && !results.some(r => r.url === item.url)) results.push(item);
      }
    }
  }

  return { results: results.slice(0, 5) };
}

function formatSearchContext(query, results) {
  if (!results?.length) return `Public web search was requested for "${query}", but no useful public snippets came back. Say that current details should be verified and answer from general knowledge.`;
  return `Public web search results for "${query}". Use these only as public source snippets. Cite useful links by name/URL when relevant. Do not overstate certainty.\n\n` + results.map((x, i) => `${i + 1}. ${x.title}\n${x.url}\n${x.snippet}`).join('\n\n');
}

async function callModel(messages, toolContext = '') {
  if (!LLM_BASE_URL || !LLM_API_KEY) {
    const last = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const unsafe = /private|secret|credential|file|filesystem|homepc|shell|terminal|discord|send|delete|run code|api key/i.test(last);
    if (unsafe) {
      return 'I can’t access private systems, files, credentials, Discord, shell tools, or customer records in public demo mode. I can show a safe mock example of how an Applied AI Solutions workflow would handle that request with human approval gates.';
    }
    return `Beacon is wired safely, but the live model is not configured yet.\n\nIf this were live, I’d use your note — “${last.slice(0, 180)}” — to map the workflow, suggest approval gates, and recommend a first prototype for Applied AI Solutions to build.`;
  }
  const baseSystem = `${BEACON_SYSTEM_PROMPT}\n\nBeacon workspace files loaded by the adapter:\n${BEACON_WORKSPACE_CONTEXT}`;
  const system = toolContext ? `${baseSystem}\n\nSafe tool context from this request:\n${toolContext}\n\nWhen public web results are supplied for a named company, answer specifically about that company. Do not give a generic industry answer unless sources are weak or missing. Use a short Sources section at the bottom. Avoid phrases like 'provided search results' or 'tool context'.` : baseSystem;
  const response = await fetch(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${LLM_API_KEY}` },
    body: JSON.stringify({ model: LLM_MODEL, temperature: 0.38, max_tokens: 620, messages: [{ role: 'system', content: system }, ...messages] }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error('Beacon model error:', response.status, text.slice(0, 500));
    throw new Error('Model request failed');
  }
  const data = await response.json();
  return polishBeaconReply(data?.choices?.[0]?.message?.content || '') || 'Beacon did not return a usable response.';
}

app.get('/api/beacon/health', (_req, res) => {
  res.json({ ok: true, modelConfigured: Boolean(LLM_BASE_URL && LLM_API_KEY), db: pool ? 'postgres' : 'memory-dev', limit: MESSAGE_LIMIT });
});

app.post('/api/beacon', async (req, res) => {
  try {
    const visitorKey = getVisitorKey(req, res);
    if (rateLimited(visitorKey)) return res.status(429).json({ error: 'Slow down a bit. This is a short public demo.' });
    const usage = await getUsage(visitorKey);
    if (usage.message_count >= MESSAGE_LIMIT) {
      return res.json({ reply: 'You’ve reached the end of this short public demo. If you want to go deeper, request a Free AI Audit and Applied AI Solutions can review your real workflow.', remaining: 0, limitReached: true });
    }
    const messages = sanitizeMessages(req.body?.messages);
    if (!messages.length) return res.status(400).json({ error: 'No message provided.' });
    let toolContext = String(req.body?.toolContext || '').slice(0, 4000);
    let sources = [];
    let usedWebSearch = false;
    if (!toolContext && shouldSearchWeb(messages)) {
      const query = [...messages].reverse().find(m => m.role === 'user')?.content || '';
      const search = await runPublicWebSearch(query);
      sources = search.results || [];
      usedWebSearch = true;
      toolContext = formatSearchContext(query, sources).slice(0, 5000);
    }
    const reply = await callModel(messages, toolContext);
    await incrementUsage(visitorKey);
    const remaining = Math.max(0, MESSAGE_LIMIT - Number(usage.message_count) - 1);
    res.json({ reply, remaining, limitReached: remaining === 0, usedWebSearch, sources });
  } catch (err) {
    console.error('Beacon route error:', err);
    res.status(500).json({ error: 'Beacon server error.' });
  }
});

app.post('/api/beacon/lead', async (req, res) => {
  try {
    const { name, businessName, email, phone, challenge, transcriptSummary } = req.body || {};
    if (!email || typeof email !== 'string' || !email.includes('@')) return res.status(400).json({ error: 'Valid email required.' });
    if (pool) {
      await pool.query(`INSERT INTO beacon_leads (name, business_name, email, phone, challenge, transcript_summary) VALUES ($1,$2,$3,$4,$5,$6)`, [name || null, businessName || null, email, phone || null, challenge || null, transcriptSummary || null]);
    } else {
      memoryLeads.push({ created_at: new Date().toISOString(), name, businessName, email, phone, challenge, transcriptSummary });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Lead route error:', err);
    res.status(500).json({ error: 'Lead capture failed.' });
  }
});

app.post('/api/tools/web-search', async (req, res) => {
  try {
    const visitorKey = getVisitorKey(req, res);
    if (rateLimited(`search:${visitorKey}`, 6)) return res.status(429).json({ error: 'Search limit reached for now.' });
    const query = String(req.body?.query || '').slice(0, 160).trim();
    if (!query) return res.status(400).json({ error: 'Query required.' });
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
    const r = await fetch(url, { headers: { 'user-agent': 'AppliedAISolutions-BeaconDemo/1.0' } });
    const data = await r.json();
    const results = [];
    if (data.AbstractText) results.push({ title: data.Heading || query, url: data.AbstractURL || '', snippet: data.AbstractText });
    for (const topic of data.RelatedTopics || []) {
      if (results.length >= 5) break;
      if (topic.Text && topic.FirstURL) results.push({ title: topic.Text.split(' - ')[0].slice(0, 90), url: topic.FirstURL, snippet: topic.Text.slice(0, 240) });
    }
    res.json({ results });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed.' });
  }
});

app.post('/api/tools/parse-pdf', upload.single('pdf'), async (req, res) => {
  let filePath = req.file?.path;
  try {
    const visitorKey = getVisitorKey(req, res);
    if (rateLimited(`pdf:${visitorKey}`, 3, 10 * 60_000)) return res.status(429).json({ error: 'PDF demo limit reached for now.' });
    if (!req.file) return res.status(400).json({ error: 'PDF file required.' });
    const buffer = await fs.readFile(filePath);
    const parsed = await pdfParse(buffer, { max: 20 });
    const text = String(parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 6000);
    res.json({ filename: req.file.originalname, pages: parsed.numpages || null, text, warning: 'Public demo mode: do not upload confidential files.' });
  } catch (err) {
    console.error('PDF parse error:', err);
    res.status(500).json({ error: 'PDF parsing failed.' });
  } finally {
    if (filePath && fssync.existsSync(filePath)) fs.unlink(filePath).catch(() => {});
  }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`Beacon demo running on :${PORT} | db=${pool ? 'postgres' : 'memory-dev'} | model=${Boolean(LLM_BASE_URL && LLM_API_KEY)}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
