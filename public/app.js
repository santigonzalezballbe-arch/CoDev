// Web de CoDev: una columna per persona; la teva primer. Es manté al dia amb Server-Sent Events.
const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const room = params.get('room');
const me = params.get('name');

const ICONS = { edit: '✎', command: '$', read: '◎', web: '⌁', agent: '⑂', plan: '☰', prompt: '❝', conflict: '⚠', note: '✉', status: '•', tool: '·' };

const state = { members: new Map(), claims: [], events: [], skew: 0 };
const evNodes = new Map(); // id -> node (es reutilitzen per no perdre els <details> oberts)
const cols = new Map(); // nom -> { root, head, feed }

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

const now = () => Date.now() + state.skew;
function ago(ts) {
  const s = Math.max(0, Math.round((now() - ts) / 1000));
  if (s < 10) return 'ara';
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

/* ---------- Entrada ---------- */
if (!room || !me) {
  $('#join').hidden = false;
  const f = $('#join-form');
  f.room.value = room || '';
  f.name.value = me || localStorageGet('codev:name') || '';
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    localStorageSet('codev:name', f.name.value.trim());
    location.search = new URLSearchParams({ room: f.room.value.trim(), name: f.name.value.trim() });
  });
} else {
  startRoom();
}

function localStorageGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function localStorageSet(k, v) {
  try { localStorage.setItem(k, v); } catch {}
}

/* ---------- Sala ---------- */
function startRoom() {
  $('#app').hidden = false;
  $('#room-name').textContent = room;
  document.title = `${room} · CoDev`;

  $('#copy-link').addEventListener('click', async () => {
    const url = `${location.origin}/?room=${encodeURIComponent(room)}`;
    try {
      await navigator.clipboard.writeText(url);
      flash('Enllaç copiat. Envia\'l al teu company.', false);
    } catch {
      flash(url, false);
    }
  });

  $('#note-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#note-text');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await post('note', { text, to: $('#note-to').value || null, from: 'human' });
  });

  connect();
  setInterval(refreshTimes, 15_000);
}

function post(action, body) {
  return fetch(`/api/rooms/${encodeURIComponent(room)}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ member: me, ...body }),
  }).catch(() => {});
}

function connect() {
  const es = new EventSource(`/api/rooms/${encodeURIComponent(room)}/stream?viewer=${encodeURIComponent(me)}`);
  es.onopen = () => $('#conn').classList.add('on');
  es.onerror = () => $('#conn').classList.remove('on');
  es.onmessage = (msg) => {
    const { type, data } = JSON.parse(msg.data);
    if (type === 'snapshot') {
      state.skew = data.now - Date.now();
      state.members = new Map(data.members.map((m) => [m.name, m]));
      state.claims = data.claims;
      state.events = data.events;
      evNodes.clear();
      render();
    } else if (type === 'member') {
      state.members.set(data.name, data);
      render();
    } else if (type === 'claims') {
      state.claims = data;
      render();
    } else if (type === 'event') {
      state.events.push(data);
      if (state.events.length > 400) state.events.shift();
      onLiveEvent(data);
      render();
    } else if (type === 'tick') {
      state.skew = data.now - Date.now();
      for (const m of data.members) state.members.set(m.name, m);
      render();
    }
  };
}

function onLiveEvent(ev) {
  if (ev.kind === 'conflict' && (ev.member === me || ev.owner === me)) {
    flash(ev.member === me ? `La teva IA volia tocar ${ev.files[0]}, però és de ${ev.owner}. L'ha bloquejada.` : `La IA de ${ev.member} volia tocar ${ev.files[0]} (teu). L'ha bloquejada.`);
  } else if (ev.kind === 'note' && ev.to === me && ev.member !== me) {
    flash(`Nota de ${ev.member}: ${ev.summary}`, false);
  }
}

let flashTimer;
function flash(text, danger = true) {
  const el = $('#alert');
  el.textContent = text;
  el.style.cssText = danger ? '' : 'background:#1d1a2e;color:#c9b8ff;border-color:#3b3463';
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (el.hidden = true), 7000);
}

/* ---------- Renderitzat ---------- */
function orderedMembers() {
  const list = [...state.members.values()];
  const mine = state.members.get(me) || { name: me, color: '#7c9cff', status: 'idle', intent: '', lastSeen: now(), viewers: 1 };
  const others = list.filter((m) => m.name !== me).sort((a, b) => a.name.localeCompare(b.name));
  return [mine, ...others];
}

function statusOf(m) {
  if (m.status === 'working' && now() - m.lastSeen < 5 * 60_000) return ['working', 'IA treballant'];
  if (m.status === 'offline') return ['offline', 'desconnectat'];
  if (now() - m.lastSeen > 15 * 60_000 && !m.viewers) return ['offline', 'inactiu'];
  return ['idle', 'esperant'];
}

function render() {
  const members = orderedMembers();
  const container = $('#columns');

  // Selector de destinatari de notes
  const sel = $('#note-to');
  const prev = sel.value;
  sel.replaceChildren(h('option', { value: '' }, 'A tothom'), ...members.filter((m) => m.name !== me).map((m) => h('option', { value: m.name }, `A ${m.name}`)));
  sel.value = prev;

  members.forEach((m, i) => {
    let col = cols.get(m.name);
    if (!col) {
      const head = h('div', { class: 'col-head' });
      const feed = h('div', { class: 'feed' });
      col = { root: h('article', { class: 'col' + (m.name === me ? ' me' : '') }, head, feed), head, feed };
      cols.set(m.name, col);
    }
    col.root.style.setProperty('--c', m.color);
    if (container.children[i] !== col.root) container.insertBefore(col.root, container.children[i] || null);
    renderHead(col.head, m);
    renderFeed(col.feed, m);
  });
}

function renderHead(head, m) {
  const [cls, label] = statusOf(m);
  const claims = state.claims.filter((c) => c.owner === m.name);
  const isMe = m.name === me;
  head.replaceChildren(
    h('div', { class: 'who' },
      h('div', { class: 'avatar' }, m.name.slice(0, 1).toUpperCase()),
      h('div', {},
        h('div', { class: 'who-name' }, isMe ? `${m.name} (tu)` : m.name),
        h('div', { class: 'who-sub' }, isMe ? 'La teva IA' : `IA de ${m.name}`)),
      h('span', { class: `badge ${cls}` }, label)),
    h('div', { class: 'intent' + (m.intent ? '' : ' empty') }, m.intent || 'Encara no ha demanat res a la IA.'),
    h('div', { class: 'claims' },
      h('span', { class: 'claims-label' }, 'Fitxers'),
      claims.length ? claims.map((c) => h('span', { class: 'chip', title: c.intent || '' }, c.file)) : h('span', { class: 'chip none' }, 'cap reclamat'))
  );
}

function renderFeed(feed, m) {
  const evs = state.events.filter((e) => e.member === m.name).slice(-150).reverse();
  if (!evs.length) {
    feed.replaceChildren(
      h('div', { class: 'empty-feed' },
        m.name === me
          ? [h('p', {}, 'Aquí veuràs el que fa la teva IA.'), h('p', {}, 'Al teu projecte executa ', h('code', {}, `codev init --room ${room} --name ${me}`), ' i obre Claude Code.')]
          : 'Sense activitat encara.')
    );
    return;
  }
  const nodes = evs.map(eventNode);
  // Només toquem el DOM si l'ordre ha canviat, així no saltem l'scroll.
  if (nodes.length !== feed.children.length || nodes.some((n, i) => feed.children[i] !== n)) feed.replaceChildren(...nodes);
}

function eventNode(ev) {
  let node = evNodes.get(ev.id);
  if (node) return node;
  const kind = ICONS[ev.kind] ? ev.kind : 'tool';
  const classes = ['ev', kind];
  let meta = null;
  if (kind === 'note') {
    if (ev.to === me) classes.push('to-me');
    meta = h('span', { class: 'meta' }, `${ev.from === 'ai' ? 'Nota de la IA' : 'Nota'} → ${ev.to || 'tothom'}`);
  } else if (kind === 'prompt') {
    meta = h('span', { class: 'meta' }, 'Ha demanat a la IA');
  }
  node = h('div', { class: classes.join(' '), title: new Date(ev.ts).toLocaleString() },
    h('span', { class: 'ico' }, ICONS[kind]),
    h('span', { class: 'txt' }, meta, ev.summary),
    h('span', { class: 'time', 'data-ts': ev.ts }, ago(ev.ts)),
    ev.diff && (ev.diff.old || ev.diff.new) ? diffNode(ev.diff) : null
  );
  evNodes.set(ev.id, node);
  return node;
}

function diffNode({ old = '', new: neu = '' }) {
  const lines = [];
  if (old) for (const l of old.split('\n')) lines.push(h('span', { class: 'l del' }, '- ' + l));
  if (neu) for (const l of neu.split('\n')) lines.push(h('span', { class: 'l add' }, '+ ' + l));
  const added = neu ? neu.split('\n').length : 0;
  const removed = old ? old.split('\n').length : 0;
  return h('details', { class: 'diff' }, h('summary', {}, `Mostra el canvi (+${added} −${removed})`), h('pre', {}, lines));
}

function refreshTimes() {
  for (const el of document.querySelectorAll('.time[data-ts]')) el.textContent = ago(Number(el.dataset.ts));
  render();
}
