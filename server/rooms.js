// Estat en memòria de les sales de CoDev: membres, fitxers reclamats i activitat.

export const CLAIM_TTL_MS = 20 * 60 * 1000; // una reclamació caduca després de 20 min sense tocar el fitxer
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
    this.members = new Map(); // nom -> membre
    this.claims = new Map(); // fitxer relatiu -> { file, owner, intent, since, touched }
    this.events = [];
    this.subscribers = new Set(); // respostes SSE obertes
    this.seq = 0;
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

  /** Intenta reclamar fitxers. Retorna els reclamats i els que ja són d'algú altre. */
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
        summary: `Ha intentat tocar ${c.file}, però està reclamat per ${c.owner}`,
        files: [c.file],
        owner: c.owner,
      });
    }
    if (claimed.length) this.broadcast('claims', this.claimList());
    return { claimed, conflicts };
  }

  /** Comprova (sense reclamar) si algun fitxer és d'una altra persona. */
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
      now: Date.now(),
      members: [...this.members.values()],
      claims: this.claimList(),
      events: this.events.slice(-200),
    };
  }

  broadcast(type, data) {
    const payload = `data: ${JSON.stringify({ type, data })}\n\n`;
    for (const res of this.subscribers) res.write(payload);
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
