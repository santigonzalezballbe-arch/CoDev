// Servidor de CoDev: API HTTP + Server-Sent Events + web estàtica. Sense dependències.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRoom, allRooms } from './rooms.js';
import { attachTerminals } from './terminals.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('Cos massa gran'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('JSON invàlid'));
      }
    });
    req.on('error', reject);
  });
}

const clip = (s, n) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) + '…' : s) : s);
const cleanFiles = (files) => (Array.isArray(files) ? files.filter((f) => typeof f === 'string' && f).slice(0, 50) : []);

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleApi(req, res, roomId, action) {
  const room = getRoom(roomId);
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && action === 'state') {
    room.pruneClaims();
    return sendJson(res, 200, room.snapshot());
  }

  if (req.method === 'GET' && action === 'stream') {
    const viewer = url.searchParams.get('viewer');
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', data: room.snapshot() })}\n\n`);
    room.subscribers.add(res);
    if (viewer) room.member(viewer).viewers++;
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      room.subscribers.delete(res);
      const m = viewer && room.members.get(viewer);
      if (m) {
        m.viewers = Math.max(0, m.viewers - 1);
        room.broadcast('member', m);
      }
    });
    return;
  }

  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });

  const body = await readBody(req);
  const name = typeof body.member === 'string' && body.member.trim() ? body.member.trim().slice(0, 40) : null;
  if (!name) return sendJson(res, 400, { error: 'falta "member"' });

  switch (action) {
    case 'intent': {
      room.setIntent(name, clip(String(body.text || ''), 500));
      return sendJson(res, 200, { ok: true });
    }
    case 'status': {
      const status = ['working', 'idle', 'offline'].includes(body.status) ? body.status : 'idle';
      room.setStatus(name, status);
      if (body.summary) room.addEvent(name, { kind: 'status', summary: clip(String(body.summary), 200) });
      return sendJson(res, 200, { ok: true });
    }
    case 'claim': {
      const result = room.claim(name, cleanFiles(body.files), clip(body.intent, 300));
      return sendJson(res, 200, result);
    }
    case 'release': {
      room.release(name, body.files ? cleanFiles(body.files) : null);
      return sendJson(res, 200, { ok: true });
    }
    case 'activity': {
      room.member(name);
      const files = cleanFiles(body.files);
      const ev = room.addEvent(name, {
        kind: clip(String(body.kind || 'tool'), 30),
        tool: clip(body.tool, 60),
        summary: clip(String(body.summary || ''), 400),
        files,
        diff: body.diff
          ? { old: clip(body.diff.old, 4000) || '', new: clip(body.diff.new, 4000) || '' }
          : undefined,
      });
      // Canvis detectats per "codev watch": avisa si toquen fitxers d'una altra persona.
      if (body.checkClaims) {
        for (const c of room.checkFiles(name, files)) {
          room.addEvent(name, {
            kind: 'conflict',
            summary: `Ha modificat ${c.file}, reclamat per ${c.owner}`,
            files: [c.file],
            owner: c.owner,
          });
        }
      }
      return sendJson(res, 200, { ok: true, id: ev.id });
    }
    case 'note': {
      room.member(name);
      room.addEvent(name, {
        kind: 'note',
        to: body.to ? clip(String(body.to), 40) : null,
        from: body.from === 'ai' ? 'ai' : 'human',
        summary: clip(String(body.text || ''), 1000),
      });
      return sendJson(res, 200, { ok: true });
    }
    default:
      return sendJson(res, 404, { error: `acció desconeguda: ${action}` });
  }
}

export function startServer({ port = 4321, host = '0.0.0.0' } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/api/info') return sendJson(res, 200, { app: 'codev', version: 2, terminals: true });
      const m = req.url.match(/^\/api\/rooms\/([^/?]+)\/(\w+)/);
      if (m) return await handleApi(req, res, decodeURIComponent(m[1]).slice(0, 60), m[2]);
      if (req.method === 'GET') return serveStatic(req, res);
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 400, { error: err.message });
    }
  });

  // Cada 30 s: neteja reclamacions caducades i envia un "tick" perquè la web refresqui estats.
  const timer = setInterval(() => {
    for (const room of allRooms()) {
      room.pruneClaims();
      room.broadcast('tick', { now: Date.now(), members: [...room.members.values()] });
    }
  }, 30_000);
  server.on('close', () => clearInterval(timer));
  const wss = attachTerminals(server);
  server.on('close', () => {
    for (const ws of wss.clients) ws.terminate();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
