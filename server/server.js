// CoDev server: HTTP API + Server-Sent Events + WebSocket terminal relay + static web view.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRoom, allRooms } from './rooms.js';
import { attachTerminals } from './terminals.js';

const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP_DIR = path.join(ROOT_DIR, 'desktop');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

// The desktop app loads from file:// (origin "null"): it needs CORS to talk to the server.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-codev-key',
};

function sendJson(res, status, body) {
  res.writeHead(status, { ...CORS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 50_000_000) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const clip = (s, n) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) + '…' : s) : s);
const cleanFiles = (files) => (Array.isArray(files) ? files.filter((f) => typeof f === 'string' && f).slice(0, 50) : []);

/**
 * The browser view is the desktop app's own UI (desktop/index.html), which runs as a watch-only
 * viewer when it is not inside Electron. Only the files that UI needs are served.
 */
function staticFile(pathname) {
  if (pathname === '/' || pathname === '/index.html') return path.join(DESKTOP_DIR, 'index.html');
  if (pathname === '/style.css' || pathname === '/renderer.js' || pathname === '/agents.js') return path.join(DESKTOP_DIR, pathname.slice(1));
  for (const pkg of ['/node_modules/@xterm/', '/node_modules/@fontsource/']) {
    if (pathname.startsWith(pkg)) {
      const base = path.join(ROOT_DIR, pkg);
      const file = path.normalize(path.join(ROOT_DIR, decodeURIComponent(pathname)));
      return file.startsWith(base) ? file : null;
    }
  }
  return null;
}

function serveStatic(req, res) {
  const file = staticFile(new URL(req.url, 'http://x').pathname);
  if (!file) return sendJson(res, 404, { error: 'not found' });
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
    const snap = room.snapshot();
    // ?events=all: everything the server still keeps (the MCP tools search it).
    if (url.searchParams.get('events') === 'all') snap.events = room.events;
    return sendJson(res, 200, snap);
  }

  if (req.method === 'GET' && action === 'stream') {
    const viewer = url.searchParams.get('viewer');
    res.writeHead(200, {
      ...CORS,
      'content-type': 'text/event-stream',
      // no-transform + x-accel-buffering: proxies such as Cloudflare (used by "Share online")
      // must pass each event through at once instead of compressing and buffering the stream.
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
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
  if (!name) return sendJson(res, 400, { error: 'missing "member"' });

  switch (action) {
    case 'intent': {
      // The whole prompt, never cut: the history and the chat show it all.
      room.setIntent(name, String(body.text || ''));
      return sendJson(res, 200, { ok: true });
    }
    case 'status': {
      const status = ['working', 'idle', 'offline'].includes(body.status) ? body.status : 'idle';
      room.setStatus(name, status);
      if (body.summary) room.addEvent(name, { kind: 'status', summary: String(body.summary) });
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
        // Kept whole (replies, commands…): nothing in the chat or the history is ever cut.
        summary: String(body.summary || ''),
        files,
        diff: body.diff
          ? { old: typeof body.diff.old === 'string' ? body.diff.old : '', new: typeof body.diff.new === 'string' ? body.diff.new : '' }
          : undefined,
      });
      // Changes seen by "codev watch": warn if they touch someone else's files.
      if (body.checkClaims) {
        for (const c of room.checkFiles(name, files)) {
          room.addEvent(name, {
            kind: 'conflict',
            summary: `Changed ${c.file}, which is claimed by ${c.owner}`,
            files: [c.file],
            owner: c.owner,
          });
        }
      }
      return sendJson(res, 200, { ok: true, id: ev.id });
    }
    case 'meta': {
      // The room's repository: set by whoever creates the room; whoever joins can clone it automatically.
      const repo = typeof body.repo === 'string' ? body.repo.trim().slice(0, 200) : '';
      if (repo && (!room.meta.repo || body.force)) {
        room.meta.repo = repo;
        room.broadcast('meta', room.meta);
      }
      return sendJson(res, 200, { ok: true, meta: room.meta });
    }
    case 'note': {
      room.member(name);
      room.addEvent(name, {
        kind: 'note',
        to: body.to ? clip(String(body.to), 40) : null,
        from: body.from === 'ai' ? 'ai' : 'human',
        summary: String(body.text || ''),
      });
      return sendJson(res, 200, { ok: true });
    }
    default:
      return sendJson(res, 404, { error: `unknown action: ${action}` });
  }
}

/**
 * Returns a check for the server key. With no key the server is open (local network use).
 * With a key, every room request, event stream and WebSocket must carry it, in the
 * x-codev-key header or the ?key= query parameter (EventSource and WebSocket cannot set headers).
 */
export function keyCheck(key) {
  if (!key) return () => true;
  const expected = Buffer.from(String(key));
  return (req) => {
    const url = new URL(req.url, 'http://x');
    const got = Buffer.from(String(req.headers['x-codev-key'] || url.searchParams.get('key') || ''));
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  };
}

/**
 * A request to join a locked room from someone who has no invite (they found the room because they
 * work on the same repository). It needs no key: the host's app asks the host, and only if they
 * allow it does the answer carry the key. The request stays open until the host answers.
 *   knocks.ask({ room, member, project }) -> Promise<boolean>
 */
const MAX_KNOCKS = 5;
async function handleKnock(req, res, { knocks, key, pending }) {
  if (!knocks) return sendJson(res, 404, { error: 'This CoDev room does not take join requests.' });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  const body = await readBody(req);
  const member = typeof body.member === 'string' ? body.member.trim().slice(0, 40) : '';
  const room = typeof body.room === 'string' ? body.room.trim().slice(0, 60) : '';
  if (!member || !room) return sendJson(res, 400, { error: 'missing "member" or "room"' });
  if (pending.size >= MAX_KNOCKS) return sendJson(res, 429, { error: 'Too many people are asking to join right now. Try again in a minute.' });
  const id = Symbol(member);
  pending.add(id);
  try {
    const project = typeof body.project === 'object' && body.project ? body.project : {};
    const allowed = await knocks.ask({ room, member, project });
    if (!allowed) return sendJson(res, 403, { error: 'The host did not let you in this time.' });
    return sendJson(res, 200, { ok: true, room, key });
  } finally {
    pending.delete(id);
  }
}

export function startServer({ port = 4321, host = '0.0.0.0', key = null, guests = null, knocks = null } = {}) {
  const authorized = keyCheck(key);
  const knocking = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        return res.end();
      }
      if (req.url === '/api/info') return sendJson(res, 200, { app: 'codev', version: 3, terminals: true, locked: !!key, knock: !!knocks });
      if (req.url === '/api/knock') return await handleKnock(req, res, { knocks, key, pending: knocking });
      const m = req.url.match(/^\/api\/rooms\/([^/?]+)\/(\w+)/);
      if (m && !authorized(req)) return sendJson(res, 401, { error: 'This room needs a key. Ask your teammate for a new invite.' });
      if (m) return await handleApi(req, res, decodeURIComponent(m[1]).slice(0, 60), m[2]);
      if (req.method === 'GET') return serveStatic(req, res);
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 400, { error: err.message });
    }
  });

  // Every 30 s: drop expired claims and send a "tick" so clients refresh their states.
  const timer = setInterval(() => {
    for (const room of allRooms()) {
      room.pruneClaims();
      room.broadcast('tick', { now: Date.now(), members: [...room.members.values()] });
    }
  }, 30_000);
  server.on('close', () => clearInterval(timer));
  const wss = attachTerminals(server, { authorized, guests });
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
