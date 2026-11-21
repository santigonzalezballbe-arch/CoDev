// Retransmissió de terminals en directe per WebSocket.
// Cada terminal té una "foto" (estat serialitzat de la pantalla) + els trossos de sortida posteriors,
// així qui es connecta tard veu exactament el mateix que el propietari.
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

export function attachTerminals(httpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8_000_000 });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, url));
  });

  wss.on('connection', (ws, url) => {
    const room = roomTerms(getRoom((url.searchParams.get('room') || '').slice(0, 60)));
    const member = (url.searchParams.get('member') || '').slice(0, 40);
    const owned = new Set(); // terminals que aquest socket publica
    room.sockets.add(ws);

    // Estat inicial: llista + contingut de cada terminal obert.
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
          if (t && !owned.has(m.id) && t.open) return; // no es pot segrestar un terminal d'un altre
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
          // La foto ja inclou tot el que s'havia enviat abans: buidem la cua.
          if (!t || !owned.has(m.id) || typeof m.d !== 'string') return;
          t.snapshot = m.d;
          t.pending = [];
          t.pendingBytes = 0;
          if (m.cols) t.cols = m.cols | 0;
          if (m.rows) t.rows = m.rows | 0;
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
      }
    });

    ws.on('close', () => {
      room.sockets.delete(ws);
      // Si es tanca l'app sense avisar, els seus terminals desapareixen.
      for (const id of owned) room.terminals.delete(id);
      if (owned.size) broadcast(room, listMsg(room));
    });
  });

  return wss;
}
