import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import helmet from 'helmet';
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
const PDF_UPLOAD_ENABLED = String(process.env.BEACON_ENABLE_PDF_UPLOAD || '').toLowerCase() === 'true';

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'", 'mailto:'],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use((req, res, next) => {
  const allowedOrigins = new Set([
    'https://appliedai.solutions',
    'https://www.appliedai.solutions',
    'https://beacon.appliedai.solutions',
  ]);
  const origin = req.headers.origin;
  if (allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});
app.use(express.json({ limit: '80kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '5m' : 0,
}));

const uploadDir = process.env.BEACON_UPLOAD_DIR || path.join(__dirname, 'uploads');
await fs.mkdir(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
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

const BEACON_SYSTEM_PROMPT_PATH = process.env.BEACON_SYSTEM_PROMPT_PATH || path.join(__dirname, 'BEACON_SYSTEM_PROMPT.md');
const BEACON_SYSTEM_PROMPT_FALLBACK = `detailed thinking off

You are Beacon, the public AI guide for Applied AI Solutions.

Sound like a real business operator: human, calm, sharp, curious, and useful. Do not expose internal structure as headings unless the visitor asks for a breakdown. Avoid generic AI phrasing, salesy filler, long preambles, and robotic bullets.

Public demo mode only. Do not claim private access, make commitments, quote binding prices, or affect external systems. Keep human approval around customer messages, pricing, commitments, record changes, billing, and sensitive actions.

Applied AI Solutions builds practical AI systems for small businesses: custom agents, workflow automation, dashboards, searchable knowledge bases, document/PDF/OCR automation, data cleanup, approval queues, and owner-facing briefing tools.

Guide good-fit visitors toward a Free AI Audit at info@appliedai.solutions when appropriate.`;

async function loadBeaconSystemPrompt() {
  try {
    return await fs.readFile(BEACON_SYSTEM_PROMPT_PATH, 'utf8');
  } catch (err) {
    console.error(`Could not load Beacon system prompt from ${BEACON_SYSTEM_PROMPT_PATH}:`, err.message);
    return BEACON_SYSTEM_PROMPT_FALLBACK;
  }
}

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
    .filter(m => {
      if (m.role !== 'assistant') return true;
      return !/What the AI system could do|What a human still approves|Simplest next step|I can help map this in plain English without guessing details/i.test(m.content);
    })
    .slice(-10)
    .map(m => ({ role: m.role, content: m.content.slice(0, 1800) }));
}

function polishBeaconReply(text) {
  let cleaned = String(text || '')
    .replace(/```[\s\S]*?```/g, 'Technical implementation detail available on request.')
    .replace(/^\s*-{3,}\s*$/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^\s*(interface|type|const|let|function|return|export|import)\b[^\n]*/gim, '')
    .replace(/\bin just a week\b/gi, 'as a focused first prototype')
    .replace(/\bin a week\b/gi, 'as a focused first prototype')
    .replace(/\bdeliver a working prototype as a focused first prototype\b/gi, 'map the first useful prototype')
    .replace(/\bdeliver a working prototype\b/gi, 'map the first useful prototype')
    .replace(/\bspin up\b/gi, 'build')
    .replace(/\bplugs into\b/gi, 'can connect with')
    .replace(/\bleverag(?:e|ing)\b/gi, 'use')
    .replace(/\busing past proposals, pricing tables, and local water[\u2011-]?use regulations\b/gi, 'using approved business rules and human-reviewed templates')
    .replace(/\bautomatically emailed to the customer\b/gi, 'queued for human approval before sending')
    .replace(/\bproperty size, water source, service requested\b/gi, 'contact info, request type, and any details the customer provides')
    .replace(/\bproperty size, water[\u2011-]?budget, and contact details\b/gi, 'contact info, request type, and any details the customer provides')
    .replace(/\bmaterial list, labor estimate, seasonal pricing\b/gi, 'approved template fields and notes for human review')
    .replace(/\bpipe size, valve type, issue description\b/gi, 'the fields your team chooses to track')
    .replace(/\bwarranty expirations, or water[\u2011-]?usage reports\b/gi, 'follow-up tasks or reports your team already uses')
    .replace(/\bappropriate technician\b/gi, 'right internal reviewer')
    .replace(/\btest this week\b/gi, 'review as a focused first prototype')
    .replace(/\bmatch jobs to crew availability, send calendar invites, and generate reminder texts\b/gi, 'draft scheduling options, reminders, and follow-up tasks for human approval')
    .replace(/\bpermits,? or handwritten notes\b/gi, 'forms, PDFs, or handwritten notes')
    .replace(/\bmaintenance contracts,? or warranty paperwork\b/gi, 'approved internal templates')
    .replace(/\bplant[\u2011-]?type watering guidelines, and pricing tables\b/gi, 'approved SOPs and reference material')
    .replace(/\b2[\u2011-]?acre drip system on sandy soil\b/gi, 'this service scenario')
    .replace(/【[^】]+】/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const demoLooksRaw = /^\s*[\[{]/.test(cleaned) || /"reply"\s*:/.test(cleaned) || /"recommendations"\s*:/.test(cleaned);
  const likelyInventedOps = /\b(past service history|past purchases|regional demand patterns|local climate data|knowledge stuck|messy notes|lost leads|slipping through cracks|I[’']d guess|clearly a lot|back-and-forth between crews|water[\u2011-]?budget|required parts|warranty dates|part numbers|valve|pump maintenance|local water[\u2011-]?regulation|pricing tables|permits|high water[\u2011-]?usage|property size|acre|crew|technician|route|dispatch|automatically adjust|automatically create|assign a technician|labor hours|installation schedule|service appointment)\b/i.test(cleaned);
  if (demoLooksRaw) {
    cleaned = `I can help with that, but I need to keep this in plain English.

Tell me the business type, the repetitive task, and the tools you use today. I can map the cleanest first workflow from there, including where a human should approve messages, pricing, record changes, or anything involving money.`;
  }

  if (likelyInventedOps) {
    const firstParagraph = cleaned.split(/\n\s*\n/)[0]
      .replace(/,?\s*and they employ over 200 staff to handle sales, installations and ongoing maintenance\.?/gi, '.')
      .replace(/\bThey also provide installation and ongoing maintenance services\.?/gi, 'Their public materials point to irrigation, lighting, drainage, water features, turf, and golf-related products.')
      .trim();
    cleaned = `${firstParagraph}

Where Applied AI Solutions could help is the messy handoff between inquiry, product category, quote prep, and follow-up. I’d start with a lead desk that turns a new request into a clean review packet: who the customer is, what they’re asking for, which service/product lane it belongs in, what’s missing, and the next follow-up task.

Nothing customer-facing would go out on its own. Quotes, pricing, commitments, record changes, and sends stay human-approved.

What part of that flow is slowest for you right now: capturing the request, preparing the quote, or keeping follow-up organized?`;
  }

  return cleaned;
}


function shouldSearchWeb(messages) {
  const last = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const asksCurrent = /\b(near me|in my area|around me|local|nearby|current|today|latest|recent|this week|this month|where can i|who offers|requirements?|regulations?|permits?|knoxville|tennessee|tn|source|search|look up|web|website|reviews?|competitors?|who is|who are)\b/i.test(last);
  if (/\b(Applied AI Solutions|AppliedAI|AAS|Beacon)\b/i.test(last) && !asksCurrent) return false;
  const looksNamedEntity = /\b[A-Z][A-Za-z0-9&'.-]+(?:\s+[A-Z][A-Za-z0-9&'.-]+){1,5}\b/.test(last);
  return asksCurrent || looksNamedEntity;
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
  const beaconSystemPrompt = await loadBeaconSystemPrompt();
  const baseSystem = `${beaconSystemPrompt}\n\nBeacon workspace files loaded by the adapter:\n${BEACON_WORKSPACE_CONTEXT}`;
  const system = toolContext ? `${baseSystem}\n\nSafe tool context from this request:\n${toolContext}\n\nWhen public web results are supplied for a named company, answer specifically about that company. Do not give a generic industry answer unless sources are weak or missing. Do not include a Sources section unless the visitor explicitly asks for sources. Avoid phrases like 'provided search results' or 'tool context'.` : baseSystem;
  const response = await fetch(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${LLM_API_KEY}` },
    body: JSON.stringify({ model: LLM_MODEL, temperature: 0.58, max_tokens: 760, messages: [{ role: 'system', content: system }, ...messages] }),
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
  res.json({ ok: true, version: 'audit-sharp-2026-05-07d', modelConfigured: Boolean(LLM_BASE_URL && LLM_API_KEY), db: pool ? 'postgres' : 'memory-dev', limit: MESSAGE_LIMIT });
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
    const currentCount = Number(usage.message_count) || 0;
    const isFinalAllowedMessage = currentCount >= MESSAGE_LIMIT - 1;
    const reply = isFinalAllowedMessage
      ? 'You’ve reached the end of this short public demo. If you want to go deeper, request a Free AI Audit and Applied AI Solutions can map one real workflow from your business.'
      : await callModel(messages, toolContext);
    await incrementUsage(visitorKey);
    const remaining = Math.max(0, MESSAGE_LIMIT - currentCount - 1);
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
    if (!PDF_UPLOAD_ENABLED) return res.status(403).json({ error: 'PDF upload is disabled for the public demo.' });
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
