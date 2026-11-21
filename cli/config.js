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

export async function api(cfg, action, body, { timeout = 2500, query = '' } = {}) {
  const url = `${cfg.server.replace(/\/$/, '')}/api/rooms/${encodeURIComponent(cfg.room)}/${action}${query}`;
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

const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'someone';

/** Each person's AI keeps its own log in the repository: no locking and no merge conflicts between them. */
export const historyPath = (cfg) => `codev/history/${slug(cfg.name)}.md`;

/** The rules CoDev gives every AI at the start of a session and with every prompt. */
export function projectRules(cfg) {
  return [
    `[CoDev] ${cfg.name} works on this project together with teammates through CoDev (room "${cfg.room}").`,
    `Project log: after any task that changes files, append an entry at the end of ${historyPath(cfg)} (create the file and its folders if needed). ` +
      'Each entry: a "## <date and time>" heading, the request in one line, what you changed (files) and why, and what is left to do. ' +
      'Keep it short and factual. It lives in the git repository so the whole team can read it; when you commit, commit it with your changes. ' +
      'Only edit your own file in codev/history/.',
    'Before starting a task, read your teammates\' logs in codev/history/ (if any) to know what was done and why. ' +
      'For more, the codev MCP server has codev_read_chat (the AIs\' chat) and codev_search_history (every prompt, change, command and message, searchable).',
  ].join('\n');
}

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
    const evs = state.events
      .filter((e) => e.member === m.name && !['prompt', 'reply', 'attention'].includes(e.kind) && !(e.kind === 'note' && e.from !== 'ai'))
      .slice(-maxEvents);
    if (evs.length) {
      lines.push('Recent activity:');
      for (const e of evs) lines.push(`- ${ago(e.ts, state.now)}: ${e.summary}`);
    }
  }
  // Messages from other AIs for you or for every AI (not your own), newest last. The people's chat
  // is for the humans only and never reaches an AI.
  const notes = state.events.filter((e) => e.kind === 'note' && e.from === 'ai' && e.member !== cfg.name && (!e.to || e.to === cfg.name)).slice(-5);
  if (notes.length) {
    lines.push('', "Recent messages in the AIs' chat for you or every AI:");
    for (const n of notes) lines.push(`- ${n.member}'s AI${n.to ? ' (to you)' : ''}: ${n.summary}`);
  }
  lines.push(
    '',
    'Rules: do not edit files claimed by others; if you need them, coordinate with the codev_send_note MCP tool or ask the user. ' +
      'If you change an interface a teammate relies on, tell them with codev_send_note.'
  );
  return lines.join('\n');
}
