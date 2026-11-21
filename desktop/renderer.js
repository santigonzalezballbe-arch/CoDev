// Interfície de l'app: terminals locals de Claude Code (s'hi pot escriure) i rèpliques en directe dels companys.
import { Terminal } from '../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { SerializeAddon } from '../node_modules/@xterm/addon-serialize/lib/addon-serialize.mjs';
import { Unicode11Addon } from '../node_modules/@xterm/addon-unicode11/lib/addon-unicode11.mjs';

const $ = (sel) => document.querySelector(sel);
const api = window.codev;

const PALETTE = ['#7c9cff', '#ff8a65', '#4dd0a1', '#e57bd8', '#ffd166', '#5ec8f2', '#b39ddb', '#f28482'];
const colorFor = (name) => {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

const THEME = {
  background: '#0b0d12', foreground: '#e6e8ef', cursor: '#e6e8ef', cursorAccent: '#0b0d12',
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
  panes: new Map(), // id -> pane (locals i remots)
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

/* ================= Pantalla d'inici ================= */
const form = $('#start-form');
const saved = store.get('codev:start') || {};
for (const k of ['project', 'name', 'room', 'server']) if (saved[k]) form[k].value = saved[k];
if (saved.mode) form.mode.value = saved.mode;
const syncMode = () => ($('#server-field').hidden = form.mode.value !== 'join');
syncMode();
form.addEventListener('change', syncMode);

$('#pick').addEventListener('click', async () => {
  const dir = await api.pickFolder();
  if (dir) form.project.value = dir;
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#start-error');
  err.hidden = true;
  const v = {
    project: form.project.value.trim(),
    name: form.name.value.trim(),
    room: form.room.value.trim(),
    mode: form.mode.value,
    server: form.server.value.trim().replace(/\/$/, ''),
  };
  if (!v.project) return showError('Tria la carpeta del projecte.');
  if (v.mode === 'join' && !/^https?:\/\//.test(v.server)) return showError("Escriu l'adreça del servidor (p. ex. http://192.168.1.20:4321).");
  store.set('codev:start', v);
  $('#enter').disabled = true;
  $('#enter').textContent = 'Connectant…';
  try {
    let server = v.server;
    let lan = [];
    if (v.mode === 'host') ({ url: server, lan } = await api.hostServer(4321));
    const r = await api.setupProject({ root: v.project, server, room: v.room, name: v.name });
    if (!r.reachable) throw new Error(`No arribo al servidor ${server}.`);
    S.cfg = { root: v.project, server, room: v.room, name: v.name, lan };
    await document.fonts.load('13px "JetBrains Mono"');
    await document.fonts.load('bold 13px "JetBrains Mono"');
    openWorkspace();
  } catch (ex) {
    showError(String(ex.message || ex).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  } finally {
    $('#enter').disabled = false;
    $('#enter').textContent = 'Entra';
  }

  function showError(text) {
    err.textContent = text;
    err.hidden = false;
  }
});

/* ================= Espai de treball ================= */
function openWorkspace() {
  $('#start').hidden = true;
  $('#app').hidden = false;
  $('#room-name').textContent = S.cfg.room;
  document.title = `${S.cfg.room} · CoDev`;

  $('#invite').addEventListener('click', () => {
    const addr = S.cfg.lan[0] || S.cfg.server;
    api.copy(`Uneix-te a la meva sala de CoDev.\nSala: ${S.cfg.room}\nServidor: ${addr}`);
    flash(`Invitació copiada (servidor ${addr}). Envia-la al teu company.`, 'info');
  });
  $('#add-claude').addEventListener('click', () => addLocal());
  $('#note-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#note-text').value.trim();
    if (!text) return;
    $('#note-text').value = '';
    post('note', { text, to: $('#note-to').value || null, from: 'human' });
  });

  connectEvents();
  connectTerminals();
  // Arrenquem Claude quan ja sabem quants panells hi ha: si la terminal s'encongeix just després
  // d'arrencar, el redibuixat deixa restes.
  const first = new Promise((resolve) => {
    S.onFirstTerms = resolve;
    setTimeout(resolve, 1500);
  });
  first.then(() => addLocal());
  setInterval(renderHeads, 15_000);
}

function post(action, body) {
  return fetch(`${S.cfg.server}/api/rooms/${encodeURIComponent(S.cfg.room)}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ member: S.cfg.name, ...body }),
  }).catch(() => {});
}

let flashTimer;
function flash(text, kind = 'danger') {
  const el = $('#alert');
  el.textContent = text;
  el.className = `alert ${kind === 'info' ? 'info' : ''}`;
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (el.hidden = true), 7000);
}

/* ---------- Esdeveniments de la sala (SSE): tasques, fitxers, conflictes, notes ---------- */
function connectEvents() {
  const url = `${S.cfg.server}/api/rooms/${encodeURIComponent(S.cfg.room)}/stream?viewer=${encodeURIComponent(S.cfg.name)}`;
  const es = new EventSource(url);
  es.onmessage = (msg) => {
    const { type, data } = JSON.parse(msg.data);
    if (type === 'snapshot') {
      S.members = new Map(data.members.map((m) => [m.name, m]));
      S.claims = data.claims;
    } else if (type === 'member') S.members.set(data.name, data);
    else if (type === 'claims') S.claims = data;
    else if (type === 'tick') for (const m of data.members) S.members.set(m.name, m);
    else if (type === 'event') onEvent(data);
    renderHeads();
  };
}

const isMine = (member) => [...S.panes.values()].some((p) => p.local && p.member === member);

function onEvent(ev) {
  if (ev.kind === 'conflict' && (isMine(ev.member) || isMine(ev.owner))) {
    flash(isMine(ev.member)
      ? `La teva IA volia tocar ${ev.files[0]}, però és de ${ev.owner}. CoDev l'ha aturada.`
      : `La IA de ${ev.member} volia tocar ${ev.files[0]} (és teu). CoDev l'ha aturada.`);
  } else if (ev.kind === 'note' && !isMine(ev.member) && (!ev.to || isMine(ev.to))) {
    flash(`Nota de ${ev.member}${ev.from === 'ai' ? ' (IA)' : ''}: ${ev.summary}`, 'info');
  }
}

/* ---------- Retransmissió de terminals (WebSocket) ---------- */
function connectTerminals() {
  const url = `${S.cfg.server.replace(/^http/, 'ws')}/ws?room=${encodeURIComponent(S.cfg.room)}&member=${encodeURIComponent(S.cfg.name)}`;
  const ws = new WebSocket(url);
  S.ws = ws;
  ws.onopen = () => {
    $('#conn').classList.add('on');
    for (const p of S.panes.values()) if (p.local) announce(p);
  };
  ws.onclose = () => {
    $('#conn').classList.remove('on');
    for (const p of [...S.panes.values()]) if (!p.local) removePane(p);
    setTimeout(connectTerminals, 2000);
  };
  ws.onmessage = (msg) => {
    const m = JSON.parse(msg.data);
    if (m.t === 'terms') {
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
      S.panes.get(m.id)?.term.write(m.d);
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

/* ---------- Panells ---------- */
function makePane({ id, member, local, title }) {
  const head = h('header', { class: 'pane-head' });
  const host = h('div', { class: 'term-host' });
  const waiting = h('div', { class: 'waiting' }, local ? 'Obrint Claude Code…' : `Esperant la terminal de ${member}…`);
  const wrap = h('div', { class: 'term-wrap' }, host, waiting);
  const root = h('article', { class: `pane ${local ? 'local' : 'remote'}` }, head, wrap);
  root.style.setProperty('--c', colorFor(member));
  const pane = { id, member, local, title, root, head, host, wrap, waiting };
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

/** Terminal local: un Claude Code real en un PTY. Es retransmet a la sala. */
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

  // Ctrl+Shift+C / Ctrl+Shift+V per copiar i enganxar (Ctrl+C continua anant a Claude).
  p.term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
      if (p.term.hasSelection()) api.copy(p.term.getSelection());
      return false;
    }
    return true;
  });

  p.term.onData((d) => api.ptyWrite(id, d));
  p.term.onResize(({ cols, rows }) => {
    api.ptyResize(id, cols, rows);
    wsSend({ t: 'term-resize', id, cols, rows });
  });
  // Agrupem els canvis de mida: cada canvi fa que Claude Code ho redibuixi tot.
  p.ro = new ResizeObserver(() => {
    clearTimeout(p.fitTimer);
    p.fitTimer = setTimeout(() => {
      try { p.fit.fit(); } catch {}
    }, 120);
  });
  p.ro.observe(p.wrap);

  // Foto periòdica perquè qui es connecti tard vegi la pantalla exacta.
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
    env: { CODEV_SERVER: S.cfg.server, CODEV_ROOM: S.cfg.room, CODEV_NAME: p.member, CODEV_ROOT: S.cfg.root },
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
  // Enviem la sortida quan xterm ja l'ha processada: així les fotos i els trossos queden ben ordenats.
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
    `Claude Code s'ha tancat (codi ${code}).`,
    h('button', { onclick: () => { p.term.reset(); startPty(p).then(() => announce(p)); } }, 'Reinicia'),
    h('button', { class: 'ghost', onclick: () => closeLocal(p) }, 'Tanca'));
  p.wrap.append(p.exited);
});

function closeLocal(p) {
  api.ptyKill(p.id);
  wsSend({ t: 'term-close', id: p.id });
  removePane(p);
}

/** Terminal remota: rèplica de només lectura de la terminal d'un company. */
function addRemote(info) {
  const p = makePane({ id: info.id, member: info.member, local: false, title: info.title });
  p.term = newTerminal({ disableStdin: true, cursorBlink: false, cols: info.cols, rows: info.rows, scrollback: 1000 });
  p.term.open(p.host);
  p.ro = new ResizeObserver(() => rescale(p));
  p.ro.observe(p.wrap);
}

/** Escala la rèplica perquè hi càpiga sencera amb les mateixes columnes i files que l'original. */
function rescale(p) {
  const screen = p.host.querySelector('.xterm-screen');
  if (!screen || !screen.offsetWidth) return;
  const cs = getComputedStyle(p.wrap);
  const w = p.wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const hgt = p.wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const s = Math.min(w / screen.offsetWidth, hgt / screen.offsetHeight, 1.25);
  p.host.style.transform = `scale(${s})`;
}

/* ---------- Capçaleres ---------- */
function statusOf(m) {
  if (!m) return ['idle', 'esperant'];
  if (m.status === 'working' && Date.now() - m.lastSeen < 5 * 60_000) return ['working', 'IA treballant'];
  if (m.status === 'offline') return ['offline', 'desconnectat'];
  return ['idle', 'esperant'];
}

function renderHeads() {
  for (const p of S.panes.values()) {
    const m = S.members.get(p.member);
    const [cls, label] = statusOf(m);
    const claims = S.claims.filter((c) => c.owner === p.member);
    const mine = p.local;
    p.head.replaceChildren(
      h('div', { class: 'who' },
        h('div', { class: 'avatar' }, p.member.slice(0, 1).toUpperCase()),
        h('div', {},
          h('div', { class: 'who-name' }, mine ? `${p.member} (tu)` : p.member),
          h('div', { class: 'who-sub' }, mine ? 'La teva IA · pots escriure-hi' : `IA de ${p.member}`)),
        !mine && h('span', { class: 'tag' }, 'només lectura'),
        h('span', { class: `badge ${cls}` }, label),
        mine && S.localCount > 0 && h('button', { class: 'icon-btn', title: 'Tanca aquesta terminal', onclick: () => closeLocal(p) }, '×')),
      h('div', { class: 'context' },
        h('span', { class: 'intent' + (m?.intent ? '' : ' empty'), title: m?.intent || '' }, m?.intent || 'Encara no ha demanat res a la IA.'),
        claims.length ? h('div', { class: 'chips' }, claims.map((c) => h('span', { class: 'chip', title: c.intent || '' }, c.file))) : null)
    );
  }
}

function updateNoteTargets() {
  const sel = $('#note-to');
  const prev = sel.value;
  const others = [...new Set([...S.panes.values()].filter((p) => !p.local).map((p) => p.member))];
  sel.replaceChildren(h('option', { value: '' }, 'A tothom'), ...others.map((n) => h('option', { value: n }, `A ${n}`)));
  sel.value = others.includes(prev) ? prev : '';
}
