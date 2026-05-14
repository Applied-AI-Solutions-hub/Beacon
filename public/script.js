const hero = document.querySelector('#hero');
const main = document.querySelector('#main');
const thread = document.querySelector('#thread');
const composerHero = document.querySelector('#composerHero');
const composerBottom = document.querySelector('#composerBottom');
const heroInput = document.querySelector('#heroInput');
const bottomInput = document.querySelector('#bottomInput');
const toolDock = document.querySelector('#toolDock');
const remainingEl = document.querySelector('#remaining');
const modal = document.querySelector('#modal');
const closeModal = document.querySelector('#closeModal');
const leadForm = document.querySelector('#leadForm');
const leadThanks = document.querySelector('#leadThanks');
const searchTool = document.querySelector('#searchTool');
const pdfInput = document.querySelector('#pdfInput');

let messages = [];
let lastToolContext = '';
let locked = false;

function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 150) + 'px'; }
[heroInput, bottomInput].forEach(el => el.addEventListener('input', () => autoGrow(el)));

function enterChat() {
  charExitToCorner();
  hero.classList.add('hidden');
  main.classList.remove('landing');
  composerBottom.classList.remove('hidden');
  toolDock.classList.remove('hidden');
  bottomInput.focus();
}

function scrollDown() { requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })); }

function renderBeaconText(target, content) {
  const lines = String(content || '').replace(/```[\s\S]*?```/g, match => {
    const body = match.replace(/```\w*\n?|```/g, '').trim();
    if (/\b(interface|type|const|let|function|return|=>|export|import)\b/.test(body)) {
      return 'Technical implementation detail available on request.';
    }
    return body;
  }).split('\n');

  let list = null;
  const closeList = () => { list = null; };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }

    const heading = line.match(/^#{1,3}\s+(.+)$/) || line.match(/^\*\*(.+)\*\*:?$/);
    if (heading) {
      closeList();
      const h = document.createElement('h3');
      h.textContent = heading[1].replace(/:$/, '');
      target.append(h);
      continue;
    }

    const bullet = line.match(/^[-*•]\s+(.+)$/);
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (bullet || numbered) {
      const tag = numbered ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = document.createElement(tag);
        target.append(list);
      }
      const li = document.createElement('li');
      li.textContent = (bullet || numbered)[1];
      list.append(li);
      continue;
    }

    closeList();
    const p = document.createElement('p');
    p.textContent = line.replace(/^Beacon:\s*/i, '');
    target.append(p);
  }
}

function addMessage(role, content, extra = '') {
  enterChat();
  const row = document.createElement('div');
  row.className = `msg ${role} ${extra}`;
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? 'U' : 'B';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (role === 'assistant' && !extra.includes('typing')) renderBeaconText(bubble, content);
  else bubble.textContent = content;
  row.append(avatar, bubble);
  thread.append(row);
  scrollDown();
  return row;
}

function openModal() { modal.classList.remove('hidden'); }
function closeModalSoft() { modal.classList.add('hidden'); }
closeModal.addEventListener('click', closeModalSoft);

function setRemaining(n) {
  if (typeof n === 'number') remainingEl.textContent = n > 0 ? `${n} demo messages left` : 'Demo limit reached';
}

async function sendToBeacon(text) {
  const content = text.trim();
  if (!content || locked) return;
  addMessage('user', content);
  messages.push({ role: 'user', content });
  heroInput.value = bottomInput.value = '';
  autoGrow(heroInput); autoGrow(bottomInput);
  const typing = addMessage('assistant', 'Thinking…', 'typing');
  try {
    const response = await fetch('/api/beacon', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages, toolContext: lastToolContext }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Beacon request failed');
    typing.remove();
    addMessage('assistant', data.reply);
    messages.push({ role: 'assistant', content: data.reply });
    setRemaining(data.remaining);
    lastToolContext = '';
    if (data.limitReached) {
      locked = true;
      bottomInput.disabled = true;
      openModal();
    }
  } catch (err) {
    typing.remove();
    addMessage('assistant', `Beacon hit an issue: ${err.message}`);
  }
}

composerHero.addEventListener('submit', (e) => { e.preventDefault(); sendToBeacon(heroInput.value); });
composerBottom.addEventListener('submit', (e) => { e.preventDefault(); sendToBeacon(bottomInput.value); });
[heroInput, bottomInput].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.closest('form').requestSubmit(); }}));
document.querySelectorAll('.chips button').forEach(btn => btn.addEventListener('click', () => sendToBeacon(btn.textContent)));

searchTool.addEventListener('click', async () => {
  const q = prompt('What should Beacon research on the public web?');
  if (!q) return;
  addMessage('user', `Search the web for: ${q}`);
  messages.push({ role: 'user', content: `Search the web for: ${q}` });
  const typing = addMessage('assistant', 'Searching public web…', 'typing');
  try {
    const r = await fetch('/api/tools/web-search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Search failed');
    lastToolContext = `Public web search results for "${q}":\n` + (data.results || []).map((x, i) => `${i+1}. ${x.title}\n${x.url}\n${x.snippet}`).join('\n\n');
    typing.remove();
    await sendToBeacon(`Use the public web search results to answer this and cite useful sources: ${q}`);
  } catch (err) {
    typing.remove();
    addMessage('assistant', `Search issue: ${err.message}`);
  }
});

pdfInput.addEventListener('change', async () => {
  const file = pdfInput.files?.[0];
  if (!file) return;
  if (!confirm('Public demo mode: do not upload private customer, financial, medical, legal, or confidential files. Continue?')) { pdfInput.value=''; return; }
  enterChat();
  addMessage('user', `Parse this PDF: ${file.name}`);
  const typing = addMessage('assistant', 'Reading PDF…', 'typing');
  const form = new FormData();
  form.append('pdf', file);
  try {
    const r = await fetch('/api/tools/parse-pdf', { method: 'POST', body: form });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'PDF parse failed');
    lastToolContext = `Visitor uploaded PDF: ${data.filename}\nPages: ${data.pages}\nExtracted text excerpt:\n${data.text}`;
    messages.push({ role: 'user', content: `I uploaded ${file.name}. Summarize it and tell me what workflow Applied AI Solutions could build from it.` });
    typing.remove();
    await sendToBeacon(`Summarize the uploaded PDF and identify office workflows or automations Applied AI Solutions could build from it.`);
  } catch (err) {
    typing.remove();
    addMessage('assistant', `PDF issue: ${err.message}`);
  } finally {
    pdfInput.value = '';
  }
});

leadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(leadForm);
  const payload = Object.fromEntries(fd.entries());
  payload.transcriptSummary = messages.slice(-8).map(m => `${m.role}: ${m.content}`).join('\n').slice(0, 2000);
  try {
    const r = await fetch('/api/beacon/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Lead capture failed');
    leadForm.classList.add('hidden');
    leadThanks.classList.remove('hidden');
  } catch (err) {
    alert(err.message);
  }
});

fetch('/api/beacon/health').then(r=>r.json()).then(data => {
  setRemaining(data.limit);
  if (!data.modelConfigured) console.warn('Beacon model not configured yet. Add LLM_BASE_URL, LLM_API_KEY, LLM_MODEL.');
}).catch(()=>{});

// ===== BEACON CHARACTER INTRO =====
const charLayer   = document.querySelector('#charLayer');
const charBubble  = document.querySelector('#charBubble');
const charBubbleText = document.querySelector('#charBubbleText');
let charExited = false;

const DIALOGUES = [
  "Hey! I'm Beacon. 👋",
  "I can show you what AI could do\nfor your business.",
  "Type a question below, or tap one\nof the example prompts. ↓",
];

// Typewriter effect — resolves after text finishes + short hold
function typeText(el, text, speed = 38) {
  return new Promise(resolve => {
    el.textContent = '';
    // Add blinking cursor
    const cursor = document.createElement('span');
    cursor.className = 'char-cursor';
    el.parentNode.insertBefore(cursor, el.nextSibling);
    let i = 0;
    const tick = () => {
      if (charExited) { cursor.remove(); resolve(); return; }
      if (i < text.length) {
        el.textContent += text[i++];
        setTimeout(tick, speed);
      } else {
        setTimeout(() => { cursor.remove(); resolve(); }, 1100);
      }
    };
    tick();
  });
}

function showBubble() { charBubble.classList.add('visible'); }
function hideBubble()  { charBubble.classList.remove('visible'); }

async function runCharacterIntro() {
  await new Promise(r => setTimeout(r, 700));
  if (charExited) return;

  // Walk onto the screen
  charLayer.classList.add('char-in', 'char-walking');
  await new Promise(r => setTimeout(r, 1500));
  if (charExited) return;

  // Stop walking, switch to idle float
  charLayer.classList.remove('char-walking');
  charLayer.classList.add('char-idle');
  await new Promise(r => setTimeout(r, 350));

  // Run through each dialogue line
  for (const line of DIALOGUES) {
    if (charExited) return;
    showBubble();
    await typeText(charBubbleText, line, 36);
    if (charExited) return;
    hideBubble();
    await new Promise(r => setTimeout(r, 400));
  }

  // Stay idle with no bubble — waiting for user to type
}

function charExitToCorner() {
  if (charExited) return;
  charExited = true;
  hideBubble();
  charLayer.classList.remove('char-idle', 'char-walking');

  // Quick wave + send-off message
  charLayer.classList.add('char-waving');
  charBubbleText.textContent = "Let's go! 🚀";
  showBubble();

  setTimeout(() => {
    hideBubble();
    charLayer.classList.remove('char-waving');
    charLayer.classList.add('char-idle', 'char-gone');
  }, 1100);
}

runCharacterIntro();
