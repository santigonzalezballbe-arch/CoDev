// CoDev UI: local Claude Code terminals (you can type in them) and live replicas of your teammates' terminals.
// The same file runs in the desktop app and, served by the room's server, in a browser (watch-only).
import { Terminal } from '../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { SerializeAddon } from '../node_modules/@xterm/addon-serialize/lib/addon-serialize.mjs';
import { Unicode11Addon } from '../node_modules/@xterm/addon-unicode11/lib/addon-unicode11.mjs';

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
  ptyCreate: ({ id, cols, rows }) =>
    new Promise((resolve, reject) => {
      guestPending.set(id, { resolve, reject });
      wsSend({ t: 'guest-open', id, cols, rows });
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
const ui = { source: saved.source || 'github', mode: saved.mode || 'host', reach: saved.reach || 'lan', roomRepo: null };
for (const k of ['project', 'name', 'room', 'server', 'repo']) if (saved[k]) form[k].value = saved[k];

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
  let size = Math.min(280, window.innerHeight * 0.3, window.innerWidth * 0.16);
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
  };
  const joinKey = form.key.value.trim();
  if (WEB) return enterAsViewer(v.name, v.room, joinKey);
  if (!v.name) return showError('Write your name.');
  if (v.source === 'github' && !v.repo) return showError('Choose a GitHub repository.');
  if (v.source === 'folder' && !v.project) return showError('Choose the project folder.');
  if (!v.room) return showError('Give the room a name.');
  if (v.mode === 'join' && !/^https?:\/\//.test(v.server)) return showError('Paste the invite your teammate sent you.');
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
    S.cfg = { root, server, room: v.room, name: v.name, lan, key, publicUrl, host: v.mode === 'host', repo: repoFull };
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
  S.cfg = { root: null, server: location.origin, room, name, key, lan: [], publicUrl: null, host: false, repo: null };
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
  $('#add-claude').addEventListener('click', () => addLocal());
  $('#note-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#note-text').value.trim();
    if (!text) return;
    $('#note-text').value = '';
    post('note', { text, to: $('#note-to').value || null, from: 'human' });
  });

  connectTerminals();
  // Start Claude once we know how many panes there are: if the terminal shrinks right after
  // starting, the redraw leaves artifacts behind.
  const first = new Promise((resolve) => {
    S.onFirstTerms = resolve;
    setTimeout(resolve, 1500);
  });
  if (!WEB) first.then(() => addLocal());
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
  } else if (type === 'member') S.members.set(data.name, data);
  else if (type === 'claims') S.claims = data;
  else if (type === 'tick') for (const m of data.members) S.members.set(m.name, m);
  else if (type === 'event') onEvent(data);
  renderHeads();
}

const isMine = (member) => [...S.panes.values()].some((p) => p.local && p.member === member);

function onEvent(ev) {
  if (ev.kind === 'conflict') (S.blockedAt ||= new Map()).set(ev.member, Date.now());
  if (ev.kind === 'conflict' && (isMine(ev.member) || isMine(ev.owner))) {
    flash(isMine(ev.member)
      ? `Your AI wanted to touch ${ev.files[0]}, but it belongs to ${ev.owner}. CoDev stopped it.`
      : `${ev.member}'s AI wanted to touch ${ev.files[0]} (yours). CoDev stopped it.`);
  } else if (ev.kind === 'note' && !isMine(ev.member) && (!ev.to || isMine(ev.to))) {
    flash(`Note from ${ev.member}${ev.from === 'ai' ? ' (AI)' : ''}: ${ev.summary}`, 'info');
  }
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
        p.lastOutput = Date.now();
        p.term.write(m.d);
      }
    } else if (m.t === 'term-typing') {
      const p = S.panes.get(m.id);
      if (p) p.lastKey = Date.now();
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
    wsSend({ t: 'term-open', id: p.id, member: p.member, title: p.title, cols: p.term.cols, rows: p.term.rows, d: p.ser.serialize({ scrollback: 1000 }) });
  });
}

/* ---------- Panes ---------- */
function makePane({ id, member, local, title }) {
  const head = h('header', { class: 'pane-head' });
  const host = h('div', { class: 'term-host' });
  const waiting = h(
    'div',
    { class: 'waiting' },
    local ? (WEB ? 'Asking the host to open your Claude Code… they have to click Allow.' : 'Opening Claude Code…') : `Waiting for ${member}'s terminal…`
  );
  const wrap = h('div', { class: 'term-wrap' }, host, waiting);
  const root = h('article', { class: `pane ${local ? 'local' : 'remote'}` }, head, wrap);
  const pane = { id, member, local, title, root, head, host, wrap, waiting, createdAt: Date.now() };
  S.panes.set(id, pane);
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

/** Local terminal: a real Claude Code in a PTY, relayed to the room. */
async function addLocal() {
  const idx = ++S.localCount;
  const member = idx === 1 ? S.cfg.name : `${S.cfg.name} ${idx}`;
  const id = `${S.cfg.name.replace(/\W+/g, '_')}-${Date.now().toString(36)}-${idx}`;
  const p = makePane({ id, member, local: true, title: 'Claude Code' });

  p.term = newTerminal({ cursorBlink: true });
  p.fit = new FitAddon();
  p.ser = new SerializeAddon();
  p.term.loadAddon(p.fit);
  p.term.loadAddon(p.ser);
  p.term.open(p.host);
  p.fit.fit();
  p.queue = [];

  // Ctrl+Shift+C / Ctrl+Shift+V to copy and paste (Ctrl+C still goes to Claude).
  p.term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      if (p.term.hasSelection()) api.copy(p.term.getSelection());
      return false;
    }
    return true;
  });

  p.term.onData((d) => {
    api.ptyWrite(id, d);
    const now = Date.now();
    p.lastKey = now;
    // Tell teammates you are typing (only the fact, never the text), at most once every 0.8 s.
    if (!p.typingSent || now - p.typingSent > 800) {
      p.typingSent = now;
      wsSend({ t: 'term-typing', id });
    }
  });
  p.term.onResize(({ cols, rows }) => {
    api.ptyResize(id, cols, rows);
    wsSend({ t: 'term-resize', id, cols, rows });
  });
  // Batch resizes: each one makes Claude Code redraw everything.
  p.ro = new ResizeObserver(() => {
    clearTimeout(p.fitTimer);
    p.fitTimer = setTimeout(() => {
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
    command: 'claude',
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
  p.lastOutput = Date.now();
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
    `Claude Code exited (code ${code}).`,
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
  const p = makePane({ id: info.id, member: info.member, local: false, title: info.title });
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
  const s = Math.min(w / screen.offsetWidth, hgt / screen.offsetHeight, 1.25);
  p.host.style.transform = `scale(${s})`;
}

/* ---------- Headers and character ---------- */
const BOT_SVG = `
<svg class="bot" viewBox="-2 -3 26 19" shape-rendering="crispEdges" aria-hidden="true">
  <g class="body">
    <rect class="ant-on" x="5" y="-3" width="6" height="1"/>
    <rect x="7" y="-1" width="2" height="2"/>
    <rect x="7.5" y="1" width="1" height="2"/>
    <rect x="3" y="3" width="10" height="8"/>
    <rect x="2" y="4" width="12" height="6"/>
    <g class="eyes"><rect class="cut" x="4" y="5" width="2" height="3"/><rect class="cut" x="10" y="5" width="2" height="3"/></g>
    <rect class="cut mouth" x="6" y="9" width="4" height="1"/>
    <rect class="cut smile" x="5" y="8" width="1" height="1"/>
    <rect class="cut smile" x="10" y="8" width="1" height="1"/>
    <rect class="arm arm-l" x="0" y="6" width="2" height="4"/>
    <rect class="arm arm-r" x="14" y="6" width="2" height="4"/>
    <rect x="4" y="11" width="3" height="2"/>
    <rect x="9" y="11" width="3" height="2"/>
  </g>
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
  writing: 'typing',
  waiting: 'waiting',
  sleeping: 'asleep',
  blocked: 'stopped by CoDev',
  offline: 'offline',
};

/** What this Claude is doing right now. */
function paneState(p) {
  const now = Date.now();
  const m = S.members.get(p.member);
  if (m?.status === 'offline') return 'offline';
  if (now - (S.blockedAt?.get(p.member) || 0) < 8000) return 'blocked';
  if (now - (p.lastKey || 0) < 2500) return 'writing';
  const hookWorking = m?.status === 'working' && now - m.lastSeen < 5 * 60_000;
  if (hookWorking || now - (p.lastOutput || 0) < 1500) return 'working';
  const last = Math.max(p.lastKey || 0, p.lastOutput || 0, m?.lastSeen || 0, p.createdAt);
  if (now - last > 2 * 60_000) return 'sleeping';
  return 'waiting';
}

function buildHead(p) {
  const bot = document.createElement('div');
  bot.innerHTML = BOT_SVG;
  p.ui = {
    bot: bot.firstElementChild,
    name: h('span', { class: 'who-name' }, p.member),
    state: h('span', { class: 'who-state' }),
    intent: h('div', { class: 'intent' }),
    files: h('div', { class: 'files' }),
    sideEl: h('div', { class: 'head-side' }),
    side: null,
  };
  p.head.append(
    p.ui.bot,
    h('div', { class: 'who-main' }, h('div', { class: 'who-line' }, p.ui.name, p.ui.state), p.ui.intent, p.ui.files),
    p.ui.sideEl
  );
}

/** Right side of a header: Close (yours), Stop (a guest running on this computer) or "view only". */
function updateSide(p) {
  const kind = p.local ? 'local' : S.guestIds.has(p.id) ? 'guest' : 'remote';
  if (p.ui.side === kind) return;
  p.ui.side = kind;
  p.ui.sideEl.replaceChildren(
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
  updateSide(p);
  const m = S.members.get(p.member);
  const st = paneState(p);
  if (p.state !== st) {
    p.state = st;
    p.head.className = `pane-head st-${st}`;
    p.ui.state.textContent = p.local && st !== 'offline' ? `${STATE_LABEL[st]} · you` : STATE_LABEL[st];
  }
  const intent = m?.intent || (p.local ? 'Type in the terminal to ask Claude for something.' : 'Has not asked for anything yet.');
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
}

function renderHeads() {
  for (const p of S.panes.values()) updateHead(p);
}
setInterval(renderHeads, 400);

function updateNoteTargets() {
  const sel = $('#note-to');
  const prev = sel.value;
  const others = [...new Set([...S.panes.values()].filter((p) => !p.local).map((p) => p.member))];
  sel.replaceChildren(h('option', { value: '' }, 'Everyone'), ...others.map((n) => h('option', { value: n }, `To ${n}`)));
  sel.value = others.includes(prev) ? prev : '';
}
