// Finds .codev.json by walking up from a directory, and talks to the room server.
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = '.codev.json';

export function findConfig(start = process.cwd()) {
  // The desktop app passes the config to each terminal through the environment (a person may run several).
  const { CODEV_SERVER, CODEV_ROOM, CODEV_NAME, CODEV_ROOT, CODEV_KEY } = process.env;
  if (CODEV_SERVER && CODEV_ROOM && CODEV_NAME) {
    return { server: CODEV_SERVER, room: CODEV_ROOM, name: CODEV_NAME, key: CODEV_KEY || null, root: path.resolve(CODEV_ROOT || start) };
  }
  let dir = path.resolve(start);
  while (true) {
    const file = path.join(dir, CONFIG_FILE);
    if (fs.existsSync(file)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (cfg.server && cfg.room && cfg.name) return { ...cfg, root: dir };
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Turns a path (absolute or relative to cwd) into one relative to the project root. null if it is outside. */
export function toProjectPath(cfg, file, cwd = cfg.root) {
  if (!file) return null;
  const rel = path.relative(cfg.root, path.resolve(cwd, file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

export async function api(cfg, action, body, { timeout = 2500 } = {}) {
  const url = `${cfg.server.replace(/\/$/, '')}/api/rooms/${encodeURIComponent(cfg.room)}/${action}`;
  const init = { signal: AbortSignal.timeout(timeout), headers: cfg.key ? { 'x-codev-key': cfg.key } : {} };
  if (body) {
    init.method = 'POST';
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify({ member: cfg.name, ...body });
  }
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`CoDev ${action}: HTTP ${res.status}`);
  return res.json();
}

const ago = (ts, now) => {
  const s = Math.round((now - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
};

/** Plain-text summary of what teammates are doing, meant to be given to an AI as context. */
export function teamSummary(cfg, state, { maxEvents = 6 } = {}) {
  const others = state.members.filter((m) => m.name !== cfg.name);
  if (!others.length) return null;
  const lines = [`[CoDev] You are working as a team in room "${state.room}". Current state of your teammates:`];
  for (const m of others) {
    lines.push('', `## ${m.name} (${m.status}, last active ${ago(m.lastSeen, state.now)})`);
    if (m.intent) lines.push(`Current task: ${m.intent}`);
    const claims = state.claims.filter((c) => c.owner === m.name);
    if (claims.length) lines.push(`Claimed files (do NOT modify them): ${claims.map((c) => c.file).join(', ')}`);
    const evs = state.events.filter((e) => e.member === m.name && e.kind !== 'prompt').slice(-maxEvents);
    if (evs.length) {
      lines.push('Recent activity:');
      for (const e of evs) lines.push(`- ${ago(e.ts, state.now)}: ${e.summary}`);
    }
  }
  const notes = state.events.filter((e) => e.kind === 'note' && e.to === cfg.name).slice(-3);
  if (notes.length) {
    lines.push('', 'Recent notes addressed to you:');
    for (const n of notes) lines.push(`- ${n.member}: ${n.summary}`);
  }
  lines.push(
    '',
    'Rules: do not edit files claimed by others; if you need them, coordinate with the codev_send_note MCP tool or ask the user. ' +
      'If you change an interface a teammate relies on, tell them with codev_send_note.'
  );
  return lines.join('\n');
}
