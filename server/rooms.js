// In-memory state of CoDev rooms: members, claimed files and activity.

export const CLAIM_TTL_MS = 20 * 60 * 1000; // a claim expires after 20 min without touching the file
const MAX_EVENTS = 400;
const PALETTE = ['#7c9cff', '#ff8a65', '#4dd0a1', '#e57bd8', '#ffd166', '#5ec8f2', '#b39ddb', '#f28482'];

function colorFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export class Room {
  constructor(id) {
    this.id = id;
    this.members = new Map(); // name -> member
    this.claims = new Map(); // relative file -> { file, owner, intent, since, touched }
    this.events = [];
    this.subscribers = new Set(); // open SSE responses
    this.seq = 0;
    this.meta = {}; // { repo: 'owner/repository' }
  }

  member(name) {
    let m = this.members.get(name);
    if (!m) {
      m = { name, color: colorFor(name), status: 'idle', intent: '', lastSeen: Date.now(), viewers: 0 };
      this.members.set(name, m);
    }
    m.lastSeen = Date.now();
    this.broadcast('member', m);
    return m;
  }

  addEvent(member, data) {
    const ev = { id: ++this.seq, ts: Date.now(), member, ...data };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.broadcast('event', ev);
    return ev;
  }

  pruneClaims() {
    const now = Date.now();
    let changed = false;
    for (const [file, c] of this.claims) {
      if (now - c.touched > CLAIM_TTL_MS) {
        this.claims.delete(file);
        changed = true;
      }
    }
    if (changed) this.broadcast('claims', this.claimList());
  }

  claimList() {
    return [...this.claims.values()];
  }

  /** Tries to claim files. Returns the ones claimed and the ones that already belong to someone else. */
  claim(name, files, intent) {
    this.pruneClaims();
    const m = this.member(name);
    const now = Date.now();
    const claimed = [];
    const conflicts = [];
    for (const file of files) {
      const c = this.claims.get(file);
      if (c && c.owner !== name) {
        conflicts.push({ ...c });
        continue;
      }
      this.claims.set(file, {
        file,
        owner: name,
        intent: intent || c?.intent || m.intent || '',
        since: c?.since || now,
        touched: now,
      });
      claimed.push(file);
    }
    for (const c of conflicts) {
      this.addEvent(name, {
        kind: 'conflict',
        summary: `Tried to touch ${c.file}, but it is claimed by ${c.owner}`,
        files: [c.file],
        owner: c.owner,
      });
    }
    if (claimed.length) this.broadcast('claims', this.claimList());
    return { claimed, conflicts };
  }

  /** Checks (without claiming) whether any file belongs to someone else. */
  checkFiles(name, files) {
    this.pruneClaims();
    return files.map((f) => this.claims.get(f)).filter((c) => c && c.owner !== name);
  }

  release(name, files) {
    let changed = false;
    for (const [file, c] of this.claims) {
      if (c.owner === name && (!files || files.includes(file))) {
        this.claims.delete(file);
        changed = true;
      }
    }
    if (changed) this.broadcast('claims', this.claimList());
  }

  setIntent(name, text) {
    const m = this.member(name);
    m.intent = text;
    m.status = 'working';
    this.broadcast('member', m);
    this.addEvent(name, { kind: 'prompt', summary: text });
  }

  setStatus(name, status) {
    const m = this.member(name);
    m.status = status;
    this.broadcast('member', m);
  }

  snapshot() {
    return {
      room: this.id,
      meta: this.meta,
      now: Date.now(),
      members: [...this.members.values()],
      claims: this.claimList(),
      events: this.events.slice(-200),
    };
  }

  /**
   * Sends a room event to every viewer: over Server-Sent Events (web view, local use) and over the
   * terminal WebSockets. The desktop app relies on the WebSocket, because proxies such as the
   * Cloudflare tunnel behind "Share online" can hold back an SSE stream but pass WebSockets through.
   */
  broadcast(type, data) {
    const payload = `data: ${JSON.stringify({ type, data })}\n\n`;
    for (const res of this.subscribers) res.write(payload);
    if (this.sockets?.size) {
      const msg = JSON.stringify({ t: 'room', type, data });
      for (const ws of this.sockets) if (ws.readyState === 1) ws.send(msg);
    }
  }
}

const rooms = new Map();

export function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    r = new Room(id);
    rooms.set(id, r);
  }
  return r;
}

export function allRooms() {
  return rooms.values();
}
