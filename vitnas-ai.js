/**
 * vitnas-ai.js
 * Intent detection, module routing, API relay, Vault, Persona Key, free tier.
 *
 * Architecture:
 *   - All AI API calls go through /api/relay.js (server-side, no CORS issues)
 *   - User API keys stored ONLY in localStorage — never sent to relay unless needed
 *   - Supabase vault save/load uses the same credentials as Witness Vault
 *   - Free tier: 10 requests/day tracked in localStorage
 */

'use strict';

// ── Config ────────────────────────────────────────────────
const CFG = {
  FREE_DAILY_LIMIT: 10,
  FREE_MODEL: 'gemini-1.5-flash-002',
  RELAY_URL: '/api/relay',
  DFBSS_URL: '/api/dfbss',
  SUPABASE_URL: 'https://ylgyycaiijdakoyahrms.supabase.co',
  SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlsZ3l5Y2FpaWpkYWtveWFocm1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwODI1OTAsImV4cCI6MjA5NDY1ODU5MH0.dNthZdmuTtEzo0Mt3IauvCM5PzMmqcaDTM1tdHwSUBI',
};

// ── State ─────────────────────────────────────────────────
const STATE = {
  messages: [],       // { role, content }
  personaKey: null,
  sessionName: null,
};

// ── DOM refs ──────────────────────────────────────────────
const chatArea     = document.getElementById('chat-area');
const msgInput     = document.getElementById('msg-input');
const sendBtn      = document.getElementById('send-btn');
const modelSelect  = document.getElementById('model-select');
const verbosity    = document.getElementById('verbosity');
const apiKeyInput  = document.getElementById('api-key-input');
const tokenDisplay = document.getElementById('token-display');
const tokenOrig    = document.getElementById('token-orig');
const tokenComp    = document.getElementById('token-comp');
const tokenSave    = document.getElementById('token-save');
const tierBadge    = document.getElementById('tier-badge');
const tierCount    = document.getElementById('tier-count');
const inputMeta    = document.getElementById('input-meta');

// ── Init ──────────────────────────────────────────────────
(function init() {
  loadPersonaKey();
  updateTierDisplay();

  // Restore saved API key
  const saved = localStorage.getItem('vitnas_api_key');
  if (saved) apiKeyInput.value = saved;

  // Save API key on input
  apiKeyInput.addEventListener('input', function() {
    if (apiKeyInput.value.trim()) {
      localStorage.setItem('vitnas_api_key', apiKeyInput.value.trim());
    } else {
      localStorage.removeItem('vitnas_api_key');
    }
  });

  // Send on Enter (Shift+Enter = newline)
  msgInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // Auto-resize textarea
  msgInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    updateInputMeta();
  });

  sendBtn.addEventListener('click', handleSend);

  // Persona modal
  document.getElementById('persona-btn').addEventListener('click', function() {
    openPersonaModal();
  });
  document.getElementById('modal-close').addEventListener('click', closePersonaModal);
  document.getElementById('pk-save').addEventListener('click', savePersonaKey);
  document.getElementById('pk-download').addEventListener('click', downloadPersonaKey);
  document.getElementById('pk-clear').addEventListener('click', clearPersonaKey);

  // Close modal on overlay click
  document.getElementById('persona-modal').addEventListener('click', function(e) {
    if (e.target === this) closePersonaModal();
  });
})();

// ── Token estimation ──────────────────────────────────────
// Rough estimate: 1 token ≈ 4 characters
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function updateInputMeta() {
  const text = msgInput.value;
  if (!text.trim()) { inputMeta.textContent = ''; return; }
  const est = estimateTokens(text);
  inputMeta.textContent = '~' + est + ' tokens';
}

// ── Compression ───────────────────────────────────────────
// Lightweight prompt compression: removes filler words and reduces whitespace.
// Honest about what it is — not a WASM library, a practical helper.
const FILLER = [
  /\bplease\b/gi, /\bkindly\b/gi, /\bjust\b/gi, /\bbasically\b/gi,
  /\bactually\b/gi, /\bvery\b/gi, /\breally\b/gi, /\bquite\b/gi,
  /\bsomewhat\b/gi, /\byou know\b/gi, /\bI would like to\b/gi,
  /\bcould you\b/gi, /\bwould you\b/gi, /\bcan you\b/gi,
  /\bI was wondering\b/gi, /\bif you don't mind\b/gi,
];

function compress(text) {
  let c = text;
  FILLER.forEach(function(r) { c = c.replace(r, ''); });
  c = c.replace(/\s{2,}/g, ' ').trim();
  return c;
}

function showTokenStats(original, compressed) {
  const origT = estimateTokens(original);
  const compT = estimateTokens(compressed);
  const saved = origT - compT;
  const pct   = origT > 0 ? Math.round((saved / origT) * 100) : 0;

  tokenOrig.textContent  = origT;
  tokenComp.textContent  = compT;
  tokenSave.textContent  = saved > 0 ? '(' + pct + '% saved)' : '';
  tokenDisplay.style.display = 'flex';
}

// ── Intent detection ──────────────────────────────────────
const INTENTS = [
  { name: 'audit',      pattern: /\baudit\b/i },
  { name: 'save',       pattern: /\bsave\b/i },
  { name: 'load',       pattern: /\bload\b|\bretrieve\b|\bfetch memories\b/i },
  { name: 'strategy',   pattern: /\bstrategy\b|\bstrategic\b|\bplan\b/i },
  { name: 'benchmark',  pattern: /\bbenchmark\b|\bintegrity test\b|\bdfbss\b/i },
  { name: 'remember',   pattern: /\bremember me\b|\bpersona key\b|\bsave identity\b/i },
  { name: 'mission',    pattern: /\bmission\b/i },
  { name: 'memory',     pattern: /\bmemory\b|\bmemories\b/i },
];

function detectIntent(text) {
  for (var i = 0; i < INTENTS.length; i++) {
    if (INTENTS[i].pattern.test(text)) return INTENTS[i].name;
  }
  return 'chat';
}

// ── Free tier ─────────────────────────────────────────────
function getTodayKey() {
  return 'vitnas_free_' + new Date().toISOString().split('T')[0];
}

function getFreeCount() {
  return parseInt(localStorage.getItem(getTodayKey()) || '0', 10);
}

function incrementFreeCount() {
  const k = getTodayKey();
  const n = getFreeCount() + 1;
  localStorage.setItem(k, String(n));
  updateTierDisplay();
  return n;
}

function updateTierDisplay() {
  const apiKey = localStorage.getItem('vitnas_api_key');
  if (apiKey) {
    tierBadge.textContent = 'BYOK · Unlimited';
    return;
  }
  const used = getFreeCount();
  const left = Math.max(0, CFG.FREE_DAILY_LIMIT - used);
  tierCount.textContent = left;
  tierBadge.innerHTML = 'Free · <span id="tier-count">' + left + '</span> left today';
}

function canSendFree() {
  const apiKey = localStorage.getItem('vitnas_api_key');
  if (apiKey) return true;
  return getFreeCount() < CFG.FREE_DAILY_LIMIT;
}

// ── Message rendering ─────────────────────────────────────
function clearWelcome() {
  const w = chatArea.querySelector('.welcome');
  if (w) w.remove();
}

function addMessage(role, content, meta) {
  clearWelcome();
  const div = document.createElement('div');
  div.className = 'msg ' + role;

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = content;
  div.appendChild(bubble);

  if (meta) {
    const m = document.createElement('div');
    m.className = 'msg-meta';
    m.textContent = meta;
    div.appendChild(m);
  }

  chatArea.appendChild(div);
  scrollToBottom();
  return bubble;
}

function addSystemMsg(text) {
  clearWelcome();
  const div = document.createElement('div');
  div.className = 'msg system';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;
  div.appendChild(bubble);
  chatArea.appendChild(div);
  scrollToBottom();
}

function addErrorMsg(text) {
  clearWelcome();
  const div = document.createElement('div');
  div.className = 'msg error';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;
  div.appendChild(bubble);
  chatArea.appendChild(div);
  scrollToBottom();
}

function addResultCard(title, rows, metrics) {
  clearWelcome();
  const div = document.createElement('div');
  div.className = 'msg assistant';

  const card = document.createElement('div');
  card.className = 'result-card';

  const t = document.createElement('div');
  t.className = 'rc-title';
  t.textContent = title;
  card.appendChild(t);

  if (metrics && metrics.length) {
    const mr = document.createElement('div');
    mr.className = 'metric-row';
    metrics.forEach(function(m) {
      const box = document.createElement('div');
      box.className = 'metric-box';
      box.innerHTML = '<div class="mv">' + esc(String(m.value)) + '</div><div class="ml">' + esc(m.label) + '</div>';
      mr.appendChild(box);
    });
    card.appendChild(mr);
  }

  if (rows && rows.length) {
    rows.forEach(function(r) {
      const row = document.createElement('div');
      row.className = 'rc-row';
      row.innerHTML = '<span class="rc-key">' + esc(r.key) + '</span><span class="rc-val">' + esc(r.value) + '</span>';
      card.appendChild(row);
    });
  }

  div.appendChild(card);
  chatArea.appendChild(div);
  scrollToBottom();
}

function addTyping() {
  clearWelcome();
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.id = 'typing-indicator';
  div.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
  chatArea.appendChild(div);
  scrollToBottom();
  return div;
}

function removeTyping() {
  const t = document.getElementById('typing-indicator');
  if (t) t.remove();
}

function scrollToBottom() {
  chatArea.scrollTop = chatArea.scrollHeight;
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Main send handler ─────────────────────────────────────
async function handleSend() {
  const text = msgInput.value.trim();
  if (!text) return;
  if (!canSendFree()) {
    addErrorMsg('Daily free limit reached (10/day). Add your API key above to continue without limits.');
    return;
  }

  const compressed = compress(text);
  showTokenStats(text, compressed);

  msgInput.value = '';
  msgInput.style.height = 'auto';
  inputMeta.textContent = '';
  sendBtn.disabled = true;

  addMessage('user', text, '');
  STATE.messages.push({ role: 'user', content: compressed });

  const intent = detectIntent(text);
  const typing = addTyping();

  try {
    switch (intent) {
      case 'audit':     await handleAudit(text); break;
      case 'save':      await handleSave(text); break;
      case 'load':      await handleLoad(); break;
      case 'strategy':  await handleStrategy(text); break;
      case 'benchmark': await handleBenchmark(); break;
      case 'remember':  handleRememberMe(); break;
      default:          await handleChat(compressed); break;
    }

    if (intent !== 'remember' && intent !== 'load' && intent !== 'save') {
      incrementFreeCount();
    }
  } catch (err) {
    removeTyping();
    addErrorMsg('Something went wrong: ' + (err.message || 'Unknown error'));
  } finally {
    sendBtn.disabled = false;
    removeTyping();
  }
}

// ── Chat handler ──────────────────────────────────────────
async function handleChat(prompt) {
  const model = modelSelect.value;
  const apiKey = localStorage.getItem('vitnas_api_key') || '';
  const vLen = parseInt(verbosity.value, 10);
  const lenHint = vLen === 1 ? 'Be very concise. One paragraph maximum.' : vLen === 3 ? 'Be thorough and detailed.' : 'Be clear and reasonably concise.';

  const systemPrompt = buildSystemPrompt() + ' ' + lenHint;

  const res = await callRelay({ model, apiKey, system: systemPrompt, messages: STATE.messages });

  removeTyping();

  if (res.error) { addErrorMsg(res.error); return; }

  const reply = res.content;
  STATE.messages.push({ role: 'assistant', content: reply });
  addMessage('assistant', reply, model);
}

// ── Audit handler ─────────────────────────────────────────
async function handleAudit(text) {
  removeTyping();
  addSystemMsg('Delta-First Audit · Routing to analysis framework...');

  // Extract claim from message
  const claim = text.replace(/audit\s*/i, '').trim() || text;

  const payload = {
    auditor_id: getPersonaId(),
    audit_id: 'audit_' + Date.now(),
    integrity_score: 84.0,
    protocol_mode: 'Full Protocol Mode',
    primary_driver: 'H1',
    reasoning_trace: claim,
    peak_moment: 'Not specified.',
    interpretive_anchor: 'General.',
    h3_warrant: 'Not specified.',
    null_test: 'No.',
    label_impact: 'Harder',
    friction_score_components: { base: 0.50, lens_divergence: 0.14, warrant_ambiguity: 0.08, validation_confidence: 0.05 },
    friction_score: 0.50,
    mcl_coefficient: 0.75,
    boundary: 'No boundary stated.'
  };

  try {
    const res = await fetch('https://delta-first-backend-clean-production.up.railway.app/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    addResultCard(
      'Delta-First Audit Result',
      [
        { key: 'Claim', value: claim },
        { key: 'Confidence', value: data.confidence || '—' },
        { key: 'Explanation', value: data.explanation || '—' },
        { key: 'Validated at', value: (data.validated_at || '').split('T')[0] },
      ],
      [
        { value: (data.mcl_coefficient || 0).toFixed(2), label: 'Evidence' },
        { value: (data.friction_score || 0).toFixed(2),  label: 'Friction' },
        { value: data.valid ? '✓' : '✗',                label: 'Valid' },
      ]
    );
  } catch (e) {
    addErrorMsg('Audit backend unreachable. Check your connection.');
  }
}

// ── Strategy handler ──────────────────────────────────────
async function handleStrategy(text) {
  const topic = text.replace(/strategy|strategic|plan/gi, '').trim() || text;
  const model  = modelSelect.value;
  const apiKey = localStorage.getItem('vitnas_api_key') || '';

  const prompt = 'Generate a strategic analysis for: "' + topic + '". Output as JSON with exactly these keys: mission, obstacles, resources, next_actions. Each value should be a concise string or array of strings. No markdown.';

  const res = await callRelay({
    model, apiKey,
    system: 'You are a strategic analyst. Output only valid JSON. No markdown fences.',
    messages: [{ role: 'user', content: prompt }]
  });

  removeTyping();

  if (res.error) { addErrorMsg(res.error); return; }

  let parsed;
  try {
    const clean = res.content.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch (e) {
    addMessage('assistant', res.content, model);
    return;
  }

  addResultCard(
    'StrategOS — Strategic Analysis',
    [
      { key: 'Mission',      value: Array.isArray(parsed.mission)      ? parsed.mission.join(', ')      : (parsed.mission      || '—') },
      { key: 'Obstacles',    value: Array.isArray(parsed.obstacles)    ? parsed.obstacles.join('; ')    : (parsed.obstacles    || '—') },
      { key: 'Resources',    value: Array.isArray(parsed.resources)    ? parsed.resources.join(', ')    : (parsed.resources    || '—') },
      { key: 'Next actions', value: Array.isArray(parsed.next_actions) ? parsed.next_actions.join(' · ') : (parsed.next_actions || '—') },
    ],
    null
  );

  STATE.messages.push({ role: 'assistant', content: JSON.stringify(parsed) });
}

// ── Benchmark handler ─────────────────────────────────────
async function handleBenchmark() {
  removeTyping();
  addSystemMsg('DFBSS Benchmark · Running integrity test...');

  try {
    const res = await fetch(CFG.DFBSS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: modelSelect.value }) });
    const data = await res.json();

    addResultCard(
      'DFBSS Benchmark Result',
      [
        { key: 'Model', value: modelSelect.value },
        { key: 'Confidence', value: data.confidence || '—' },
        { key: 'Explanation', value: data.explanation || '—' },
      ],
      [
        { value: data.integrity_score || '—', label: 'Integrity' },
        { value: (data.score_breakdown && data.score_breakdown.mcl ? data.score_breakdown.mcl : '—'), label: 'MCL' },
        { value: (data.score_breakdown && data.score_breakdown.friction ? data.score_breakdown.friction : '—'), label: 'Friction' },
      ]
    );
  } catch (e) {
    addErrorMsg('Benchmark endpoint unreachable.');
  }
}

// ── Save handler ──────────────────────────────────────────
async function handleSave(text) {
  removeTyping();

  const token = localStorage.getItem('vitnas_token');
  if (!token) {
    addErrorMsg('You must be logged in to save memories. Visit vitnas.org/login first.');
    return;
  }

  const title = text.replace(/save\s*/i, '').trim() || ('Session · ' + new Date().toLocaleString());
  const content = JSON.stringify(STATE.messages);

  try {
    const res = await fetch('/api/memory/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ title, type: 'json', content })
    });
    const data = await res.json();
    if (data.success) {
      addSystemMsg('Memory saved — "' + title + '"');
    } else {
      addErrorMsg(data.error || 'Could not save memory.');
    }
  } catch (e) {
    addErrorMsg('Vault unreachable. Check your connection.');
  }
}

// ── Load handler ──────────────────────────────────────────
async function handleLoad() {
  removeTyping();

  const token = localStorage.getItem('vitnas_token');
  if (!token) {
    addErrorMsg('You must be logged in to load memories. Visit vitnas.org/login first.');
    return;
  }

  try {
    const res = await fetch('/api/memory/list', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    if (data.memories && data.memories.length > 0) {
      addResultCard(
        'Vault Memories',
        data.memories.slice(0, 10).map(function(m) {
          return { key: m.created_at.split('T')[0], value: m.title + ' [' + m.type + ']' };
        }),
        null
      );
    } else {
      addSystemMsg('No memories found in your vault.');
    }
  } catch (e) {
    addErrorMsg('Vault unreachable. Check your connection.');
  }
}

// ── Remember Me handler ───────────────────────────────────
function handleRememberMe() {
  removeTyping();
  openPersonaModal();
  addSystemMsg('Persona Key modal opened. Fill in your identity and save.');
}

// ── API Relay call ────────────────────────────────────────
async function callRelay({ model, apiKey, system, messages }) {
  try {
    const res = await fetch(CFG.RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, apiKey, system, messages })
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Relay error ' + res.status };
    return data;
  } catch (e) {
    return { error: 'Relay unreachable: ' + e.message };
  }
}

// ── System prompt builder ─────────────────────────────────
function buildSystemPrompt() {
  let base = 'You are Vitnas AI, a sovereign reasoning partner. You are direct, disciplined, and precise. You do not add filler. You help with analysis, strategy, and structured thinking.';
  if (STATE.personaKey) {
    base += ' The user is ' + (STATE.personaKey.name || 'unknown') + ' (ID: ' + (STATE.personaKey.user_id || 'unknown') + ').';
  }
  return base;
}

function getPersonaId() {
  return STATE.personaKey ? (STATE.personaKey.user_id || 'vitnas-public') : 'vitnas-public';
}

// ── Persona Key ───────────────────────────────────────────
function loadPersonaKey() {
  try {
    const raw = localStorage.getItem('vitnas_persona_key');
    if (raw) {
      STATE.personaKey = JSON.parse(raw);
      addSystemMsg('Persona Key loaded · Welcome back, ' + (STATE.personaKey.name || 'Architect'));
    }
  } catch (e) {
    localStorage.removeItem('vitnas_persona_key');
  }
}

function openPersonaModal() {
  const modal = document.getElementById('persona-modal');
  if (STATE.personaKey) {
    document.getElementById('pk-name').value   = STATE.personaKey.name   || '';
    document.getElementById('pk-userid').value = STATE.personaKey.user_id || '';
  }
  modal.style.display = 'flex';
}

function closePersonaModal() {
  document.getElementById('persona-modal').style.display = 'none';
}

function savePersonaKey() {
  const name   = document.getElementById('pk-name').value.trim();
  const userId = document.getElementById('pk-userid').value.trim();
  if (!name) { document.getElementById('pk-status').textContent = 'Name is required.'; return; }

  STATE.personaKey = {
    name,
    user_id: userId || ('VN-' + name.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8) + '-' + Date.now().toString(36).toUpperCase()),
    created: new Date().toISOString(),
    protocol: 'TRACEBIND_v2.0'
  };

  localStorage.setItem('vitnas_persona_key', JSON.stringify(STATE.personaKey));
  document.getElementById('pk-status').textContent = 'Saved · ' + STATE.personaKey.user_id;
}

function downloadPersonaKey() {
  if (!STATE.personaKey) { savePersonaKey(); }
  if (!STATE.personaKey) return;
  const blob = new Blob([JSON.stringify(STATE.personaKey, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'vitnas-persona-key.json';
  a.click(); URL.revokeObjectURL(url);
}

function clearPersonaKey() {
  STATE.personaKey = null;
  localStorage.removeItem('vitnas_persona_key');
  document.getElementById('pk-name').value   = '';
  document.getElementById('pk-userid').value = '';
  document.getElementById('pk-status').textContent = 'Cleared.';
}
