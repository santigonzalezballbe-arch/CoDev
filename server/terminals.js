// Live terminal relay over WebSocket.
// Each terminal keeps a "snapshot" (the serialized screen) plus the output chunks that came after it,
// so whoever connects late sees exactly what the owner sees.
import { WebSocketServer } from 'ws';
import { getRoom } from './rooms.js';

const MAX_PENDING_BYTES = 4_000_000;

function termInfo(t) {
  return { id: t.id, member: t.member, title: t.title, cols: t.cols, rows: t.rows, open: t.open };
}

function roomTerms(room) {
  room.terminals ||= new Map();
  room.sockets ||= new Set();
  return room;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const ws of room.sockets) if (ws !== except && ws.readyState === 1) ws.send(data);
}

const listMsg = (room) => ({ t: 'terms', list: [...room.terminals.values()].map(termInfo) });

/**
 * guests (optional, given by the desktop app that hosts the room): runs a Claude Code terminal on the
 * host's computer for someone watching from a browser, once the host allows it.
 *   open({ room, member, id, cols, rows }, reply)  reply() sends guest-ready / guest-denied / guest-data / guest-exit
 *   input(id, data) · resize(id, cols, rows) · close(id)
 */
export function attachTerminals(httpServer, { authorized = () => true, guests = null } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8_000_000 });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    if (!authorized(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, url));
  });

  wss.on('connection', (ws, url) => {
    const room = roomTerms(getRoom((url.searchParams.get('room') || '').slice(0, 60)));
    const member = (url.searchParams.get('member') || '').slice(0, 40);
    const owned = new Set(); // terminals this socket publishes
    const guestIds = new Set(); // terminals on the host's computer that this socket drives
    room.sockets.add(ws);
    if (member) room.member(member).viewers++;

    // Initial state: the room (tasks, claims, activity), the terminal list and every open terminal's content.
    send(ws, { t: 'room', type: 'snapshot', data: room.snapshot() });
    send(ws, listMsg(room));
    for (const t of room.terminals.values()) {
      if (t.open) send(ws, { t: 'term-init', id: t.id, cols: t.cols, rows: t.rows, d: t.snapshot + t.pending.join('') });
    }

    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (typeof m.id !== 'string' || m.id.length > 80) return;
      const t = room.terminals.get(m.id);

      switch (m.t) {
        case 'term-open': {
          if (t && !owned.has(m.id) && t.open) return; // nobody can hijack someone else's terminal
          const term = {
            id: m.id,
            member: member || m.member,
            title: String(m.title || '').slice(0, 80),
            cols: m.cols | 0 || 80,
            rows: m.rows | 0 || 24,
            snapshot: typeof m.d === 'string' ? m.d : '',
            pending: [],
            pendingBytes: 0,
            open: true,
          };
          room.terminals.set(m.id, term);
          owned.add(m.id);
          broadcast(room, listMsg(room), ws);
          broadcast(room, { t: 'term-init', id: term.id, cols: term.cols, rows: term.rows, d: term.snapshot }, ws);
          return;
        }
        case 'term-data': {
          if (!t || !owned.has(m.id) || typeof m.d !== 'string') return;
          t.pending.push(m.d);
          t.pendingBytes += m.d.length;
          while (t.pendingBytes > MAX_PENDING_BYTES && t.pending.length > 1) t.pendingBytes -= t.pending.shift().length;
          broadcast(room, { t: 'term-data', id: m.id, d: m.d }, ws);
          return;
        }
        case 'term-snapshot': {
          // The snapshot already includes everything sent before it: clear the queue.
          if (!t || !owned.has(m.id) || typeof m.d !== 'string') return;
          t.snapshot = m.d;
          t.pending = [];
          t.pendingBytes = 0;
          if (m.cols) t.cols = m.cols | 0;
          if (m.rows) t.rows = m.rows | 0;
          return;
        }
        case 'term-typing': {
          // Someone is typing in their terminal (never the content): drives the "typing" character state.
          if (!t || !owned.has(m.id)) return;
          broadcast(room, { t: 'term-typing', id: m.id }, ws);
          return;
        }
        case 'term-resize': {
          if (!t || !owned.has(m.id)) return;
          t.cols = m.cols | 0 || t.cols;
          t.rows = m.rows | 0 || t.rows;
          broadcast(room, { t: 'term-resize', id: m.id, cols: t.cols, rows: t.rows }, ws);
          return;
        }
        case 'term-close': {
          if (!t || !owned.has(m.id)) return;
          t.open = false;
          owned.delete(m.id);
          room.terminals.delete(m.id);
          broadcast(room, listMsg(room), ws);
          return;
        }
        case 'guest-open': {
          const deny = (reason) => send(ws, { t: 'guest-denied', id: m.id, reason });
          if (!guests) return deny('This room cannot open terminals for the browser. Install the CoDev app to work here.');
          if (!member) return deny('Enter the room with your name first.');
          if (guestIds.size >= 2) return deny('You already have two terminals open.');
          guestIds.add(m.id);
          guests.open({ room: room.id, member, id: m.id, cols: m.cols | 0 || 80, rows: m.rows | 0 || 24 }, (msg) => {
            if (msg.t === 'guest-denied' || msg.t === 'guest-exit') guestIds.delete(m.id);
            send(ws, msg);
          });
          return;
        }
        case 'guest-input':
          if (guests && guestIds.has(m.id) && typeof m.d === 'string') guests.input(m.id, m.d);
          return;
        case 'guest-resize':
          if (guests && guestIds.has(m.id)) guests.resize(m.id, m.cols | 0, m.rows | 0);
          return;
        case 'guest-close':
          if (guests && guestIds.has(m.id)) {
            guestIds.delete(m.id);
            guests.close(m.id);
          }
          return;
      }
    });

    ws.on('close', () => {
      room.sockets.delete(ws);
      const m = member && room.members.get(member);
      if (m) {
        m.viewers = Math.max(0, m.viewers - 1);
        room.broadcast('member', m);
      }
      // If the app or the browser closes without saying so, its terminals go away.
      for (const id of guestIds) guests?.close(id);
      for (const id of owned) room.terminals.delete(id);
      if (owned.size) broadcast(room, listMsg(room));
    });
  });

  return wss;
}
