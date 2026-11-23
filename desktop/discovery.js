// Finding teammates who run CoDev on the same project, so they can ask to join each other's room.
//
// A project is recognised by two fingerprints: its first commit (the same in every clone) and, when
// it has one, its GitHub repository. Only hashes travel, never the repository's name or the room key.
//
// Two ways to meet:
//  - Same network: every app hosting a room announces it by UDP multicast every few seconds.
//  - Anywhere: the host writes a hidden git ref in the GitHub repository (refs/codev/rooms/<name>)
//    whose commit message holds the room's public link. Only people with access to the repository
//    can read it, it is not a branch, and plain clones do not fetch it.
// Either way, finding a room gives no access: the visitor knocks and the host decides.

import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { execFile } from 'node:child_process';

export const LAN_GROUP = '239.255.43.219';
export const LAN_PORT = 43219;
const LAN_EVERY_MS = 4000;
const LAN_TTL_MS = 15000;
/** A GitHub room older than this is a leftover (the host refreshes it while the room is open). */
export const GITHUB_TTL_MS = 30 * 60 * 1000;
const REF_PREFIX = 'codev/rooms/';

const hash = (kind, value) => crypto.createHash('sha256').update(`codev-${kind}:${value}`).digest('hex').slice(0, 24);

/** "owner/repo" from a GitHub remote URL (https or ssh), or null. */
export function githubRepoFromRemote(url) {
  const m = String(url || '')
    .trim()
    .match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The two fingerprints of a project: { r } from its first commit, { g } from its GitHub repository. */
export function fingerprint({ rootCommit, repo }) {
  return {
    r: rootCommit ? hash('root', rootCommit) : null,
    g: repo ? hash('repo', repo.toLowerCase()) : null,
  };
}

/** Same project if either fingerprint matches. */
export const sameProject = (a, b) => !!((a.r && a.r === b.r) || (a.g && a.g === b.g));

/** Reads a project's identity with git: { rootCommit, repo }. Missing parts are null. */
export async function projectIdentity(root, run) {
  const git = (args) => run('git', ['-C', root, ...args]).then((s) => s.trim()).catch(() => '');
  // A repository can have several root commits (merged histories): the smallest hash is stable.
  const roots = (await git(['rev-list', '--max-parents=0', 'HEAD'])).split('\n').filter(Boolean).sort();
  const remote = await git(['remote', 'get-url', 'origin']);
  return { rootCommit: roots[0] || null, repo: githubRepoFromRemote(remote) };
}

/* ---------------- Same network ---------------- */

export function encodeAnnouncement(a) {
  return Buffer.from(JSON.stringify({ app: 'codev', v: 1, ...a }));
}

/** A valid announcement, or null. */
export function decodeAnnouncement(buf) {
  try {
    const m = JSON.parse(String(buf));
    if (m.app !== 'codev' || m.v !== 1) return null;
    if (typeof m.inst !== 'string' || typeof m.room !== 'string' || typeof m.name !== 'string') return null;
    if (!Number.isInteger(m.port) || m.port <= 0 || m.port > 65535) return null;
    return {
      inst: m.inst.slice(0, 40),
      name: m.name.slice(0, 40),
      room: m.room.slice(0, 60),
      port: m.port,
      r: typeof m.r === 'string' ? m.r : null,
      g: typeof m.g === 'string' ? m.g : null,
    };
  } catch {
    return null;
  }
}

/**
 * Listens for rooms on the local network, and announces ours while we host one.
 * `inst` identifies this app so it never finds itself.
 */
export function startLan({ inst, onError = () => {} } = {}) {
  const peers = new Map(); // inst -> { ...announcement, address, seen }
  // One announcement per room this app hosts (one per window): slot -> info. Each goes out with its
  // own id ("<inst>.<slot>"), so listeners keep them apart.
  const announcing = new Map();
  let timer = null;
  let socket;
  try {
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  } catch (err) {
    onError(err);
    return { announce() {}, stop() {}, peers: () => [], close() {} };
  }
  socket.on('error', onError);
  socket.on('message', (buf, rinfo) => {
    const a = decodeAnnouncement(buf);
    if (!a || a.inst === inst || a.inst.startsWith(`${inst}.`)) return; // our own rooms
    peers.set(a.inst, { ...a, address: rinfo.address, seen: Date.now() });
  });
  socket.bind(LAN_PORT, () => {
    try {
      socket.addMembership(LAN_GROUP);
      socket.setMulticastTTL(1);
    } catch (err) {
      onError(err);
    }
  });
  const send = () => {
    for (const [slot, info] of announcing) {
      const msg = encodeAnnouncement({ inst: slot === '' ? inst : `${inst}.${slot}`, ...info });
      socket.send(msg, 0, msg.length, LAN_PORT, LAN_GROUP, () => {});
    }
  };
  return {
    /** Starts (or updates) announcing { name, room, port, r, g }; `slot` tells apart the rooms of one app. */
    announce(info, slot = '') {
      announcing.set(String(slot), info);
      send();
      clearInterval(timer);
      timer = setInterval(send, LAN_EVERY_MS);
    },
    /** Stops announcing one room (`slot`), or all of them. */
    stop(slot) {
      if (slot === undefined) announcing.clear();
      else announcing.delete(String(slot));
      if (!announcing.size) clearInterval(timer);
    },
    /** Rooms heard recently: [{ name, room, url, r, g }]. */
    peers() {
      const now = Date.now();
      const out = [];
      for (const [k, p] of peers) {
        if (now - p.seen > LAN_TTL_MS) peers.delete(k);
        else out.push({ name: p.name, room: p.room, url: `http://${p.address}:${p.port}`, r: p.r, g: p.g, via: 'lan' });
      }
      return out;
    },
    close() {
      clearInterval(timer);
      try {
        socket.close();
      } catch {}
    },
  };
}

/* ---------------- GitHub ---------------- */

/** The ref name for a host: refs/codev/rooms/<slug>. */
export const roomRef = (name) =>
  REF_PREFIX + (String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'host');

export function roomMessage({ name, room, url, updated = Date.now() }) {
  return `CoDev room\n\n${JSON.stringify({ app: 'codev', v: 1, name, room, url, updated })}\n`;
}

/** The room in a ref's commit message, or null if it is not one, is malformed or is too old. */
export function parseRoomMessage(message, now = Date.now()) {
  const i = String(message || '').indexOf('{');
  if (i < 0) return null;
  try {
    const m = JSON.parse(message.slice(i).split('\n')[0]); // one line (a .patch adds more after it)
    if (m.app !== 'codev' || m.v !== 1) return null;
    if (typeof m.name !== 'string' || typeof m.room !== 'string' || !/^https:\/\//.test(m.url || '')) return null;
    if (!Number.isFinite(m.updated) || now - m.updated > GITHUB_TTL_MS) return null;
    return { name: m.name.slice(0, 40), room: m.room.slice(0, 60), url: m.url, updated: m.updated, via: 'github' };
  } catch {
    return null;
  }
}

/**
 * Calls the GitHub REST API with the app's token (args like `gh api`: [path, '-X', method]).
 * It talks to api.github.com directly, so it works without the `gh` command installed.
 */
export async function ghApi([pathname, , method = 'GET'], body, { token } = {}) {
  if (!token && method !== 'GET') throw new Error('Not signed in to GitHub.');
  const res = await fetch(`https://api.github.com/${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), // public repositories can be read without one
      accept: 'application/vnd.github+json',
      'user-agent': 'CoDev',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) throw new Error(`GitHub answered ${res.status}${data?.message ? `: ${data.message}` : ''}`);
  return data;
}

/** Writes (or refreshes) this host's room in the repository. */
export async function publishGithubRoom({ repo, name, room, url, token, api = ghApi }) {
  const ref = roomRef(name);
  const tree = await api([`repos/${repo}/git/trees`, '-X', 'POST'], {
    tree: [{ path: 'room.json', mode: '100644', type: 'blob', content: JSON.stringify({ name, room, url }) }],
  }, { token });
  const commit = await api([`repos/${repo}/git/commits`, '-X', 'POST'], {
    message: roomMessage({ name, room, url }),
    tree: tree.sha,
    parents: [],
  }, { token });
  try {
    await api([`repos/${repo}/git/refs/${ref}`, '-X', 'PATCH'], { sha: commit.sha, force: true }, { token });
  } catch {
    await api([`repos/${repo}/git/refs`, '-X', 'POST'], { ref: `refs/${ref}`, sha: commit.sha }, { token });
  }
  return ref;
}

/** Removes this host's room from the repository (when the room closes or stops being shared). */
export async function unpublishGithubRoom({ repo, name, token, api = ghApi }) {
  await api([`repos/${repo}/git/refs/${roomRef(name)}`, '-X', 'DELETE'], null, { token }).catch(() => {});
}

/*
 * Reading the rooms must not depend on the GitHub API alone: without a token it allows 60 requests
 * an hour per IP, shared by everyone behind the same router, and once it answers 403 a teammate's
 * room is never found ("Looking for their room…" forever). So: a ref list from `git ls-remote` when
 * the API fails (no limit), and a commit's message from its .patch on github.com, cached by sha
 * (a commit never changes).
 */
const messages = new Map(); // sha -> commit message

/** refs/codev/rooms/* in the repository with plain git: [{ ref, object: { sha } }]. */
export function lsRemoteRooms(repo) {
  return new Promise((resolve, reject) =>
    execFile(
      'git',
      ['ls-remote', `https://github.com/${repo}.git`, `refs/${REF_PREFIX}*`],
      { timeout: 15000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true },
      (err, out) =>
        err
          ? reject(err)
          : resolve(
              String(out)
                .split('\n')
                .map((l) => l.trim().split(/\s+/))
                .filter(([sha, ref]) => sha && ref)
                .map(([sha, ref]) => ({ ref, object: { sha } }))
            )
    )
  );
}

/** A commit's message from github.com (not the API, so no rate limit; public repositories only). */
export async function patchMessage(repo, sha) {
  const res = await fetch(`https://github.com/${repo}/commit/${sha}.patch`, { headers: { 'user-agent': 'CoDev' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`github.com answered ${res.status}`);
  return res.text();
}

/** Rooms published in the repository: [{ name, room, url, updated, via: 'github' }]. */
export async function listGithubRooms({ repo, token, api = ghApi, now = Date.now(), lsRemote = lsRemoteRooms, patch = patchMessage }) {
  let refs;
  try {
    refs = await api([`repos/${repo}/git/matching-refs/${REF_PREFIX.replace(/\/$/, '')}`], null, { token });
  } catch {
    refs = await lsRemote(repo).catch(() => []);
  }
  const rooms = await Promise.all(
    (Array.isArray(refs) ? refs : []).slice(0, 20).map(async (r) => {
      const sha = r?.object?.sha;
      if (!sha) return null;
      if (!messages.has(sha)) {
        const message = await api([`repos/${repo}/git/commits/${sha}`], null, { token })
          .then((c) => c.message)
          .catch(() => patch(repo, sha))
          .catch(() => null);
        if (message == null) return null;
        messages.set(sha, message);
      }
      return parseRoomMessage(messages.get(sha), now);
    })
  );
  return rooms.filter(Boolean);
}
