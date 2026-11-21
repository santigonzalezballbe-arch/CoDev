// Localitza .codev.json pujant des d'un directori i parla amb el servidor de la sala.
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = '.codev.json';

export function findConfig(start = process.cwd()) {
  // L'app d'escriptori passa la configuració per entorn a cada terminal (pot haver-n'hi diversos per persona).
  const { CODEV_SERVER, CODEV_ROOM, CODEV_NAME, CODEV_ROOT } = process.env;
  if (CODEV_SERVER && CODEV_ROOM && CODEV_NAME) {
    return { server: CODEV_SERVER, room: CODEV_ROOM, name: CODEV_NAME, root: path.resolve(CODEV_ROOT || start) };
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

/** Converteix una ruta (absoluta o relativa a cwd) en relativa a l'arrel del projecte. null si és a fora. */
export function toProjectPath(cfg, file, cwd = cfg.root) {
  if (!file) return null;
  const rel = path.relative(cfg.root, path.resolve(cwd, file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

export async function api(cfg, action, body, { timeout = 2500 } = {}) {
  const url = `${cfg.server.replace(/\/$/, '')}/api/rooms/${encodeURIComponent(cfg.room)}/${action}`;
  const init = { signal: AbortSignal.timeout(timeout) };
  if (body) {
    init.method = 'POST';
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify({ member: cfg.name, ...body });
  }
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`CoDev ${action}: HTTP ${res.status}`);
  return res.json();
}

const ago = (ts, now) => {
  const s = Math.round((now - ts) / 1000);
  if (s < 60) return `fa ${s}s`;
  if (s < 3600) return `fa ${Math.round(s / 60)} min`;
  return `fa ${Math.round(s / 3600)} h`;
};

/** Resum en text de què fan els companys, pensat per donar-lo de context a una IA. */
export function teamSummary(cfg, state, { maxEvents = 6 } = {}) {
  const others = state.members.filter((m) => m.name !== cfg.name);
  if (!others.length) return null;
  const lines = [`[CoDev] Treballes en equip a la sala "${state.room}". Estat actual dels companys:`];
  for (const m of others) {
    lines.push('', `## ${m.name} (${m.status}, última activitat ${ago(m.lastSeen, state.now)})`);
    if (m.intent) lines.push(`Tasca actual: ${m.intent}`);
    const claims = state.claims.filter((c) => c.owner === m.name);
    if (claims.length) lines.push(`Fitxers reclamats (NO els modifiquis): ${claims.map((c) => c.file).join(', ')}`);
    const evs = state.events.filter((e) => e.member === m.name && e.kind !== 'prompt').slice(-maxEvents);
    if (evs.length) {
      lines.push('Activitat recent:');
      for (const e of evs) lines.push(`- ${ago(e.ts, state.now)}: ${e.summary}`);
    }
  }
  const notes = state.events.filter((e) => e.kind === 'note' && e.to === cfg.name).slice(-3);
  if (notes.length) {
    lines.push('', 'Notes recents adreçades a tu:');
    for (const n of notes) lines.push(`- ${n.member}: ${n.summary}`);
  }
  lines.push(
    '',
    'Regles: no editis fitxers reclamats per altres; si els necessites, coordina-ho amb l\'eina MCP codev_send_note o demana-ho a l\'usuari. ' +
      'Si canvies una interfície que un company fa servir, avisa\'l amb codev_send_note.'
  );
  return lines.join('\n');
}
