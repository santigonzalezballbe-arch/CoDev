// Local history of a project: every prompt, change, command, note and conflict seen in its rooms.
// One JSON object per line in <project>/.codev/history.jsonl (git-ignored), so it is easy to read,
// grep or import anywhere.
import fs from 'node:fs';
import path from 'node:path';

const FIELDS = ['room', 'ts', 'member', 'kind', 'summary', 'tool', 'files', 'diff', 'to', 'from', 'owner'];

export class History {
  constructor(file) {
    this.file = file;
    this.keys = new Set();
    for (const ev of this.read()) this.keys.add(History.keyOf(ev));
  }

  /** The same event can arrive twice (a reconnect sends the room's recent events again). */
  static keyOf(ev) {
    return [ev.room, ev.ts, ev.member, ev.kind, String(ev.summary || '').slice(0, 120)].join('|');
  }

  /** Appends the events not stored yet. Returns how many were new. */
  append(events, room) {
    const lines = [];
    for (const ev of events) {
      if (!ev || typeof ev.ts !== 'number' || !ev.member) continue;
      const rec = {};
      for (const k of FIELDS) if (ev[k] !== undefined && ev[k] !== null) rec[k] = ev[k];
      rec.room ||= room;
      if (Array.isArray(rec.files) && !rec.files.length) delete rec.files;
      const key = History.keyOf(rec);
      if (this.keys.has(key)) continue;
      this.keys.add(key);
      lines.push(JSON.stringify(rec));
    }
    if (lines.length) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // If the app was killed mid-write, start on a fresh line instead of gluing onto the broken one.
      fs.appendFileSync(this.file, (this.endsMidLine() ? '\n' : '') + lines.join('\n') + '\n');
    }
    return lines.length;
  }

  endsMidLine() {
    try {
      const size = fs.statSync(this.file).size;
      if (!size) return false;
      const fd = fs.openSync(this.file, 'r');
      const buf = Buffer.alloc(1);
      fs.readSync(fd, buf, 0, 1, size - 1);
      fs.closeSync(fd);
      return buf[0] !== 0x0a;
    } catch {
      return false;
    }
  }

  /** All stored events, oldest first (at most the last `limit`). */
  read({ limit = 20_000 } = {}) {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A half-written last line (the app was killed mid-write) is skipped, not fatal.
      }
    }
    return out.slice(-limit);
  }
}
