// Who has a session open on a project, read from the CoDev logs in the repository
// (codev/history/<name>.md). The hook writes a line with a hidden marker when a session opens and
// when it closes, and pushes it (cli/gitsync.js), so a pull is enough to know who is working.

/** A session that never wrote its "closed" line (the computer was switched off) stops counting after this. */
export const PRESENCE_TTL_MS = 12 * 60 * 60 * 1000;

const MARK = /<!-- codev:(open|close) ts=(\d+)(?: room="([^"]*)")?(?: name="([^"]*)")? -->/g;

export const openMarker = ({ ts, room, name }) => `<!-- codev:open ts=${ts} room="${clean(room)}" name="${clean(name)}" -->`;
export const closeMarker = ({ ts }) => `<!-- codev:close ts=${ts} -->`;
const clean = (s) => String(s || '').replace(/["<>]/g, '').slice(0, 80);

/** The last session event in one log: { state, ts, room, name } or null. */
export function lastSession(text) {
  let last = null;
  for (const m of String(text || '').matchAll(MARK)) last = { state: m[1], ts: Number(m[2]), room: m[3] || null, name: m[4] || null };
  return last;
}

/**
 * Whether a log still says "open" for a session that started at `since` (ms) and has ended: its
 * terminal was closed or killed before Claude Code could write the "closed" line (on Windows a
 * killed terminal never runs the SessionEnd hook; Codex has no SessionEnd at all).
 */
export function needsClose(text, since) {
  const last = lastSession(text);
  return !!last && last.state === 'open' && last.ts >= since - 60_000;
}

/**
 * People with a session open: [{ name, room, since, file }], newest first.
 * `logs` is [{ file: 'codev/history/pau.md', text }].
 */
export function openSessions(logs, now = Date.now(), ttl = PRESENCE_TTL_MS) {
  const out = [];
  for (const { file, text } of logs) {
    const s = lastSession(text);
    if (!s || s.state !== 'open' || now - s.ts > ttl || s.ts - now > 5 * 60 * 1000) continue;
    const slug = String(file).split('/').pop().replace(/\.md$/, '');
    out.push({ name: s.name || slug, room: s.room, since: s.ts, file });
  }
  return out.sort((a, b) => b.since - a.since);
}
