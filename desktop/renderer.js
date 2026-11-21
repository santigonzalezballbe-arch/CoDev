// CoDev UI: local AI terminals (you can type in them) and live replicas of your teammates' terminals.
// Each terminal can run Claude, DeepSeek, a local Ollama model (all three inside Claude Code) or
// ChatGPT (inside OpenAI's Codex CLI); the header and the character show which one it is.
// The same file runs in the desktop app and, served by the room's server, in a browser (watch-only).
import { Terminal } from '../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { SerializeAddon } from '../node_modules/@xterm/addon-serialize/lib/addon-serialize.mjs';
import { Unicode11Addon } from '../node_modules/@xterm/addon-unicode11/lib/addon-unicode11.mjs';
import { AGENTS, AGENT_IDS, agentLabel } from './agents.js';

const $ = (sel) => document.querySelector(sel);
// In the desktop app, preload.cjs provides window.codev. In a browser there is no Claude Code to run,
// so the app-only calls become harmless stand-ins and the UI turns into a viewer.
const WEB = !window.codev;
const noop = () => {};
// In a browser, "your" terminal is a guest terminal: Claude Code runs on the host's computer (after the
// host allows it) and its input and output travel over the room WebSocket.
const guestPending = new Map(); // id -> { resolve, reject }
const ptyDataCbs = [];
const ptyExitCbs = [];
const api = window.codev || {
  copy: (text) => navigator.clipboard?.writeText(text).catch(noop),
  ghRepos: async () => ({ ok: false, repos: [] }),
  repoStatus: async () => ({ valid: false }),
  ptyCreate: ({ id, cols, rows, env }) =>
    new Promise((resolve, reject) => {
      guestPending.set(id, { resolve, reject });
      wsSend({ t: 'guest-open', id, cols, rows, label: splitMember(env?.CODEV_NAME || '')[1] });
    }),
  ptyWrite: (id, d) => wsSend({ t: 'guest-input', id, d }),
  ptyResize: (id, cols, rows) => wsSend({ t: 'guest-resize', id, cols, rows }),
  ptyKill: (id) => wsSend({ t: 'guest-close', id }),
  onPtyData: (cb) => ptyDataCbs.push(cb),
  onPtyExit: (cb) => ptyExitCbs.push(cb),
  onShareProgress: noop,
  onDeepLink: noop,
  pendingLink: async () => null,
  setHostContext: noop,
  onGuestRequest: noop,
  onGuestRequestExpired: noop,
  onGuests: noop,
  historyOpen: async () => null,
  historyAppend: noop,
  historyRead: async () => [],
  historyReveal: noop,
  agentsInfo: async () => null,
  setAgentKey: async () => false,
};

/* ---------- Host side: requests from browser visitors ---------- */
const guestQueue = [];

function showNextRequest() {
  const bar = $('#request');
  const req = guestQueue[0];
  bar.hidden = !req;
  if (!req) return;
  const where = req.sameFolder
    ? h('span', {}, 'This project is not a git repository, so they will work ', h('strong', {}, 'in the same folder as you'), '.')
    : h('span', {}, 'It runs in a separate copy of ', h('strong', {}, req.project), ' on branch ', h('strong', {}, req.branch), '.');
  $('#request-text').replaceChildren(
    h('strong', {}, req.member),
    ' wants their own Claude Code on this computer. ',
    where,
    " They sign in with their own Claude account, and their Claude will be able to run commands here. Allow it only for people you trust."
  );
}

function answerRequest(allow) {
  const req = guestQueue.shift();
  if (req) api.guestDecision(req.reqId, allow);
  showNextRequest();
}

if (!WEB) {
  api.onGuestRequest((req) => {
    guestQueue.push(req);
    showNextRequest();
  });
  api.onGuestRequestExpired((reqId) => {
    const i = guestQueue.findIndex((r) => r.reqId === reqId);
    if (i >= 0) guestQueue.splice(i, 1);
    showNextRequest();
  });
  api.onGuests((ids) => {
    S.guestIds = new Set(ids);
    for (const p of S.panes.values()) p.ui && (p.ui.side = null);
    renderHeads();
  });
  $('#request-allow').addEventListener('click', () => answerRequest(true));
  $('#request-deny').addEventListener('click', () => answerRequest(false));
}

/** Guest-terminal messages from the room server (browser only). */
function onGuestMessage(m) {
  const pending = guestPending.get(m.id);
  if (m.t === 'guest-ready') {
    guestPending.delete(m.id);
    pending?.resolve(true);
  } else if (m.t === 'guest-denied') {
    guestPending.delete(m.id);
    pending?.reject(new Error(m.reason));
  } else if (m.t === 'guest-data') {
    for (const cb of ptyDataCbs) cb(m.id, m.d);
  } else if (m.t === 'guest-exit') {
    for (const cb of ptyExitCbs) cb(m.id, m.code);
  }
}
if (WEB) document.body.classList.add('web');

/** A codev:// link opens the desktop app straight into the join screen of this room. */
const appLink = ({ server, room, key }) => `codev://join?${new URLSearchParams({ server, room, ...(key && { key }) })}`;

const THEME = {
  background: '#0a0a0a', foreground: '#e6e8ef', cursor: '#e6e8ef', cursorAccent: '#0a0a0a',
  selectionBackground: '#33406b',
  black: '#1b1f2c', red: '#ff6b6b', green: '#4dd0a1', yellow: '#ffd166', blue: '#7c9cff', magenta: '#e57bd8', cyan: '#5ec8f2', white: '#d5d8e3',
  brightBlack: '#5c6278', brightRed: '#ff8a8a', brightGreen: '#7ee2bd', brightYellow: '#ffe08f', brightBlue: '#a3b8ff', brightMagenta: '#f0a3e6', brightCyan: '#8fdcf7', brightWhite: '#ffffff',
};
/** Text grows with the window: about 130 columns, never smaller than 13 px nor larger than 22 px. */
const fontFor = (width) => Math.max(13, Math.min(22, Math.round(width / 80)));

const TERM_OPTS = {
  fontFamily: '"JetBrains Mono", "DejaVu Sans Mono", "Noto Sans Mono", "Noto Color Emoji", monospace',
  fontSize: 13,
  lineHeight: 1.15,
  theme: THEME,
  allowProposedApi: true,
  scrollback: 5000,
};

const S = {
  cfg: null, // { root, server, room, name, lan }
  members: new Map(),
  claims: [],
  ws: null,
  panes: new Map(), // id -> pane (local and remote)
  guestIds: new Set(), // remote panes that are guest terminals running on this computer
  events: [], // the room's activity as received (the browser's history; the app also keeps a file)
  historyReady: Promise.resolve(),
  localCount: 0,
};

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* ================= Start screen ================= */
const form = $('#start-form');
const saved = store.get('codev:start') || {};
const ui = {
  source: saved.source || 'github',
  mode: saved.mode || 'host',
  reach: saved.reach || 'lan',
  roomRepo: null,
  agent: AGENTS[saved.agent] ? saved.agent : 'claude',
  model: saved.model || '',
};
for (const k of ['project', 'name', 'room', 'server', 'repo']) if (saved[k]) form[k].value = saved[k];

/* ---------- Which AIs exist, which are installed, which keys are saved ---------- */
// The main process answers: the agent list itself comes from desktop/agents.js (the same file the
// server uses to start them). API keys never come back here: only whether one is saved.
const AI_STATE = { info: null, loading: null };

async function loadAgents(force = false) {
  if (WEB || !api.agentsInfo) return null;
  if (!force && AI_STATE.info) return AI_STATE.info;
  AI_STATE.loading ||= api.agentsInfo().catch(() => null);
  AI_STATE.info = await AI_STATE.loading;
  AI_STATE.loading = null;
  return AI_STATE.info;
}

const hasKey = (agent) => !!AI_STATE.info?.hasKey?.[agent];
const modelOptions = (agent) => {
  const a = AGENTS[agent] || AGENTS.claude;
  if (a.ollama) return AI_STATE.info?.ollama ?? null; // null: Ollama did not answer
  return (a.models || []).map((name) => ({ name }));
};

/** Fills a model <select> for an agent and returns the model that ends up chosen. */
function fillModelSelect(sel, agent, value = '') {
  const a = AGENTS[agent] || AGENTS.claude;
  const list = modelOptions(agent);
  const key = `${agent}|${list ? list.map((m) => m.name).join(',') : '?'}`;
  if (sel.dataset.key !== key) {
    sel.dataset.key = key;
    sel.replaceChildren();
    if (!list) sel.append(h('option', { value: '' }, 'Looking for Ollama…'));
    else if (!list.length) sel.append(h('option', { value: '' }, a.ollama ? 'No models installed' : 'Default'));
    else for (const m of list) sel.append(h('option', { value: m.name }, m.params ? `${m.name} · ${m.params}` : m.name));
  }
  sel.disabled = !list || !list.length;
  if (!list || !list.length) return null;
  const names = list.map((m) => m.name);
  sel.value = names.includes(value) ? value : names.includes(a.defaultModel) ? a.defaultModel : names[0];
  return sel.value;
}

/** The AI buttons of a picker, built once. `cls` is the styling class of each button. */
function buildAgentSwitch(el, cls) {
  el.replaceChildren(
    ...AGENT_IDS.map((id) => {
      const a = AGENTS[id];
      return h('button', { type: 'button', class: cls, role: 'radio', 'data-ai': id, title: a.by }, a.label);
    })
  );
}

/**
 * What the user must know before choosing an AI: how it runs, what it needs, and why a local
 * model can feel slow. Empty when there is nothing to warn about.
 */
function agentWarning(id) {
  const a = AGENTS[id] || AGENTS.claude;
  const parts = [];
  if (a.experimental) {
    parts.push(
      "Experimental: CoDev drives OpenAI's Codex CLI. Install it with npm i -g @openai/codex and sign in with codex login. " +
        'Codex asks you once to trust this folder before it runs CoDev\'s hooks, so file locking does not work until you accept.'
    );
  }
  if (a.ollama) {
    parts.push('Local models run on your computer. Without a GPU, a big model can take minutes per answer: pick a small one (7B or less).');
  }
  if (a.needsKey && AI_STATE.info?.secureStorage === false) {
    parts.push('This system has no keychain, so CoDev will not save the key. On Linux, try starting CoDev with CODEV_PASSWORD_STORE=gnome-libsecret.');
  }
  if (AI_STATE.info?.installed && AI_STATE.info.installed[a.command] === false) {
    const tool = a.command === 'codex' ? 'Codex' : a.command === 'dsh' ? 'The DeepSeek Harness' : 'Claude Code';
    parts.push(
      a.command === 'claude'
        ? 'Claude Code is not installed: CoDev installs it for you when your terminal opens (about a minute), then it asks you to sign in.'
        : `${tool} is not installed: ${a.install}.`
    );
  }
  return parts.join(' ');
}


/** An invite is a link like https://host/?room=R&key=K. It may arrive inside a longer message. */
function parseInvite(text) {
  const m = String(text).match(/https?:\/\/[^\s]+/);
  if (!m) return null;
  try {
    const u = new URL(m[0]);
    return { server: u.origin, room: u.searchParams.get('room') || '', key: u.searchParams.get('key') || '' };
  } catch {
    return null;
  }
}

const keyHeaders = (key) => (key ? { 'x-codev-key': key } : {});

const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

/** Writes one huge word and shrinks it until it fits. */
function setBig(el, text, placeholder) {
  const line = el.querySelector('.line');
  const value = text.trim() || placeholder;
  if (line.textContent !== value) line.textContent = value;
  line.classList.toggle('placeholder', !text.trim());
  let size = Math.min(280, window.innerHeight * 0.22, window.innerWidth * 0.16);
  el.style.fontSize = `${size}px`;
  while (line.offsetWidth > el.clientWidth && size > 40) {
    size -= 4;
    el.style.fontSize = `${size}px`;
  }
}

function renderStart() {
  for (const b of form.querySelectorAll('[data-src]')) b.setAttribute('aria-checked', String(b.dataset.src === ui.source));
  for (const b of form.querySelectorAll('[data-reach]')) b.setAttribute('aria-checked', String(b.dataset.reach === ui.reach));
  for (const b of form.querySelectorAll('.mode')) b.setAttribute('aria-checked', String(b.dataset.mode === ui.mode));
  $('#src-github').hidden = ui.source !== 'github';
  $('#src-folder').hidden = ui.source !== 'folder';
  $('#server-field').hidden = ui.mode !== 'join';
  $('#key-field').hidden = ui.mode !== 'join';
  $('#reach-field').hidden = ui.mode !== 'host';
  setBig($('#big-you'), form.name.value, 'You');
  setBig($('#big-room'), form.room.value, 'Room');

  const lead = $('#room-lead');
  if (ui.mode === 'host') {
    lead.textContent =
      ui.reach === 'internet'
        ? 'Your computer will be the server, reachable from anywhere through a private Cloudflare link. Only people with the invite (and its key) can get in.'
        : 'Your computer will be the server. Teammates on your network join with the invite you copy once inside.';
  } else if (WEB) {
    lead.textContent =
      'You are watching from the browser: every terminal in the room, live, and notes. To run your own Claude Code alongside them, open the CoDev app.';
  } else if (ui.roomRepo) {
    lead.replaceChildren('This room works on ', h('strong', {}, ui.roomRepo), ". If you don't have it, we'll clone it for you.");
  } else {
    lead.textContent = 'Paste the invite your teammate copied with the Invite button. It fills in the room and the key.';
  }
  renderStartAI();
}

/** Builds the AI selector of the start screen once; renderStartAI() only updates it. */
function setupStartAI() {
  buildAgentSwitch($('#ai-switch'), 'opt');
  $('#ai-switch').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ai]');
    if (!b) return;
    ui.agent = b.dataset.ai;
    ui.model = '';
    renderStart();
  });
  $('#ai-model').addEventListener('change', () => (ui.model = $('#ai-model').value));
}

/** The AI field of the start screen: key or model when the chosen AI needs one. */
function renderStartAI() {
  const sw = $('#ai-switch');
  if (!sw.children.length) return; // a browser visitor never starts a terminal
  const a = AGENTS[ui.agent] || AGENTS.claude;
  for (const b of sw.children) b.setAttribute('aria-checked', String(b.dataset.ai === a.id));
  $('#ai-hint').textContent = a.by;

  $('#ai-key-field').hidden = !a.needsKey || AI_STATE.info?.secureStorage === false;
  if (a.needsKey) {
    const hint = $('#ai-key-hint');
    if (hasKey(a.id)) {
      hint.replaceChildren('A key is saved, encrypted with your system keychain. Leave this empty to use it.');
    } else {
      hint.replaceChildren('Saved encrypted with your system keychain; CoDev never shows it again. Get one at ');
      hint.append(h('a', { href: a.keyUrl, target: '_blank', rel: 'noreferrer' }, 'platform.deepseek.com'), '.');
    }
  }

  const models = modelOptions(a.id);
  const showModel = !!a.ollama || (a.models && a.models.length);
  $('#ai-model-field').hidden = !showModel;
  if (showModel) {
    $('#ai-model-label').textContent = a.ollama ? 'Local model' : 'Model';
    ui.model = fillModelSelect($('#ai-model'), a.id, ui.model) || '';
    $('#ai-model-hint').textContent = a.ollama
      ? models === null
        ? "Ollama is not running at localhost:11434. Start it with ollama serve, then reload this screen."
        : models.length
          ? `${models.length} models installed in Ollama.`
          : 'No models installed. Pull one with ollama pull qwen2.5-coder:7b.'
      : 'deepseek-flash is the fast one and has a 1M context; deepseek-v4-pro is stronger and costs more.';
  } else {
    ui.model = '';
  }
  $('#ai-credentials').classList.toggle('two', !$('#ai-key-field').hidden && !$('#ai-model-field').hidden);

  const warn = agentWarning(a.id);
  $('#ai-note').hidden = !warn;
  $('#ai-note').textContent = warn;
  $('#ai-note').classList.toggle('warn', !!warn);
}

form.addEventListener('click', (e) => {
  const opt = e.target.closest('[data-src]');
  const mode = e.target.closest('[data-mode]');
  const reach = e.target.closest('[data-reach]');
  if (opt) ui.source = opt.dataset.src;
  if (mode) ui.mode = mode.dataset.mode;
  if (reach) ui.reach = reach.dataset.reach;
  if (opt || mode || reach) {
    renderStart();
    if (mode) checkRoom();
  }
});
form.addEventListener('input', (e) => {
  // Pasting a whole invite fills in the server, the room and the key at once.
  if (e.target.name === 'server' && /[?&]room=/.test(e.target.value)) {
    const inv = parseInvite(e.target.value);
    if (inv) {
      form.server.value = inv.server;
      if (inv.room) form.room.value = inv.room;
      if (inv.key) form.key.value = inv.key;
    }
  }
  renderStart();
  if (e.target.name === 'repo') checkRepo();
  if (['room', 'server', 'key'].includes(e.target.name)) checkRoom();
});
window.addEventListener('resize', debounce(renderStart, 100));

$('#pick').addEventListener('click', async () => {
  const dir = await api.pickFolder();
  if (dir) form.project.value = dir;
});

// The user's repositories (via gh), suggested while typing.
api.ghRepos().then((r) => {
  const hint = $('#repo-hint');
  if (r.ok) {
    $('#repo-list').replaceChildren(...r.repos.map((x) => h('option', { value: x.nameWithOwner }, x.description || (x.isPrivate ? 'Privat' : ''))));
    if (!form.repo.value) hint.textContent = `Signed in to GitHub as ${r.login}. Start typing to see your ${r.repos.length} repositories.`;
  } else if (!form.repo.value) {
    hint.textContent = 'Paste a repository URL. Run `gh auth login` to see your own here too.';
  }
  checkRepo();
});

const checkRepo = debounce(async () => {
  const hint = $('#repo-hint');
  if (!form.repo.value.trim()) return;
  const st = await api.repoStatus(form.repo.value);
  if (!st.valid) hint.textContent = 'Write it as owner/repository or paste its GitHub URL.';
  else hint.replaceChildren(st.exists ? 'Already at ' : 'Will be cloned to ', h('strong', {}, st.dest), '.');
}, 250);

// In "join" mode, check whether the room already has a repository.
const checkRoom = debounce(async () => {
  ui.roomRepo = null;
  const server = form.server.value.trim().replace(/\/$/, '');
  const room = form.room.value.trim();
  if (ui.mode === 'join' && /^https?:\/\/.+/.test(server) && room) {
    try {
      const res = await fetch(`${server}/api/rooms/${encodeURIComponent(room)}/state`, {
        signal: AbortSignal.timeout(4000),
        headers: keyHeaders(form.key.value.trim()),
      });
      const st = await res.json();
      if (st.meta?.repo) {
        ui.roomRepo = st.meta.repo;
        ui.source = 'github';
        form.repo.value = st.meta.repo;
        checkRepo();
      }
    } catch {}
  }
  renderStart();
}, 400);

if (!WEB) {
  setupStartAI();
  loadAgents().then(renderStart);
}
document.fonts.ready.then(renderStart);
renderStart();
checkRoom();

/** Fills the join screen from an invite (a codev:// link opened by the system, or a web invite). */
function applyInvite({ server, room, key }) {
  if (!$('#app').hidden) {
    flash(`Got an invite to "${room}". Close this room (quit CoDev) to join another one.`, 'info');
    return;
  }
  ui.mode = 'join';
  if (server) form.server.value = server;
  if (room) form.room.value = room;
  if (key) form.key.value = key;
  renderStart();
  checkRoom();
  (form.name.value ? $('#enter') : form.name).focus();
}

if (WEB) {
  // Opened from an invite link in a browser: same room, same key, server = this page's origin.
  const q = new URLSearchParams(location.search);
  ui.mode = 'join';
  form.server.value = location.origin;
  form.room.value = q.get('room') || '';
  form.key.value = q.get('key') || '';
  if (form.key.value) $('#key-field').classList.add('app-only');
  const link = appLink({ server: location.origin, room: form.room.value, key: form.key.value });
  $('#open-app').href = link;
  renderStart();
  // Try the desktop app first, from a hidden frame: navigating this page itself to codev:// would
  // abort it when the app is not installed. If it is, the browser offers to open CoDev.
  if (form.room.value) {
    const probe = h('iframe', { src: link, hidden: true, 'aria-hidden': 'true' });
    document.body.append(probe);
    setTimeout(() => probe.remove(), 3000);
  }
} else {
  api.onDeepLink(applyInvite);
  api.pendingLink().then((l) => l && applyInvite(l));
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#start-error');
  err.hidden = true;
  const v = {
    source: ui.source,
    mode: ui.mode,
    reach: ui.reach,
    project: form.project.value.trim(),
    repo: form.repo.value.trim(),
    name: form.name.value.trim(),
    room: form.room.value.trim(),
    server: form.server.value.trim().replace(/\/$/, ''),
    agent: ui.agent,
    model: ui.model,
  };
  const joinKey = form.key.value.trim();
  if (WEB) return enterAsViewer(v.name, v.room, joinKey);
  if (!v.name) return showError('Write your name.');
  if (v.source === 'github' && !v.repo) return showError('Choose a GitHub repository.');
  if (v.source === 'folder' && !v.project) return showError('Choose the project folder.');
  if (!v.room) return showError('Give the room a name.');
  if (v.mode === 'join' && !/^https?:\/\//.test(v.server)) return showError('Paste the invite your teammate sent you.');

  // The AI needs its key (DeepSeek) or its model (local Ollama) before the first terminal can start.
  const agent = AGENTS[v.agent] || AGENTS.claude;
  if (agent.needsKey || agent.ollama) await loadAgents();
  if (agent.needsKey) {
    if (AI_STATE.info?.secureStorage === false && !hasKey(agent.id)) {
      return showError('This system has no keychain, so CoDev cannot save the DeepSeek key encrypted. Start CoDev with CODEV_PASSWORD_STORE=gnome-libsecret (or kwallet6) and try again.');
    }
    const typed = $('#agent-key').value.trim();
    try {
      if (typed) {
        await api.setAgentKey(agent.id, typed);
        AI_STATE.info = null;
        await loadAgents(true);
      } else if (!hasKey(agent.id)) {
        return showError(`Paste your ${agent.label} API key.`);
      }
    } catch (ex) {
      return showError(String(ex.message || ex).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  } else if (agent.ollama && !v.model) {
    return showError('Choose a local Ollama model.');
  }
  store.set('codev:start', v);

  const btn = $('#enter');
  btn.disabled = true;
  try {
    let root = v.project;
    let repoFull = null;
    if (v.source === 'github') {
      btn.textContent = 'Preparing the repository…';
      ({ root, full: repoFull } = await api.prepareRepo(v.repo));
    }
    btn.textContent = 'Connecting…';
    let server = v.server;
    let lan = [];
    let key = joinKey;
    let publicUrl = null;
    if (v.mode === 'host') {
      ({ url: server, lan, key } = await api.hostServer(4321));
      if (v.reach === 'internet') {
        btn.textContent = 'Opening the link…';
        ({ url: publicUrl } = await api.shareStart());
      }
    } else {
      const res = await fetch(`${server}/api/rooms/${encodeURIComponent(v.room)}/state`, {
        signal: AbortSignal.timeout(8000),
        headers: keyHeaders(key),
      }).catch(() => null);
      if (!res) throw new Error(`Cannot reach ${server}. Is your teammate's app still open?`);
      if (res.status === 401) throw new Error('The room key is missing or wrong. Paste the whole invite again.');
    }
    const r = await api.setupProject({ root, server, room: v.room, name: v.name, key });
    if (!r.reachable) throw new Error(`Cannot reach the server at ${server}.`);
    if (repoFull) {
      await fetch(`${server}/api/rooms/${encodeURIComponent(v.room)}/meta`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...keyHeaders(key) },
        body: JSON.stringify({ member: v.name, repo: repoFull }),
      }).catch(() => {});
    }
    S.cfg = { root, server, room: v.room, name: v.name, lan, key, publicUrl, host: v.mode === 'host', repo: repoFull, agent: v.agent, model: v.model };
    await document.fonts.load('13px "JetBrains Mono"');
    await document.fonts.load('bold 13px "JetBrains Mono"');
    openWorkspace();
  } catch (ex) {
    showError(String(ex.message || ex).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enter the room';
  }

  function showError(text) {
    err.textContent = text;
    err.hidden = false;
  }
});

/** Browser: join as a viewer (no terminal of your own, no project). */
async function enterAsViewer(name, room, key) {
  const err = $('#start-error');
  const fail = (text) => {
    err.textContent = text;
    err.hidden = false;
  };
  if (!name) return fail('Write your name.');
  if (!room) return fail('This invite has no room. Ask your teammate for a new one.');
  const res = await fetch(`/api/rooms/${encodeURIComponent(room)}/state`, { headers: keyHeaders(key) }).catch(() => null);
  if (!res) return fail('Cannot reach the room. Is your teammate\'s app still open?');
  if (res.status === 401) return fail('This invite is missing its key, or the key is wrong. Ask for a new invite.');
  S.cfg = { root: null, server: location.origin, room, name, key, lan: [], publicUrl: null, host: false, repo: null, agent: 'claude', model: '' };
  await document.fonts.load('13px "JetBrains Mono"');
  openWorkspace();
}

/* ================= Workspace ================= */
function openWorkspace() {
  $('#start-form').hidden = true;
  $('#app').hidden = false;
  $('#room-name').textContent = S.cfg.room;
  document.title = `${S.cfg.room} · CoDev`;

  $('#invite').addEventListener('click', () => {
    const base = S.cfg.publicUrl || S.cfg.lan[0] || S.cfg.server;
    const link = `${base}/?${new URLSearchParams({ room: S.cfg.room, ...(S.cfg.key && { key: S.cfg.key }) })}`;
    api.copy(`Join my CoDev room: ${link}`);
    flash(
      S.cfg.publicUrl
        ? 'Invite copied. It works from anywhere: send it only to your teammates, it carries the room key.'
        : 'Invite copied. It works on your network only; turn on "Share online" for teammates elsewhere.',
      'info'
    );
  });
  renderShare();
  $('#share').addEventListener('click', toggleShare);
  $('#add-claude').addEventListener('click', () => openNewAI({ first: ![...S.panes.values()].some((p) => p.local) }));
  setupNewAI();
  setupChat();
  setupViews();

  // The local history file must be open before the first room events arrive.
  if (!WEB) S.historyReady = api.historyOpen({ root: S.cfg.root });
  setupHistory();
  connectTerminals();
  // Start Claude once we know how many panes there are: if the terminal shrinks right after
  // starting, the redraw leaves artifacts behind.
  const first = new Promise((resolve) => {
    S.onFirstTerms = resolve;
    setTimeout(resolve, 1500);
  });
  if (!WEB) first.then(() => addLocal('', { agent: S.cfg.agent, model: S.cfg.model }));
  if (WEB) $('#add-claude').textContent = 'Open my Claude Code';
  if (S.cfg.host) api.setHostContext({ root: S.cfg.root, room: S.cfg.room, name: S.cfg.name });
}

function post(action, body) {
  return fetch(`${S.cfg.server}/api/rooms/${encodeURIComponent(S.cfg.room)}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...keyHeaders(S.cfg.key) },
    body: JSON.stringify({ member: S.cfg.name, ...body }),
  }).catch(() => {});
}

// EventSource and WebSocket cannot send headers, so they carry the key in the URL.
const keyParam = () => (S.cfg.key ? `&key=${encodeURIComponent(S.cfg.key)}` : '');

/** "Share online" button: only for whoever hosts the room. */
function renderShare() {
  const btn = $('#share');
  btn.hidden = !S.cfg.host;
  btn.textContent = S.cfg.publicUrl ? 'Stop sharing online' : 'Share online';
  btn.title = S.cfg.publicUrl ? `Reachable at ${S.cfg.publicUrl}` : 'Let teammates on other networks join through a private link';
}

async function toggleShare() {
  const btn = $('#share');
  btn.disabled = true;
  try {
    if (S.cfg.publicUrl) {
      await api.shareStop();
      S.cfg.publicUrl = null;
      flash('Stopped sharing online. Only your network can reach the room now.', 'info');
    } else {
      btn.textContent = 'Opening the link…';
      ({ url: S.cfg.publicUrl } = await api.shareStart());
      flash('The room is online. Press Invite and send the link to your teammate.', 'info');
    }
  } catch (ex) {
    flash(String(ex.message || ex).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  } finally {
    btn.disabled = false;
    renderShare();
  }
}

// First-time download of cloudflared: show the progress on whichever button started it.
api.onShareProgress((p) => {
  const btn = $('#app').hidden ? $('#enter') : $('#share');
  btn.textContent = p < 1 ? `Getting the online link ready (first time only)… ${Math.round(p * 100)}%` : 'Opening the link…';
});

let flashTimer;
function flash(text, kind = 'danger') {
  const el = $('#alert');
  el.textContent = text;
  el.className = `alert ${kind === 'info' ? 'info' : ''}`;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (el.hidden = true), 7000);
}

/* ---------- Room events (SSE): tasks, files, conflicts, notes ---------- */
/** Room events (tasks, claims, activity, notes) arrive over the same WebSocket as the terminals. */
function onRoomMessage(type, data) {
  if (type === 'snapshot') {
    S.members = new Map(data.members.map((m) => [m.name, m]));
    S.claims = data.claims;
    mergeEvents(data.events);
    record(data.events);
    addChat(data.events, false);
  } else if (type === 'member') S.members.set(data.name, data);
  else if (type === 'claims') S.claims = data;
  else if (type === 'tick') for (const m of data.members) S.members.set(m.name, m);
  else if (type === 'event') {
    mergeEvents([data]);
    record([data]);
    onEvent(data);
  }
  renderHeads();
}

const isMine = (member) => [...S.panes.values()].some((p) => p.local && p.member === member);

function onEvent(ev) {
  if (ev.kind === 'conflict') (S.blockedAt ||= new Map()).set(ev.member, Date.now());
  if (ev.kind === 'note' || ev.kind === 'conflict') addChat([ev], true);
  const forMe = ev.kind === 'note' && notFromMe(ev) && (!ev.to || isMe(ev.to));
  const myConflict = ev.kind === 'conflict' && (isMe(ev.member) || isMe(ev.owner));
  if (myConflict) {
    const text = isMe(ev.member)
      ? `Your AI wanted to touch ${ev.files[0]}, but it belongs to ${ev.owner}. CoDev stopped it.`
      : `${ev.member}'s AI wanted to touch ${ev.files[0]} (yours). CoDev stopped it.`;
    flash(text);
    notify('CoDev stopped an AI', text);
  } else if (forMe) {
    const who = `${ev.member}${ev.from === 'ai' ? "'s AI" : ''}`;
    if ($('#chat').hidden) flash(`${who}: ${ev.summary}`, 'info');
    notify(`Message from ${who}`, ev.summary);
  }
}

const isMe = (name) => name === S.cfg.name || isMine(name);
/** A chat message you did not type yourself: from a teammate, or from any AI (your own other terminals included). */
const notFromMe = (ev) => ev.from === 'ai' || !isMe(ev.member);

// Same list and hash as server/rooms.js: the server gives everyone in a room a different colour;
// names that are no longer in the room (old history) fall back to the colour of their name.
const PALETTE = ['#ff8a65', '#6cb4ff', '#4dd0a1', '#ffd166', '#f78fb3', '#b5e655', '#ff6b6b', '#5ec8f2'];
function colorOf(name) {
  const m = S.members.get(name);
  if (m?.color && PALETTE.includes(m.color)) return m.color;
  let x = 0;
  for (const ch of splitMember(String(name))[0]) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[x % PALETTE.length];
}
const personChip = (name, label = name) => {
  const el = h('span', { class: 'person' }, label);
  el.style.setProperty('--person', colorOf(name));
  return el;
};

/** Desktop notification, only when CoDev is in the background. */
function notify(title, body) {
  if (WEB || document.hasFocus()) return;
  try {
    new Notification(title, { body, silent: false });
  } catch {}
}

/* ---------- Chat ---------- */
const chatKeys = new Set();
S.chat = [];
let unread = 0;
let lastSender = null;

/** A short pulse on the Chat button when a message arrives with the chat closed. */
function pingChatButton() {
  const btn = $('#chat-btn');
  btn.classList.remove('ping');
  void btn.offsetWidth; // restart the animation
  btn.classList.add('ping');
}

function setupChat() {
  $('#chat-btn').addEventListener('click', () => ($('#chat').hidden ? openChat() : closeChat()));
  $('#chat-close').addEventListener('click', closeChat);
  $('#note-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#note-text').value.trim();
    if (!text) return;
    $('#note-text').value = '';
    $('#note-text').style.height = '';
    post('note', { text, to: S.noteTo || null, from: 'human' });
  });
  // The box grows with the message.
  $('#note-text').addEventListener('input', (e) => {
    e.target.style.height = '';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
  });
  // Enter sends; Shift+Enter adds a line.
  $('#note-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#note-form').requestSubmit();
    }
  });
  // Earlier messages of this room: from the local history file in the app.
  if (!WEB) {
    S.historyReady
      .then(() => api.historyRead())
      .then((rows) => {
        const here = rows.filter((r) => r.room === S.cfg.room);
        mergeEvents(here); // earlier conversations of each Claude, for the conversation view
        addChat(here, false);
        for (const p of S.panes.values()) renderConvo(p, true);
      });
  }
}

function addChat(events, live) {
  let fresh = 0;
  for (const ev of events) {
    if (ev.kind !== 'note' && ev.kind !== 'conflict') continue;
    const key = `${ev.ts}|${ev.member}|${ev.summary}`;
    if (chatKeys.has(key)) continue;
    chatKeys.add(key);
    S.chat.push(ev);
    if (live && notFromMe(ev)) {
      fresh++;
      lastSender = ev.member;
    }
  }
  S.chat.sort((a, b) => a.ts - b.ts);
  if (fresh && $('#chat').hidden) {
    unread += fresh;
    pingChatButton();
  }
  renderChat();
}

function openChat() {
  $('#chat').hidden = false;
  unread = 0;
  renderChat();
  $('#note-text').focus();
}

function closeChat() {
  $('#chat').hidden = true;
  renderChat();
}

/** People in the room, at the top of the chat. */
function renderChatPeople() {
  const box = $('#chat-people');
  if (!box) return;
  const names = [...new Set([S.cfg.name, ...S.members.keys()])].sort((a, b) => (isMe(a) ? -1 : isMe(b) ? 1 : a.localeCompare(b)));
  box.replaceChildren(
    ...names.map((n) => {
      const m = S.members.get(n);
      const away = !isMe(n) && (!m || m.status === 'offline' || (!m.viewers && Date.now() - m.lastSeen > 15 * 60_000));
      const chip = personChip(n, isMe(n) ? `${n} (you)` : n);
      chip.classList.toggle('away', away);
      chip.title = away ? 'Not here right now' : 'In the room';
      return chip;
    })
  );
}

function miniBot(name) {
  const box = document.createElement('span');
  box.innerHTML = botSvg(agentOf(name));
  const svg = box.firstElementChild;
  svg.setAttribute('class', 'mini-bot');
  svg.style.setProperty('--person', colorOf(name));
  return svg;
}

function renderChat() {
  const btn = $('#chat-btn');
  if (unread) {
    const badge = h('span', { class: 'chat-badge' }, unread > 99 ? '99+' : String(unread));
    if (lastSender) badge.style.setProperty('--person', colorOf(lastSender));
    btn.replaceChildren('Chat', badge);
    btn.title = `${unread} new message${unread === 1 ? '' : 's'}`;
  } else {
    btn.replaceChildren('Chat');
    btn.title = '';
  }
  btn.classList.toggle('unread', unread > 0);
  if ($('#chat').hidden) return;
  renderChatPeople();
  const list = $('#chat-list');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  if (!S.chat.length) {
    list.replaceChildren(h('p', { class: 'chat-empty' }, 'No messages yet. Write to the whole team or to one person: their AI reads the messages sent to them at its next prompt.'));
    return;
  }
  const out = [];
  let day = '';
  let group = null;
  for (const m of S.chat.slice(-500)) {
    const d = new Date(m.ts);
    const label = d.toDateString() === new Date().toDateString() ? 'Today' : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    if (label !== day) {
      day = label;
      group = null;
      out.push(h('div', { class: 'chat-day' }, label));
    }
    if (m.kind === 'conflict') {
      group = null;
      out.push(h('div', { class: 'system' }, h('strong', {}, 'CoDev'), ` stopped ${isMe(m.member) ? 'your AI' : `${m.member}'s AI`}: it tried to touch ${m.files?.[0] || 'a file'}, which belongs to ${isMe(m.owner) ? 'you' : m.owner}.`));
      continue;
    }
    const ai = m.from === 'ai';
    const to = m.to ? (isMe(m.to) ? 'to you' : `to ${m.to}`) : 'to everyone';
    // Messages from the same person, kind and recipient within 5 minutes share one header.
    const same = group && group.member === m.member && group.ai === ai && group.to === to && m.ts - group.last < 5 * 60_000;
    if (!same) {
      const mine = isMe(m.member);
      const el = h('div', { class: `group${mine ? ' mine' : ''}${ai ? ' ai' : ''}` });
      el.style.setProperty('--person', colorOf(m.member));
      el.append(
        h('div', { class: 'group-meta' },
          ai ? miniBot(m.member) : null,
          personChip(m.member, mine ? (ai ? `Your ${aiName(m.member)}` : 'You') : ai ? `${m.member}'s ${aiName(m.member)}` : m.member),
          h('span', { class: 'group-tag' }, to),
          h('span', { class: 'group-time' }, d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })))
      );
      group = { el, member: m.member, ai, to, last: m.ts };
      out.push(el);
    }
    group.last = m.ts;
    group.el.append(h('p', { class: 'bubble', title: d.toLocaleString() }, m.summary));
  }
  list.replaceChildren(...out);
  if (atBottom || list.dataset.seen !== String(S.chat.length)) list.scrollTop = list.scrollHeight;
  list.dataset.seen = String(S.chat.length);
}

/* ---------- Terminal relay (WebSocket) ---------- */
function connectTerminals() {
  const url = `${S.cfg.server.replace(/^http/, 'ws')}/ws?room=${encodeURIComponent(S.cfg.room)}&member=${encodeURIComponent(S.cfg.name)}${keyParam()}`;
  const ws = new WebSocket(url);
  S.ws = ws;
  ws.onopen = () => {
    $('#conn').classList.add('on');
    $('#conn').textContent = 'Online';
    for (const p of S.panes.values()) if (p.local) announce(p);
  };
  ws.onclose = () => {
    $('#conn').classList.remove('on');
    $('#conn').textContent = 'Offline';
    for (const p of [...S.panes.values()]) if (!p.local) removePane(p);
    setTimeout(connectTerminals, 2000);
  };
  ws.onmessage = (msg) => {
    const m = JSON.parse(msg.data);
    if (m.t === 'room') {
      onRoomMessage(m.type, m.data);
    } else if (m.t.startsWith('guest-')) {
      onGuestMessage(m);
    } else if (m.t === 'terms') {
      requestAnimationFrame(() => S.onFirstTerms?.());
      const ids = new Set();
      for (const info of m.list) {
        if (S.panes.get(info.id)?.local) continue;
        ids.add(info.id);
        if (!S.panes.has(info.id)) addRemote(info);
      }
      for (const p of [...S.panes.values()]) if (!p.local && !ids.has(p.id)) removePane(p);
    } else if (m.t === 'term-init') {
      const p = S.panes.get(m.id);
      if (!p || p.local) return;
      p.term.reset();
      p.term.resize(m.cols, m.rows);
      p.term.write(m.d, () => rescale(p));
      p.waiting.hidden = true;
    } else if (m.t === 'term-data') {
      const p = S.panes.get(m.id);
      if (p) {
        noteOutput(p);
        p.term.write(m.d);
      }
    } else if (m.t === 'term-typing') {
      const p = S.panes.get(m.id);
      if (p) p.lastKey = m.done ? 0 : Date.now();
    } else if (m.t === 'term-resize') {
      const p = S.panes.get(m.id);
      if (p && !p.local) {
        p.term.resize(m.cols, m.rows);
        requestAnimationFrame(() => rescale(p));
      }
    }
  };
}

const wsSend = (msg) => S.ws?.readyState === 1 && S.ws.send(JSON.stringify(msg));

function announce(p) {
  p.term.write('', () => {
    p.queue = [];
    wsSend({ t: 'term-open', id: p.id, member: p.member, title: p.title, agent: p.agent, cols: p.term.cols, rows: p.term.rows, d: p.ser.serialize({ scrollback: 1000 }) });
  });
}

/* ---------- Panes ---------- */
function makePane({ id, member, local, title, agent = 'claude', model = '' }) {
  const head = h('header', { class: 'pane-head' });
  const host = h('div', { class: 'term-host' });
  const waiting = h(
    'div',
    { class: 'waiting' },
    local ? (WEB ? 'Asking the host to open your Claude Code… they have to click Allow.' : `Opening ${agentLabel(agent)}…`) : `Waiting for ${member}'s terminal…`
  );
  const wrap = h('div', { class: 'term-wrap' }, host, waiting);
  // The conversation view lies over the terminal, which keeps its size and keeps running underneath.
  const convo = h('div', { class: 'convo' });
  const root = h('article', { class: `pane ${local ? 'local' : 'remote'}` }, head, h('div', { class: 'pane-body' }, wrap, convo));
  const pane = { id, member, local, title, agent: AGENTS[agent] ? agent : 'claude', model, root, head, host, wrap, waiting, convo, createdAt: Date.now(), view: null };
  S.panes.set(id, pane);
  buildConvo(pane);
  applyView(pane);
  layout();
  return pane;
}

function layout() {
  const panes = [...S.panes.values()].sort((a, b) => (a.local === b.local ? 0 : a.local ? -1 : 1));
  const grid = $('#panes');
  panes.forEach((p, i) => {
    if (grid.children[i] !== p.root) grid.insertBefore(p.root, grid.children[i] || null);
  });
  const n = panes.length;
  const cols = n <= 3 ? n : Math.ceil(n / 2);
  grid.style.gridTemplateColumns = `repeat(${Math.max(cols, 1)}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${Math.ceil(n / Math.max(cols, 1))}, minmax(0, 1fr))`;
  renderHeads();
  updateNoteTargets();
}

function removePane(p) {
  S.panes.delete(p.id);
  p.ro?.disconnect();
  clearInterval(p.snapTimer);
  p.term?.dispose();
  p.root.remove();
  layout();
}

function newTerminal(extra = {}) {
  const term = new Terminal({ ...TERM_OPTS, ...extra });
  const unicode = new Unicode11Addon();
  term.loadAddon(unicode);
  term.unicode.activeVersion = '11';
  return term;
}

/** Marks a terminal as being typed in, and tells teammates (only the fact, never the text). */
function markTyping(p, d) {
  if (d === '\r') {
    // Enter sends the prompt: from here Claude is working, not you typing.
    if (p.lastKey) wsSend({ t: 'term-typing', id: p.id, done: true });
    p.lastKey = 0;
    p.typingSent = 0;
    return;
  }
  const now = Date.now();
  p.lastKey = now;
  if (!p.typingSent || now - p.typingSent > 800) {
    p.typingSent = now;
    wsSend({ t: 'term-typing', id: p.id });
  }
}

/** Local terminal: a real AI in a PTY (Claude Code, or Codex for ChatGPT), relayed to the room. */
/* ---------- Another AI of yours ---------- */
const NICKNAMES = ['Nova', 'Pixel', 'Bolt', 'Echo', 'Orbit', 'Comet', 'Byte', 'Spark', 'Atlas', 'Juno'];
const FOCUS = ['frontend', 'backend', 'tests', 'docs', 'fixes', 'design'];
const MEMBER_SEP = ' · ';

/** "Ana · tests" -> ["Ana", "tests"]; "Ana" -> ["Ana", ""]. */
function splitMember(member) {
  const i = member.indexOf(MEMBER_SEP);
  return i < 0 ? [member, ''] : [member.slice(0, i), member.slice(i + MEMBER_SEP.length)];
}

const usedLabels = () => new Set([...S.panes.values()].filter((p) => p.local).map((p) => splitMember(p.member)[1].toLowerCase()));

/** What the "Another AI" dialog is about to open. */
const nc = { agent: 'claude', model: '', first: false };

const ncError = (text) => {
  const err = $('#nc-error');
  err.textContent = text;
  err.hidden = false;
};

function setupNewAI() {
  const box = $('#new-claude');
  const input = $('#nc-name');
  $('#nc-chips').replaceChildren(
    ...FOCUS.map((w) => {
      const b = h('button', { type: 'button', class: 'nc-chip' }, w);
      b.addEventListener('click', () => {
        input.value = w;
        input.focus();
      });
      return b;
    })
  );
  buildAgentSwitch($('#nc-ai'), 'nc-chip');
  $('#nc-ai').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ai]');
    if (!b || b.dataset.ai === nc.agent) return;
    nc.agent = b.dataset.ai;
    nc.model = '';
    $('#nc-key-input').value = '';
    renderNewAI();
  });
  $('#nc-cancel').addEventListener('click', () => (box.hidden = true));
  box.addEventListener('keydown', (e) => e.key === 'Escape' && (box.hidden = true));
  $('#new-claude-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#nc-error').hidden = true;
    const label = input.value.replace(/·/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!label && !nc.first) return ncError('Give it a name.');
    if (label && usedLabels().has(label.toLowerCase())) return ncError(`You already have an AI called ${label}.`);
    const a = AGENTS[nc.agent] || AGENTS.claude;
    try {
      if (a.needsKey) {
        if (AI_STATE.info?.secureStorage === false && !hasKey(a.id)) {
          return ncError('This system has no keychain, so CoDev cannot save the key encrypted. Start CoDev with CODEV_PASSWORD_STORE=gnome-libsecret (or kwallet6) and try again.');
        }
        const typed = $('#nc-key-input').value.trim();
        if (typed) {
          await api.setAgentKey(a.id, typed);
          AI_STATE.info = null;
          await loadAgents(true);
        } else if (!hasKey(a.id)) {
          return ncError(`Paste your ${a.label} API key.`);
        }
      }
    } catch (ex) {
      return ncError(String(ex.message || ex).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
    if (a.ollama && !nc.model) return ncError('Choose a local model.');
    box.hidden = true;
    addLocal(label, { agent: a.id, model: nc.model });
  });
}

/** The "Another AI" dialog: which AI, which model, and what that AI needs. */
function renderNewAI() {
  const a = AGENTS[nc.agent] || AGENTS.claude;
  for (const b of $('#nc-ai').children) b.setAttribute('aria-checked', String(b.dataset.ai === a.id));
  $('#nc-key').hidden = !a.needsKey || AI_STATE.info?.secureStorage === false;
  if (a.needsKey) $('#nc-key-input').placeholder = hasKey(a.id) ? 'A key is saved: leave it empty to keep it' : 'sk-...';
  const showModel = !!a.ollama || (a.models && a.models.length);
  $('#nc-model').hidden = !showModel;
  if (showModel) nc.model = fillModelSelect($('#nc-model-select'), a.id, nc.model) || '';
  else nc.model = '';
  const warn = agentWarning(a.id);
  $('#nc-note').hidden = !warn;
  $('#nc-note').textContent = warn;
  $('#nc-note').classList.toggle('warn', !!warn);
}

async function openNewAI({ first = false } = {}) {
  nc.first = first;
  nc.agent = first ? (AGENTS[S.cfg?.agent] ? S.cfg.agent : 'claude') : 'claude';
  nc.model = first ? S.cfg?.model || '' : '';
  const box = $('#new-claude');
  $('#nc-title').textContent = first ? 'Open your AI' : 'Another AI';
  $('#nc-help').textContent = first
    ? 'This is your main terminal: it shows as you. Leave the name empty to use your own name.'
    : 'It shows next to your name, so the team knows what each of your AIs is on.';
  const used = usedLabels();
  $('#nc-name').value = first ? '' : NICKNAMES.find((n) => !used.has(n.toLowerCase())) || '';
  $('#nc-key-input').value = '';
  $('#nc-error').hidden = true;
  // A model list can be stale (Ollama may have started after the app): look again for local models.
  if (AGENTS[nc.agent]?.ollama) await loadAgents(!AI_STATE.info?.ollama);
  renderNewAI();
  // Under the button that opened it, inside the window.
  const r = $('#add-claude').getBoundingClientRect();
  box.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - 372))}px`;
  box.hidden = false;
  if (!first) $('#nc-name').select();
}

/** label: the name of a second (third…) AI of yours, shown as "You · label". */
async function addLocal(label = '', { agent = 'claude', model = '' } = {}) {
  const idx = ++S.localCount;
  const member = label ? `${S.cfg.name}${MEMBER_SEP}${label}` : S.cfg.name;
  const id = `${S.cfg.name.replace(/\W+/g, '_')}-${Date.now().toString(36)}-${idx}`;
  const ai = AGENTS[agent] ? agent : 'claude';
  const p = makePane({ id, member, local: true, title: agentLabel(ai), agent: ai, model });

  p.term = newTerminal({ cursorBlink: true });
  p.fit = new FitAddon();
  p.ser = new SerializeAddon();
  p.term.loadAddon(p.fit);
  p.term.loadAddon(p.ser);
  p.term.options.fontSize = fontFor(p.wrap.clientWidth);
  p.term.open(p.host);
  p.fit.fit();
  p.queue = [];

  // Ctrl+Shift+C / Ctrl+Shift+V to copy and paste (Ctrl+C still goes to the AI).
  p.term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      if (p.term.hasSelection()) api.copy(p.term.getSelection());
      return false;
    }
    return true;
  });

  p.term.onData((d) => {
    api.ptyWrite(id, d);
    if (!d.startsWith('\x1b')) markTyping(p, d); // pasted text (keys are handled by onKey)
  });
  // Only real keys count as typing. onData also carries what the terminal reports by itself
  // (focus in/out, which Claude Code asks for, mouse events, cursor reports): those are not typing.
  p.term.onKey(({ key }) => markTyping(p, key));
  p.term.onResize(({ cols, rows }) => {
    api.ptyResize(id, cols, rows);
    wsSend({ t: 'term-resize', id, cols, rows });
  });
  // Batch resizes: each one makes the AI redraw everything.
  p.ro = new ResizeObserver(() => {
    clearTimeout(p.fitTimer);
    p.fitTimer = setTimeout(() => {
      const size = fontFor(p.wrap.clientWidth);
      if (p.term.options.fontSize !== size) p.term.options.fontSize = size;
      try { p.fit.fit(); } catch {}
    }, 120);
  });
  p.ro.observe(p.wrap);

  // Periodic snapshot so late joiners see the exact screen.
  p.snapTimer = setInterval(() => {
    if (!p.dirty) return;
    p.dirty = false;
    p.term.write('', () => {
      flushQueue(p);
      wsSend({ t: 'term-snapshot', id, cols: p.term.cols, rows: p.term.rows, d: p.ser.serialize({ scrollback: 1000 }) });
    });
  }, 3000);

  await startPty(p);
  announce(p);
  p.term.focus();
}

async function startPty(p) {
  p.exited?.remove();
  try {
    await createPty(p);
  } catch (ex) {
    p.waiting.hidden = true;
    p.term.write(`\x1b[31m${String(ex.message || ex).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}\x1b[0m\r\n`);
  }
}

async function createPty(p) {
  await api.ptyCreate({
    id: p.id,
    cwd: S.cfg.root,
    cols: p.term.cols,
    rows: p.term.rows,
    agent: p.agent,
    model: p.model,
    env: { CODEV_SERVER: S.cfg.server, CODEV_ROOM: S.cfg.room, CODEV_NAME: p.member, CODEV_ROOT: S.cfg.root, ...(S.cfg.key && { CODEV_KEY: S.cfg.key }) },
  });
  p.waiting.hidden = true;
}

function flushQueue(p) {
  clearTimeout(p.flushTimer);
  p.flushTimer = null;
  if (!p.queue.length) return;
  wsSend({ t: 'term-data', id: p.id, d: p.queue.join('') });
  p.queue = [];
}

api.onPtyData((id, data) => {
  const p = S.panes.get(id);
  if (!p) return;
  p.waiting.hidden = true; // output can arrive before the terminal is fully open (e.g. CoDev installing Claude Code)
  noteOutput(p);
  // Send output once xterm has processed it, so snapshots and chunks stay in order.
  p.term.write(data, () => {
    p.queue.push(data);
    p.dirty = true;
    if (!p.flushTimer) p.flushTimer = setTimeout(() => flushQueue(p), 30);
  });
});

api.onPtyExit((id, code) => {
  const p = S.panes.get(id);
  if (!p) return;
  p.exited = h('div', { class: 'exited' },
    `${agentLabel(p.agent)} exited (code ${code}).`,
    h('button', { onclick: () => { p.term.reset(); startPty(p).then(() => announce(p)); } }, 'Restart'),
    h('button', { class: 'quiet', onclick: () => closeLocal(p) }, 'Close'));
  p.wrap.append(p.exited);
});

function closeLocal(p) {
  api.ptyKill(p.id);
  wsSend({ t: 'term-close', id: p.id });
  removePane(p);
}

/** Remote terminal: a read-only replica of a teammate's terminal. */
function addRemote(info) {
  const p = makePane({ id: info.id, member: info.member, local: false, title: info.title, agent: info.agent });
  p.term = newTerminal({ disableStdin: true, cursorBlink: false, cols: info.cols, rows: info.rows, scrollback: 1000 });
  p.term.open(p.host);
  p.ro = new ResizeObserver(() => rescale(p));
  p.ro.observe(p.wrap);
}

/** Scales the replica so it fits whole, with the same columns and rows as the original. */
function rescale(p) {
  const screen = p.host.querySelector('.xterm-screen');
  if (!screen || !screen.offsetWidth) return;
  const cs = getComputedStyle(p.wrap);
  const w = p.wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const hgt = p.wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  // On big screens a replica may grow well past its original size, so it fills its window.
  const s = Math.min(w / screen.offsetWidth, hgt / screen.offsetHeight, 3);
  p.host.style.transform = `scale(${s})`;
}

/* ---------- History ---------- */
/** Saves events to the local history file (desktop app) and refreshes the panel if it is open. */
function record(events) {
  if (!events.length) return;
  if (!WEB) S.historyReady.then(() => api.historyAppend(events, S.cfg.room));
  if (!$('#history').hidden) refreshHistory();
}

const KIND_WORD = {
  prompt: 'asked Claude',
  edit: 'changed',
  command: 'ran',
  read: 'read',
  note: 'note',
  conflict: 'stopped by CoDev',
  status: '',
  agent: 'subagent',
  web: 'looked up',
  plan: 'plan',
  tool: 'tool',
};
const hist = { kind: 'all', who: '', q: '', rows: [] };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function setupHistory() {
  $('#history-btn').addEventListener('click', () => ($('#history').hidden ? openHistory() : closeHistory()));
  $('#history-close').addEventListener('click', closeHistory);
  $('#history-file').addEventListener('click', () => api.historyReveal());
  $('#history-kinds').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    hist.kind = b.dataset.kind;
    renderHistory();
  });
  $('#history-search').addEventListener('input', debounce((e) => {
    hist.q = e.target.value.trim().toLowerCase();
    renderHistory();
  }, 150));
  $('#history-who').addEventListener('change', (e) => {
    hist.who = e.target.value;
    renderHistory();
  });
  document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('#history').hidden && closeHistory());
}

async function openHistory() {
  $('#history').hidden = false;
  $('#history-btn').textContent = 'Back to terminals';
  await refreshHistory();
  $('#history-search').focus();
}

function closeHistory() {
  $('#history').hidden = true;
  $('#history-btn').textContent = 'History';
}

const refreshHistory = debounce(async () => {
  // The app reads its file (everything ever seen in this project); a browser has the room's recent events.
  hist.rows = WEB ? S.events.map((e) => ({ ...e, room: S.cfg.room })) : await (S.historyReady.then(() => api.historyRead()));
  renderHistory();
}, 120);

function renderHistory() {
  for (const b of $('#history-kinds').children) b.setAttribute('aria-checked', String(b.dataset.kind === hist.kind));
  const people = [...new Set(hist.rows.map((r) => r.member))].sort();
  const sel = $('#history-who');
  sel.replaceChildren(h('option', { value: '' }, 'Everyone'), ...people.map((n) => h('option', { value: n }, n)));
  sel.value = people.includes(hist.who) ? hist.who : '';

  const rows = hist.rows
    .filter((r) => r.kind !== 'status')
    .filter((r) => hist.kind === 'all' || r.kind === hist.kind || (hist.kind === 'note' && r.kind === 'conflict'))
    .filter((r) => !hist.who || r.member === hist.who)
    .filter((r) => !hist.q || [r.summary, r.member, ...(r.files || [])].join(' ').toLowerCase().includes(hist.q))
    .reverse();

  const prompts = hist.rows.filter((r) => r.kind === 'prompt').length;
  const edits = hist.rows.filter((r) => r.kind === 'edit').length;
  $('#history-count').textContent = WEB
    ? `${rows.length} shown. The browser keeps the room's recent activity; the CoDev app saves everything to a file.`
    : `${rows.length} shown · ${plural(prompts, 'prompt')} and ${plural(edits, 'change')} saved in .codev/history.jsonl`;

  const list = $('#history-list');
  if (!rows.length) {
    list.replaceChildren(h('p', { class: 'history-empty' }, hist.rows.length ? 'Nothing matches.' : 'Nothing yet. Every prompt, change, command and note in this room will be kept here.'));
    return;
  }
  const out = [];
  let day = '';
  for (const r of rows.slice(0, 1500)) {
    const d = new Date(r.ts);
    const label = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (label !== day) {
      day = label;
      out.push(h('h3', { class: 'history-day' }, label));
    }
    out.push(historyEntry(r, d));
  }
  list.replaceChildren(...out);
}

function historyEntry(r, d) {
  const quiet = ['read', 'tool', 'web', 'agent', 'plan'].includes(r.kind);
  const kind = r.kind === 'note'
    ? `note${r.to ? ` to ${r.to}` : ' to everyone'}${r.from === 'ai' ? ' (from the AI)' : ''}`
    : r.kind === 'prompt'
      ? `asked ${aiName(r.member)}`
      : KIND_WORD[r.kind] ?? r.kind;
  return h('article', { class: `entry ${r.kind}${quiet ? ' quiet' : ''}` },
    h('time', { class: 'entry-time', datetime: d.toISOString(), title: d.toLocaleString() }, d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })),
    h('div', {},
      h('div', { class: 'entry-who' }, h('span', { class: 'entry-name', style: `--person: ${colorOf(r.member)}` }, r.member), h('span', { class: 'entry-kind' }, kind), r.room !== S.cfg.room ? h('span', { class: 'entry-kind' }, `in ${r.room}`) : null),
      h('p', { class: 'entry-text' }, r.summary),
      r.files?.length && r.kind !== 'edit' ? h('p', { class: 'entry-files' }, r.files.join(', ')) : null,
      r.diff && (r.diff.old || r.diff.new) ? diffBlock(r.diff) : null));
}

function diffBlock({ old = '', new: neu = '' }) {
  const lines = [
    ...(old ? old.split('\n').map((l) => h('span', { class: 'l del' }, '- ' + l)) : []),
    ...(neu ? neu.split('\n').map((l) => h('span', { class: 'l add' }, '+ ' + l)) : []),
  ];
  const added = neu ? neu.split('\n').length : 0;
  const removed = old ? old.split('\n').length : 0;
  return h('details', {}, h('summary', {}, `Show the change (+${added} −${removed})`), h('pre', {}, lines));
}

/* ---------- Conversation view: each Claude as a chat ---------- */
// The same session, read like a chat: prompts, Claude's replies (from its transcript, sent by the
// hooks), what it did, and when it needs you. Your own windows have a box to write prompts.
S.view = store.get('codev:view') === 'convo' ? 'convo' : 'terminal';

const eventKey = (e) => `${e.ts}|${e.member}|${e.kind}|${String(e.summary || '').slice(0, 80)}`;
const seenEvents = new Set();

/** Adds events to S.events once (the snapshot, live events and the history file overlap). */
function mergeEvents(list) {
  let added = 0;
  for (const e of list) {
    const k = eventKey(e);
    if (seenEvents.has(k)) continue;
    seenEvents.add(k);
    S.events.push(e);
    added++;
  }
  if (added) S.events.sort((a, b) => a.ts - b.ts);
  if (S.events.length > 5000) S.events.splice(0, S.events.length - 5000);
  return added;
}

function setupViews() {
  const sw = $('#view-switch');
  sw.addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    S.view = b.dataset.view;
    store.set('codev:view', S.view);
    for (const p of S.panes.values()) {
      p.view = null; // the bar sets every window
      applyView(p);
    }
    renderViewSwitch();
  });
  renderViewSwitch();
}

function renderViewSwitch() {
  for (const b of $('#view-switch').children) b.setAttribute('aria-checked', String(b.dataset.view === S.view));
}

const viewOf = (p) => p.view || S.view;

function applyView(p) {
  const convo = viewOf(p) === 'convo';
  p.root.classList.toggle('view-convo', convo);
  if (p.ui) p.ui.side = null; // the header's toggle changes label
  if (convo) renderConvo(p, true);
}

function buildConvo(p) {
  const who = agentLabel(p.agent);
  p.cv = {
    list: h('div', { class: 'convo-list' }),
    working: h('div', { class: 'convo-working' }, `${who} is working`, h('span', { class: 'dots' }, '...')),
    typing: h('div', { class: 'convo-working' }, `${splitMember(p.member)[0]} is typing`, h('span', { class: 'dots' }, '...')),
  };
  p.convo.append(p.cv.list, p.cv.typing, p.cv.working);
  // The Harness terminal is already a chat: its prompts are typed in the terminal view.
  if (p.local && AGENTS[p.agent]?.engine !== 'harness') {
    const input = h('textarea', { rows: '1', placeholder: `Ask ${who} something`, autocomplete: 'off' });
    const form = h('form', { class: 'convo-form' }, input, h('button', { type: 'submit', class: 'send' }, 'Send'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      input.style.height = '';
      markTyping(p, '\r'); // sent: from here Claude works
      // Typed into Claude Code exactly like a paste, then Enter.
      api.ptyWrite(p.id, `\x1b[200~${text}\x1b[201~`);
      setTimeout(() => api.ptyWrite(p.id, '\r'), 40);
    });
    input.addEventListener('input', () => {
      markTyping(p, 'key'); // typing here counts like typing in the terminal
      input.style.height = '';
      input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    p.convo.append(form);
    p.cv.input = input;
  }
}

/** Light, safe Markdown for Claude's replies: code blocks, lists, headings, `code`, **bold**. */
function markdown(text) {
  const out = [];
  const parts = String(text).split(/```[\w-]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(h('pre', { class: 'md-code' }, part.replace(/\n$/, '')));
      return;
    }
    for (const block of part.split(/\n{2,}/)) {
      const lines = block.split('\n').filter((l) => l.trim());
      if (!lines.length) continue;
      if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
        const ordered = /^\s*\d+\./.test(lines[0]);
        out.push(h(ordered ? 'ol' : 'ul', { class: 'md-list' }, lines.map((l) => h('li', {}, inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))))));
      } else if (/^#{1,6}\s/.test(lines[0]) && lines.length === 1) {
        out.push(h('p', { class: 'md-h' }, inline(lines[0].replace(/^#+\s*/, ''))));
      } else {
        out.push(h('p', {}, lines.flatMap((l, j) => (j ? [h('br'), ...inline(l)] : inline(l)))));
      }
    }
  });
  return out;
}

function inline(text) {
  return String(text)
    .split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/)
    .filter(Boolean)
    .map((t) =>
      t.startsWith('`') && t.length > 2
        ? h('code', {}, t.slice(1, -1))
        : t.startsWith('**') && t.length > 4
          ? h('strong', {}, t.slice(2, -2))
          : t.startsWith('*') && t.endsWith('*') && t.length > 2
            ? h('em', {}, t.slice(1, -1))
            : t
    );
}

function renderConvo(p, force = false) {
  if (viewOf(p) !== 'convo') return;
  const evs = S.events.filter((e) => e.member === p.member && !['status', 'note'].includes(e.kind));
  const key = `${evs.length}|${evs.at(-1)?.ts || 0}`;
  const state = paneState(p);
  p.cv.working.hidden = state !== 'working';
  // Someone else typing a prompt: shown like in any chat (your own box needs no reminder).
  p.cv.typing.hidden = p.local || state !== 'writing';
  if (!force && p.cv.key === key) return;
  p.cv.key = key;
  const list = p.cv.list;
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  const out = [];
  let steps = null;
  const color = colorOf(p.member);
  const [person] = splitMember(p.member);
  for (const e of evs.slice(-400)) {
    if (e.kind === 'prompt') {
      steps = null;
      out.push(h('div', { class: 'cv-prompt', style: `--person: ${color}` }, h('span', { class: 'cv-who' }, p.local ? 'You' : person), h('p', {}, e.summary)));
    } else if (e.kind === 'reply') {
      steps = null;
      out.push(h('div', { class: 'cv-reply' }, miniBot(p.member), h('div', { class: 'cv-md' }, markdown(e.summary))));
    } else if (e.kind === 'attention') {
      steps = null;
      const last = e === evs.at(-1);
      out.push(
        h('div', { class: `cv-attention${last ? ' now' : ''}` },
          h('p', {}, e.summary),
          last
            ? h('button', { type: 'button', class: 'send', onclick: () => { p.view = 'terminal'; applyView(p); } }, p.local ? 'Answer in the terminal' : 'See the terminal')
            : null)
      );
    } else if (e.kind === 'conflict') {
      steps = null;
      out.push(h('div', { class: 'cv-system' }, `CoDev stopped this ${agentLabel(p.agent)}: ${e.files?.[0] || 'a file'} belongs to ${e.owner}.`));
    } else {
      if (!steps) {
        steps = h('div', { class: 'cv-steps' });
        out.push(steps);
      }
      const row = h('div', { class: `cv-step ${e.kind}` }, e.summary);
      steps.append(e.diff && (e.diff.old || e.diff.new) ? h('div', {}, row, diffBlock(e.diff)) : row);
    }
  }
  if (!out.length) {
    const harness = AGENTS[p.agent]?.engine === 'harness';
    out.push(h('p', { class: 'cv-empty' },
      harness
        ? `Type in the Terminal view. This window shows ${agentLabel(p.agent)}'s conversation.`
        : p.local
          ? `Write below to ask ${agentLabel(p.agent)} for something. Its replies and everything it does will show here.`
          : `When ${person} asks ${agentLabel(p.agent)} for something, the conversation shows here.`));
  }
  list.replaceChildren(...out);
  if (atBottom || force) list.scrollTop = list.scrollHeight;
}

/* ---------- Headers and character ---------- */
// One pixel character per AI. They share their parts (body, eyes, arms, antenna, smile) so that
// every state animates them the same way: working, typing, asleep...
const BOT_BODIES = {
  // Claude: the CoDev robot
  claude: `
    <rect class="ant-on" x="5" y="-3" width="6" height="1"/>
    <rect x="7" y="-1" width="2" height="2"/><rect x="7.5" y="1" width="1" height="2"/>
    <rect x="3" y="3" width="10" height="8"/><rect x="2" y="4" width="12" height="6"/>
    <g class="eyes"><rect class="cut" x="4" y="5" width="2" height="3"/><rect class="cut" x="10" y="5" width="2" height="3"/></g>
    <rect class="cut mouth" x="6" y="9" width="4" height="1"/>
    <rect class="cut smile" x="5" y="8" width="1" height="1"/><rect class="cut smile" x="10" y="8" width="1" height="1"/>
    <rect class="arm arm-l" x="0" y="6" width="2" height="4"/><rect class="arm arm-r" x="14" y="6" width="2" height="4"/>
    <rect x="4" y="11" width="3" height="2"/><rect x="9" y="11" width="3" height="2"/>`,
  // DeepSeek: a whale; its spout lights up when it works
  deepseek: `
    <rect class="ant-on" x="3" y="-2" width="4" height="1"/><rect class="ant-on" x="4.5" y="-1" width="1" height="3"/>
    <rect x="3" y="3" width="9" height="1"/><rect x="1" y="4" width="13" height="6"/><rect x="2" y="10" width="11" height="1"/>
    <rect x="13" y="5" width="2" height="2"/><rect x="14" y="2" width="2" height="4"/><rect x="15" y="1" width="1" height="2"/>
    <g class="eyes"><rect class="cut" x="4" y="5" width="2" height="2"/></g>
    <rect class="cut mouth" x="2" y="8" width="5" height="1"/><rect class="cut smile" x="7" y="7" width="1" height="1"/>
    <rect class="arm arm-l" x="5" y="11" width="2" height="2"/><rect class="arm arm-r" x="9" y="11" width="2" height="2"/>`,
  // A local model: a llama; its ears twitch when it works
  local: `
    <rect class="ant-on" x="2" y="-3" width="1" height="1"/><rect class="ant-on" x="5" y="-3" width="1" height="1"/>
    <rect x="2" y="-2" width="1" height="2"/><rect x="5" y="-2" width="1" height="2"/>
    <rect x="1" y="0" width="6" height="4"/><rect x="0" y="2" width="1" height="2"/>
    <g class="eyes"><rect class="cut" x="2" y="1" width="1" height="1"/><rect class="cut" x="5" y="1" width="1" height="1"/></g>
    <rect class="cut smile" x="1" y="3" width="2" height="1"/>
    <rect x="3" y="4" width="3" height="4"/><rect x="3" y="7" width="11" height="4"/><rect x="14" y="7" width="1" height="2"/>
    <rect class="arm arm-l" x="4" y="11" width="2" height="3"/><rect x="7" y="11" width="1" height="3"/>
    <rect class="arm arm-r" x="11" y="11" width="2" height="3"/><rect x="13" y="11" width="1" height="3"/>`,
  // ChatGPT (Codex): a robot with a visor
  chatgpt: `
    <rect class="ant-on" x="3" y="-2" width="2" height="1"/><rect class="ant-on" x="11" y="-2" width="2" height="1"/>
    <rect x="4" y="-1" width="1" height="3"/><rect x="11" y="-1" width="1" height="3"/>
    <rect x="3" y="2" width="10" height="1"/><rect x="2" y="3" width="12" height="8"/>
    <g class="eyes"><rect class="cut" x="3" y="5" width="10" height="2"/></g>
    <rect x="5" y="5" width="1" height="2"/><rect x="10" y="5" width="1" height="2"/>
    <rect class="cut mouth" x="6" y="9" width="4" height="1"/>
    <rect class="arm arm-l" x="0" y="5" width="2" height="5"/><rect class="arm arm-r" x="14" y="5" width="2" height="5"/>
    <rect x="4" y="11" width="3" height="2"/><rect x="9" y="11" width="3" height="2"/>`,
};

/** Which AI a member's terminal runs. Claude when we have not heard from that terminal yet. */
const agentOf = (member) => [...S.panes.values()].find((p) => p.member === member)?.agent || 'claude';

/** The AI name of whoever wrote a message: "DeepSeek", "ChatGPT"… */
const aiName = (member) => agentLabel(agentOf(member));

const botSvg = (agent = 'claude') => `
<svg class="bot" viewBox="-2 -3 26 19" shape-rendering="crispEdges" aria-hidden="true">
  <g class="body">${BOT_BODIES[agent] || BOT_BODIES.claude}</g>
  <rect class="spark s1" x="16" y="0" width="2" height="2"/>
  <rect class="spark s2" x="-2" y="1" width="1" height="1"/>
  <text class="zz z1" x="15.5" y="5" style="font-size:6px">z</text>
  <text class="zz z2" x="19" y="1" style="font-size:4.5px">z</text>
  <rect class="dot d1" x="17" y="11" width="1.5" height="1.5"/>
  <rect class="dot d2" x="19.5" y="11" width="1.5" height="1.5"/>
  <rect class="dot d3" x="22" y="11" width="1.5" height="1.5"/>
</svg>`;

const STATE_LABEL = {
  working: 'working',
  asking: 'needs you',
  writing: 'typing',
  waiting: 'waiting',
  sleeping: 'asleep',
  blocked: 'stopped by CoDev',
  offline: 'offline',
};

/**
 * Output alone does not mean Claude is working: a click or a resize makes it redraw once.
 * Working output is sustained (the spinner ticks several times a second), so we keep a few
 * timestamps at least 200 ms apart and call it work when 4 of them fall in the last 2 seconds.
 */
function noteOutput(p) {
  const now = Date.now();
  p.lastOutput = now;
  p.outTimes ||= [];
  if (!p.outTimes.length || now - p.outTimes.at(-1) >= 200) {
    p.outTimes.push(now);
    if (p.outTimes.length > 8) p.outTimes.shift();
  }
}
const busyOutput = (p, now) => (p.outTimes || []).filter((t) => now - t < 2000).length >= 4;

/** What this Claude is doing right now. */
function paneState(p) {
  const now = Date.now();
  const m = S.members.get(p.member);
  if (m?.status === 'offline') return 'offline';
  if (now - (S.blockedAt?.get(p.member) || 0) < 8000) return 'blocked';
  if (now - (p.lastKey || 0) < 2500) return 'writing';
  // Claude asked for something (a permission, a question) and nothing happened since.
  const lastEv = S.events.findLast((e) => e.member === p.member && !['status', 'note'].includes(e.kind));
  if (lastEv?.kind === 'attention' && now - lastEv.ts < 30 * 60_000) return 'asking';
  const hookWorking = m?.status === 'working' && now - m.lastSeen < 5 * 60_000;
  if (hookWorking || busyOutput(p, now)) return 'working';
  const last = Math.max(p.lastKey || 0, p.lastOutput || 0, m?.lastSeen || 0, p.createdAt);
  if (now - last > 2 * 60_000) return 'sleeping';
  return 'waiting';
}

function buildHead(p) {
  const bot = document.createElement('div');
  bot.innerHTML = botSvg(p.agent);
  p.ui = {
    bot: bot.firstElementChild,
    name: h('span', { class: 'who-name' }, splitMember(p.member)[0]),
    label: splitMember(p.member)[1] ? h('span', { class: 'who-label' }, `· ${splitMember(p.member)[1]}`) : null,
    ai: h('span', { class: 'who-ai' }, agentLabel(p.agent)),
    state: h('span', { class: 'who-state' }),
    intent: h('div', { class: 'intent' }),
    files: h('div', { class: 'files' }),
    // What is left on the DeepSeek account: only on your own DeepSeek terminals (the key is yours).
    balance: p.local && !WEB && p.agent === 'deepseek' ? h('span', { class: 'who-balance', hidden: true }) : null,
    sideEl: h('div', { class: 'head-side' }),
    side: null,
  };
  p.head.append(
    p.ui.bot,
    h('div', { class: 'who-main' }, h('div', { class: 'who-line' }, p.ui.name, p.ui.label, p.ui.ai, p.ui.balance, p.ui.state), p.ui.intent, p.ui.files),
    p.ui.sideEl
  );
}

/** Right side of a header: Close (yours), Stop (a guest running on this computer) or "view only". */
function updateSide(p) {
  const kind = p.local ? 'local' : S.guestIds.has(p.id) ? 'guest' : 'remote';
  if (p.ui.side === kind + viewOf(p)) return;
  p.ui.side = kind + viewOf(p);
  const toggle = h('button', { class: 'icon-btn', title: 'Switch this window between terminal and conversation', onclick: () => { p.view = viewOf(p) === 'convo' ? 'terminal' : 'convo'; applyView(p); } }, viewOf(p) === 'convo' ? 'Terminal' : 'Conversation');
  p.ui.sideEl.replaceChildren(
    toggle,
    ...[].concat(
    kind === 'local'
      ? h('button', { class: 'icon-btn', title: 'Close this terminal', onclick: () => closeLocal(p) }, 'Close')
      : kind === 'guest'
        ? [
            h('span', { class: 'readonly' }, 'running on this computer'),
            h('button', { class: 'icon-btn', title: 'Stop this guest terminal', onclick: () => api.guestStop(p.id) }, 'Stop'),
          ]
        : h('span', { class: 'readonly' }, 'view only')
    )
  );
}

function updateHead(p) {
  if (!p.ui) buildHead(p);
  const color = colorOf(p.member);
  if (p.color !== color) {
    p.color = color;
    p.root.style.setProperty('--person', color);
  }
  updateSide(p);
  const m = S.members.get(p.member);
  const st = paneState(p);
  if (p.state !== st) {
    // A DeepSeek turn just ended: that is when the balance changes.
    if (p.ui.balance && p.state === 'working') refreshBalance(true);
    p.state = st;
    p.head.className = `pane-head st-${st}`;
    p.ui.state.textContent = p.local && st !== 'offline' ? `${STATE_LABEL[st]} · you` : STATE_LABEL[st];
  }
  const intent = m?.intent || (p.local ? `Type in the terminal to ask ${agentLabel(p.agent)} for something.` : 'Has not asked for anything yet.');
  if (p.ui.intent.textContent !== intent) {
    p.ui.intent.textContent = intent;
    p.ui.intent.title = m?.intent || '';
    p.ui.intent.classList.toggle('empty', !m?.intent);
  }
  const files = S.claims.filter((c) => c.owner === p.member).map((c) => c.file);
  const key = files.join(',');
  if (p.ui.filesKey !== key) {
    p.ui.filesKey = key;
    p.ui.files.hidden = !files.length;
    p.ui.files.replaceChildren('Holding ', h('strong', {}, files.join(', ')));
    p.ui.files.title = files.join('\n');
  }
  if (p.ui.balance) updateBalance(p);
}

/* ---------- DeepSeek balance ---------- */
const BALANCE = { value: null, at: 0, loading: null };
const CURRENCY = { CNY: '¥', USD: '$' };

function refreshBalance(fresh = false) {
  if (WEB || !api.agentBalance || BALANCE.loading) return;
  if (!fresh && BALANCE.at && Date.now() - BALANCE.at < 60_000) return;
  BALANCE.loading = api
    .agentBalance('deepseek', fresh)
    .then((v) => (BALANCE.value = v))
    .catch((err) => (BALANCE.value = { error: err.message }))
    .finally(() => {
      BALANCE.at = Date.now();
      BALANCE.loading = null;
    });
}

function updateBalance(p) {
  refreshBalance();
  const v = BALANCE.value;
  let text = '';
  let title = '';
  let low = false;
  if (v?.error) {
    text = 'Balance ?';
    title = v.error === 'no key' ? 'No DeepSeek API key saved.' : `Could not read the DeepSeek balance: ${v.error}`;
  } else if (v?.balances?.length) {
    text = v.balances.map((b) => `${CURRENCY[b.currency] ?? `${b.currency} `}${b.total.toFixed(2)}`).join(' · ') + ' left';
    low = !v.available || v.balances.every((b) => b.total < 1);
    title = v.available ? 'What is left on your DeepSeek account. Updated every minute and after each turn.' : 'Your DeepSeek account has no balance left: top it up to keep using it.';
  } else if (v && !v.available) {
    text = 'No balance';
    low = true;
    title = 'Your DeepSeek account has no balance left: top it up to keep using it.';
  }
  const el = p.ui.balance;
  if (el.textContent !== text) el.textContent = text;
  el.title = title;
  el.hidden = !text;
  el.classList.toggle('low', low);
}

function renderHeads() {
  for (const p of S.panes.values()) {
    updateHead(p);
    renderConvo(p);
  }
  if (S.cfg) updateNoteTargets();
}
setInterval(renderHeads, 400);

/** Everyone in the room can get a message: people with a terminal and people watching from a browser. */
function updateNoteTargets() {
  const box = $('#note-to');
  const others = [...new Set([...S.members.keys(), ...[...S.panes.values()].map((p) => p.member)])]
    .filter((n) => !isMe(n) && (S.members.get(n)?.viewers || [...S.panes.values()].some((p) => p.member === n) || S.members.get(n)?.status !== 'offline'))
    .sort();
  if (S.noteTo && !others.includes(S.noteTo)) S.noteTo = '';
  const key = others.map((n) => `${n}:${colorOf(n)}`).join('|') + `#${S.noteTo || ''}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  const chip = (name, label) => {
    const b = h('button', { type: 'button', class: `to-chip${name ? '' : ' everyone'}`, role: 'radio', 'aria-checked': String((S.noteTo || '') === name) }, label);
    if (name) b.style.setProperty('--person', colorOf(name));
    b.addEventListener('click', () => {
      S.noteTo = name;
      updateNoteTargets();
      $('#note-text').focus();
    });
    return b;
  };
  box.replaceChildren(chip('', 'Everyone'), ...others.map((n) => chip(n, n)));
  renderChatPeople();
}
