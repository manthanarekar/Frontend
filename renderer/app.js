'use strict';
/* ═══════════════════════════════════════════════════════════════
   WatiAlternative — renderer/app.js
   All UI logic: session management, messaging, polling, toasts.
   Talks to the Node/Baileys backend at https://server-2aeo.onrender.com
   No browser / Chrome needed — pure WebSocket backend.
   ═══════════════════════════════════════════════════════════════ */

const API = 'https://server-2aeo.onrender.com';
const COOLDOWN_S = 3;

/* ── state ────────────────────────────────────────────────────── */
const state = {
  sessions:   {},   // { label: { account, status, error } }
  selected:   null, // currently selected account label
  messages:   {},   // { label: [ { to, text, ok, error, time } ] }
  pollTimer:  null,
  onCooldown: false,
};

/* ═══════════════════════════════════════════════════════════════
   API helpers
   ═══════════════════════════════════════════════════════════════ */
async function apiCall(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(`${API}${path}`, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(json.detail || `HTTP ${res.status}`);
  return json;
}

/* ═══════════════════════════════════════════════════════════════
   DOM references (cached once)
   ═══════════════════════════════════════════════════════════════ */
const $ = id => document.getElementById(id);

const els = {
  splash:          $('splash'),
  splashMsg:       $('splash-msg'),
  app:             $('app'),
  sessionsList:    $('sessions-list'),
  emptySessions:   $('empty-sessions'),
  searchInput:     $('search-input'),

  welcome:         $('welcome'),
  chatPanel:       $('chat-panel'),
  chatAvatar:      $('chat-avatar'),
  chatAccountName: $('chat-account-name'),
  chatStatusDot:   $('chat-status-dot'),
  chatStatusText:  $('chat-status-text'),
  qrPanel:         $('qr-panel'),
  qrImgWrap:       $('qr-img-wrap'),
  messageLog:      $('message-log'),

  toInput:         $('to-input'),
  msgInput:        $('msg-input'),
  sendBtn:         $('send-btn'),
  cooldownWrap:    $('cooldown-wrap'),
  cooldownFill:    $('cooldown-fill'),
  cooldownLabel:   $('cooldown-label'),

  modalOverlay:    $('modal-overlay'),
  accountInput:    $('account-input'),
  toasts:          $('toasts'),
};

/* ═══════════════════════════════════════════════════════════════
   SPLASH / startup
   ═══════════════════════════════════════════════════════════════ */
// ── Self-contained startup: renderer polls /health directly ───────────────
// This avoids IPC race conditions where the message arrives before the
// listener is registered.
(async function waitForServer() {
  const dots = ['   ', '.  ', '.. ', '...'];
  let i = 0;
  const dotTimer = setInterval(() => {
    els.splashMsg.textContent = 'Starting API server' + dots[i++ % 4];
  }, 400);

  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`${API}/health`);
      if (res.ok) {
        clearInterval(dotTimer);
        els.splashMsg.textContent = 'Connected!';
        setTimeout(showApp, 400);
        return;
      }
    } catch { /* server not ready yet — keep polling */ }
    await new Promise(r => setTimeout(r, 1000));
  }

  // 60 s timeout
  clearInterval(dotTimer);
  els.splashMsg.textContent = 'Server did not start. Open DevTools (Ctrl+Shift+I) for details.';
  els.splashMsg.style.color = '#e53e3e';
})();

// Still listen for crash signal from main process
window.electronAPI.onApiStatus(status => {
  if (status === 'crashed') {
    els.splashMsg.textContent = 'Server crashed unexpectedly.';
    els.splashMsg.style.color = '#e53e3e';
  }
});

function showApp() {
  els.splash.classList.add('fade-out');
  setTimeout(() => els.splash.classList.add('hidden'), 400);
  els.app.classList.remove('hidden');
  init();
}

/* ═══════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════ */
async function init() {
  await loadSessions();
  startPolling();
  bindEvents();
}

/* ═══════════════════════════════════════════════════════════════
   SESSIONS — load & render
   ═══════════════════════════════════════════════════════════════ */
async function loadSessions() {
  try {
    const list = await apiCall('GET', '/sessions');
    state.sessions = {};
    for (const s of list) state.sessions[s.account] = s;
    renderSessions();
  } catch (e) {
    toast('Failed to load sessions: ' + e.message, 'error');
  }
}

function renderSessions(filter = '') {
  const labels = Object.keys(state.sessions)
    .filter(l => l.toLowerCase().includes(filter.toLowerCase()));

  // Remove old cards, keep empty-state div
  const existing = els.sessionsList.querySelectorAll('.session-card');
  existing.forEach(n => n.remove());

  if (labels.length === 0) {
    els.emptySessions.classList.remove('hidden');
    return;
  }
  els.emptySessions.classList.add('hidden');

  for (const label of labels) {
    const s = state.sessions[label];
    const card = buildSessionCard(s);
    els.sessionsList.appendChild(card);
  }
}

function buildSessionCard(s) {
  const card = document.createElement('div');
  card.className = 'session-card' + (s.account === state.selected ? ' active' : '');
  card.dataset.account = s.account;

  const initials = s.account.slice(0, 2).toUpperCase();
  const badgeClass = statusToBadge(s.status);
  const badgeLabel = statusToLabel(s.status);

  card.innerHTML = `
    <div class="session-avatar">${initials}</div>
    <div class="session-info">
      <div class="session-name">${esc(s.account)}</div>
      <div class="session-meta">
        <span class="badge ${badgeClass}">
          <span class="badge-dot"></span>${badgeLabel}
        </span>
      </div>
    </div>
    <button class="btn-delete-session" data-account="${esc(s.account)}" title="Close session">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>`;

  card.addEventListener('click', e => {
    if (e.target.closest('.btn-delete-session')) return;
    selectSession(s.account);
  });
  card.querySelector('.btn-delete-session').addEventListener('click', () => confirmClose(s.account));

  return card;
}

/* ═══════════════════════════════════════════════════════════════
   SELECT SESSION
   ═══════════════════════════════════════════════════════════════ */
function selectSession(label) {
  state.selected = label;
  renderSessions(els.searchInput.value);

  const s = state.sessions[label];
  els.welcome.classList.add('hidden');
  els.chatPanel.classList.remove('hidden');

  // Reset QR wrap to spinner when switching sessions
  els.qrImgWrap.innerHTML = `<div class="qr-spinner"></div>`;
  clearTimeout(qrPollTimer);

  // Header
  els.chatAvatar.textContent      = label.slice(0, 2).toUpperCase();
  els.chatAccountName.textContent = label;
  updateChatStatus(s.status);

  // Messages
  renderMessages(label);
}

function updateChatStatus(status) {
  els.chatStatusDot.className    = `status-dot ${statusToDot(status)}`;
  els.chatStatusText.textContent = statusToLabel(status);

  const isReady = status === 'ready';
  els.sendBtn.disabled  = !isReady || state.onCooldown;
  els.toInput.disabled  = !isReady;
  els.msgInput.disabled = !isReady;

  // Show QR panel or message log
  if (status === 'waiting_qr' || status === 'starting') {
    els.qrPanel.classList.remove('hidden');
    els.messageLog.classList.add('hidden');
    if (status === 'waiting_qr') fetchAndShowQR(state.selected);
  } else {
    els.qrPanel.classList.add('hidden');
    els.messageLog.classList.remove('hidden');
  }
}

// ── QR image fetch ────────────────────────────────────────────────────────
let qrPollTimer = null;

function fetchAndShowQR(label) {
  clearTimeout(qrPollTimer);
  if (!label || state.sessions[label]?.status !== 'waiting_qr') return;

  apiCall('GET', `/sessions/${label}/qr`)
    .then(data => {
      if (data.qr && state.selected === label) {
        // Replace spinner with actual QR image
        els.qrImgWrap.innerHTML = `<img src="${data.qr}" alt="WhatsApp QR code" />`;
      }
    })
    .catch(() => { /* QR not ready yet — retry */ })
    .finally(() => {
      // Keep polling until session becomes ready
      if (state.selected === label && state.sessions[label]?.status === 'waiting_qr') {
        qrPollTimer = setTimeout(() => fetchAndShowQR(label), 3000);
      }
    });
}

/* ═══════════════════════════════════════════════════════════════
   MESSAGES
   ═══════════════════════════════════════════════════════════════ */
function renderMessages(label) {
  els.messageLog.innerHTML = '';
  const msgs = state.messages[label] || [];
  if (msgs.length === 0) {
    els.messageLog.innerHTML =
      `<div class="msg-system">No messages sent yet in this session.</div>`;
    return;
  }
  for (const m of msgs) els.messageLog.appendChild(buildBubble(m));
  scrollLog();
}

function buildBubble(m) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-bubble' + (m.ok ? '' : ' error-bubble');

  const time = new Date(m.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const tick = m.ok
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#53bdeb" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c53030" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

  wrap.innerHTML = `
    <div class="msg-to">${esc(m.to)}</div>
    <div class="msg-text">${esc(m.text)}</div>
    ${!m.ok ? `<div class="msg-text" style="color:#c53030;font-size:12px;margin-top:3px">${esc(m.error)}</div>` : ''}
    <div class="msg-meta">
      <span class="msg-time">${time}</span>
      <span class="msg-tick">${tick}</span>
    </div>`;
  return wrap;
}

function addMessage(label, m) {
  if (!state.messages[label]) state.messages[label] = [];
  state.messages[label].push(m);
  if (state.selected === label) {
    const empty = els.messageLog.querySelector('.msg-system');
    if (empty) empty.remove();
    els.messageLog.appendChild(buildBubble(m));
    scrollLog();
  }
}

function scrollLog() {
  els.messageLog.scrollTop = els.messageLog.scrollHeight;
}

/* ═══════════════════════════════════════════════════════════════
   SEND
   ═══════════════════════════════════════════════════════════════ */
async function sendMessage() {
  const to  = els.toInput.value.trim();
  const msg = els.msgInput.value.trim();

  if (!to)  { toast('Enter a recipient number.', 'warn'); return; }
  if (!msg) { toast('Message cannot be empty.',  'warn'); return; }

  const account = state.selected;
  els.sendBtn.disabled = true;
  els.sendBtn.innerHTML = `<span class="splash-spinner" style="width:16px;height:16px;border-width:2px"></span> Sending…`;

  try {
    const res = await apiCall('POST', '/send', { account, to, message: msg });
    addMessage(account, { to, text: msg, ok: res.ok, error: res.error, time: Date.now() });

    if (res.ok) {
      toast(`Sent to ${to}`, 'success');
      els.msgInput.value = '';
      startCooldown(COOLDOWN_S);
    } else {
      toast('Send failed: ' + res.error, 'error');
      resetSendBtn();
    }
  } catch (e) {
    toast('Send error: ' + e.message, 'error');
    resetSendBtn();
  }
}

function resetSendBtn() {
  els.sendBtn.disabled = false;
  els.sendBtn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg> Send`;
}

/* ═══════════════════════════════════════════════════════════════
   COOLDOWN BAR
   ═══════════════════════════════════════════════════════════════ */
function startCooldown(seconds) {
  state.onCooldown = true;
  els.sendBtn.disabled = true;
  resetSendBtn();
  els.cooldownWrap.classList.remove('hidden');

  const total = seconds * 1000;
  const start = Date.now();

  const tick = () => {
    const elapsed  = Date.now() - start;
    const remaining = Math.max(0, total - elapsed);
    const pct      = (remaining / total) * 100;

    els.cooldownFill.style.width  = pct + '%';
    els.cooldownLabel.textContent = (remaining / 1000).toFixed(1) + 's';

    if (remaining > 0) {
      requestAnimationFrame(tick);
    } else {
      els.cooldownWrap.classList.add('hidden');
      state.onCooldown = false;
      if (state.selected && state.sessions[state.selected]?.status === 'ready') {
        els.sendBtn.disabled = false;
      }
    }
  };
  requestAnimationFrame(tick);
}

/* ═══════════════════════════════════════════════════════════════
   NEW SESSION
   ═══════════════════════════════════════════════════════════════ */
function openModal() {
  els.accountInput.value = '';
  els.modalOverlay.classList.remove('hidden');
  setTimeout(() => els.accountInput.focus(), 50);
}

function closeModal() {
  els.modalOverlay.classList.add('hidden');
}

async function createSession() {
  const label = els.accountInput.value.trim();
  if (!label) { toast('Enter an account label.', 'warn'); return; }
  if (state.sessions[label]) { toast(`"${label}" already exists.`, 'warn'); return; }

  closeModal();

  try {
    const s = await apiCall('POST', '/sessions', { account: label });
    state.sessions[label] = s;
    renderSessions(els.searchInput.value);
    selectSession(label);
    toast(`Session "${label}" started. Open Chrome and scan the QR.`, 'info');
  } catch (e) {
    toast('Could not create session: ' + e.message, 'error');
  }
}

/* ═══════════════════════════════════════════════════════════════
   CLOSE SESSION
   ═══════════════════════════════════════════════════════════════ */
async function confirmClose(label) {
  // Simple inline confirm (no native dialog needed)
  if (!confirm(`Close session "${label}"? The Chrome window will stay open.`)) return;

  try {
    await apiCall('DELETE', `/sessions/${label}`);
    state.sessions[label] = { account: label, status: 'closed', error: '' };
    renderSessions(els.searchInput.value);
    if (state.selected === label) updateChatStatus('closed');
    toast(`Session "${label}" closed.`, 'info');
  } catch (e) {
    toast('Could not close session: ' + e.message, 'error');
  }
}

/* ═══════════════════════════════════════════════════════════════
   POLLING — refresh status for non-ready sessions
   ═══════════════════════════════════════════════════════════════ */
function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(pollSessions, 2500);
}

async function pollSessions() {
  // Only poll if there are sessions in a transitional state
  const needsPoll = Object.values(state.sessions).some(
    s => s.status === 'starting' || s.status === 'waiting_qr'
  );
  if (!needsPoll) return;

  try {
    const list = await apiCall('GET', '/sessions');
    let changed = false;
    for (const s of list) {
      const prev = state.sessions[s.account];
      if (prev && prev.status !== s.status) {
        state.sessions[s.account] = s;
        changed = true;

        // Notify when a session becomes ready
        if (s.status === 'ready' && (prev.status === 'waiting_qr' || prev.status === 'starting')) {
          toast(`"${s.account}" is ready to send!`, 'success');
          clearTimeout(qrPollTimer); // stop QR polling
        }
        if (s.status === 'error') {
          toast(`Session "${s.account}" errored: ${s.error}`, 'error');
        }
        // Update chat header if this is the selected session
        if (state.selected === s.account) updateChatStatus(s.status);
      }
    }
    if (changed) renderSessions(els.searchInput.value);
  } catch { /* ignore polling errors */ }
}

/* ═══════════════════════════════════════════════════════════════
   TOAST NOTIFICATIONS
   ═══════════════════════════════════════════════════════════════ */
function toast(msg, type = 'info') {
  const icons = {
    success: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    error:   `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    warn:    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    info:    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `${icons[type] || ''}<span>${esc(msg)}</span>`;
  els.toasts.appendChild(el);

  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, 3500);
}

/* ═══════════════════════════════════════════════════════════════
   EVENT BINDINGS
   ═══════════════════════════════════════════════════════════════ */
function bindEvents() {
  // New session buttons
  $('btn-new-session').addEventListener('click', openModal);
  $('btn-welcome-new').addEventListener('click', openModal);
  $('btn-empty-new').addEventListener('click',   openModal);

  // Modal
  $('btn-modal-close').addEventListener('click',  closeModal);
  $('btn-modal-cancel').addEventListener('click', closeModal);
  $('btn-modal-create').addEventListener('click', createSession);
  els.accountInput.addEventListener('keydown', e => { if (e.key === 'Enter') createSession(); });
  els.modalOverlay.addEventListener('click', e => { if (e.target === els.modalOverlay) closeModal(); });

  // Close session (header button)
  $('btn-close-session').addEventListener('click', () => {
    if (state.selected) confirmClose(state.selected);
  });

  // Send
  els.sendBtn.addEventListener('click', sendMessage);
  els.msgInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Search
  els.searchInput.addEventListener('input', () => renderSessions(els.searchInput.value));
}

/* ═══════════════════════════════════════════════════════════════
   UTILITIES
   ═══════════════════════════════════════════════════════════════ */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusToBadge(s) {
  return {
    ready:      'badge-ready',
    waiting_qr: 'badge-waiting',
    starting:   'badge-starting',
    error:      'badge-error',
    closed:     'badge-closed',
  }[s] || 'badge-starting';
}

function statusToDot(s) {
  return {
    ready:      'ready',
    waiting_qr: 'waiting',
    starting:   'starting',
    error:      'error',
    closed:     'closed',
  }[s] || 'starting';
}

function statusToLabel(s) {
  return {
    ready:      'Ready',
    waiting_qr: 'Scan QR Code',
    starting:   'Starting…',
    error:      'Error',
    closed:     'Closed',
  }[s] || s;
}
