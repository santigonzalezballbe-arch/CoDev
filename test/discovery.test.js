// Finding teammates on the same project, and knocking on their room.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../server/server.js';
import {
  githubRepoFromRemote,
  fingerprint,
  sameProject,
  encodeAnnouncement,
  decodeAnnouncement,
  roomRef,
  roomMessage,
  parseRoomMessage,
  publishGithubRoom,
  listGithubRooms,
  unpublishGithubRoom,
  startLan,
  GITHUB_TTL_MS,
} from '../desktop/discovery.js';

const servers = [];
after(() => servers.forEach((s) => s.close()));

test('a GitHub remote gives owner/repo, whatever its form', () => {
  for (const url of [
    'https://github.com/ana/todo.git',
    'https://github.com/ana/todo',
    'https://token@github.com/ana/todo.git',
    'git@github.com:ana/todo.git',
    'ssh://git@github.com/ana/todo.git',
  ]) {
    assert.equal(githubRepoFromRemote(url), 'ana/todo', url);
  }
  assert.equal(githubRepoFromRemote('https://gitlab.com/ana/todo.git'), null);
  assert.equal(githubRepoFromRemote(''), null);
});

test('two clones are the same project by first commit or by GitHub repository', () => {
  const a = fingerprint({ rootCommit: 'abc123', repo: 'Ana/Todo' });
  const b = fingerprint({ rootCommit: 'abc123', repo: null }); // a folder without a GitHub remote
  const c = fingerprint({ rootCommit: null, repo: 'ana/todo' }); // a repo not cloned yet
  const other = fingerprint({ rootCommit: 'zzz', repo: 'ana/other' });
  assert.ok(sameProject(a, b));
  assert.ok(sameProject(a, c), 'the repository name is not case sensitive');
  assert.ok(!sameProject(a, other));
  assert.ok(!sameProject(fingerprint({}), fingerprint({})), 'no identity is never a match');
  assert.ok(!JSON.stringify(a).includes('todo'), 'only hashes travel, never the repository name');
});

test('network announcements are checked before they are trusted', () => {
  const good = { inst: 'i1', name: 'Maya', room: 'todo', port: 4321, r: 'r1', g: null };
  assert.deepEqual(decodeAnnouncement(encodeAnnouncement(good)), good);
  assert.equal(decodeAnnouncement(Buffer.from('not json')), null);
  assert.equal(decodeAnnouncement(Buffer.from(JSON.stringify({ app: 'other', v: 1 }))), null);
  assert.equal(decodeAnnouncement(encodeAnnouncement({ ...good, port: 99999 })), null);
  assert.equal(decodeAnnouncement(encodeAnnouncement({ ...good, room: 42 })), null);
});

test('a room written in the repository is read back, and old or odd ones are ignored', () => {
  const now = Date.now();
  const msg = roomMessage({ name: 'Maya', room: 'todo', url: 'https://x.trycloudflare.com', updated: now });
  assert.deepEqual(parseRoomMessage(msg, now), { name: 'Maya', room: 'todo', url: 'https://x.trycloudflare.com', updated: now, via: 'github' });
  assert.equal(parseRoomMessage(msg, now + GITHUB_TTL_MS + 1), null, 'a leftover from a room closed long ago');
  assert.equal(parseRoomMessage(roomMessage({ name: 'M', room: 'r', url: 'http://10.0.0.2:4321' }), now), null, 'only public https links');
  assert.equal(parseRoomMessage('Merge branch main', now), null);
  assert.equal(roomRef('María José'), 'codev/rooms/maria-jose');
});

test('publishing, listing and removing a room in the repository', async () => {
  // A fake GitHub API: enough of git/trees, git/commits and git/refs.
  const objects = new Map();
  const refs = new Map();
  let n = 0;
  const api = async ([path, , method = 'GET'], body) => {
    const p = path.replace(/^repos\/ana\/todo\/git\//, '');
    if (p === 'trees' && method === 'POST') return { sha: `t${++n}` };
    if (p === 'commits' && method === 'POST') {
      const sha = `c${++n}`;
      objects.set(sha, { message: body.message });
      return { sha };
    }
    if (p.startsWith('commits/')) return objects.get(p.slice(8));
    if (p.startsWith('refs/') && method === 'PATCH') {
      if (!refs.has(p.slice(5))) throw new Error('Reference does not exist');
      refs.set(p.slice(5), body.sha);
      return {};
    }
    if (p === 'refs' && method === 'POST') {
      refs.set(body.ref.replace(/^refs\//, ''), body.sha);
      return {};
    }
    if (p.startsWith('refs/') && method === 'DELETE') return refs.delete(p.slice(5));
    if (p.startsWith('matching-refs/')) {
      const prefix = p.slice(14);
      return [...refs].filter(([r]) => r.startsWith(prefix)).map(([ref, sha]) => ({ ref: `refs/${ref}`, object: { sha } }));
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  await publishGithubRoom({ repo: 'ana/todo', name: 'Maya', room: 'todo', url: 'https://a.trycloudflare.com', api });
  await publishGithubRoom({ repo: 'ana/todo', name: 'Maya', room: 'todo', url: 'https://b.trycloudflare.com', api }); // refresh
  assert.equal(refs.size, 1, 'one ref per host, updated in place');
  const rooms = await listGithubRooms({ repo: 'ana/todo', api });
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].url, 'https://b.trycloudflare.com');
  await unpublishGithubRoom({ repo: 'ana/todo', name: 'Maya', api });
  assert.deepEqual(await listGithubRooms({ repo: 'ana/todo', api }), []);
});

test('a rate-limited GitHub API still finds the rooms, through git and github.com', async () => {
  const now = Date.now();
  const limited = async () => {
    throw new Error('GitHub answered 403: API rate limit exceeded');
  };
  const lsRemote = async () => [{ ref: 'refs/codev/rooms/maya', object: { sha: 'abc123' } }];
  const patch = async (repo, sha) =>
    `From ${sha} Mon Sep 17 00:00:00 2001\nSubject: [PATCH] CoDev room\n\n${roomMessage({ name: 'Maya', room: 'todo', url: 'https://c.trycloudflare.com', updated: now })}---\n`;
  const rooms = await listGithubRooms({ repo: 'ana/todo', api: limited, lsRemote, patch, now });
  assert.deepEqual(rooms.map((r) => r.url), ['https://c.trycloudflare.com']);
});

test('two apps on the same network hear each other, and never themselves', async (t) => {
  const errors = [];
  const a = startLan({ inst: 'A', onError: (e) => errors.push(e) });
  const b = startLan({ inst: 'B', onError: (e) => errors.push(e) });
  try {
    await new Promise((r) => setTimeout(r, 300));
    a.announce({ name: 'Maya', room: 'todo', port: 4321, r: 'r1', g: null });
    let heard = [];
    for (let i = 0; i < 20 && !heard.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      heard = b.peers();
    }
    if (!heard.length) return t.skip(`multicast is not available here${errors[0] ? ` (${errors[0].message})` : ''}`);
    assert.equal(heard[0].name, 'Maya');
    assert.match(heard[0].url, /^http:\/\/[\d.]+:4321$/);
    assert.deepEqual(a.peers(), [], 'an app does not find its own room');
  } finally {
    a.close();
    b.close();
  }
});

test('one app with several windows announces each room apart, and stops one without the others', async (t) => {
  const errors = [];
  const a = startLan({ inst: 'A', onError: (e) => errors.push(e) });
  const b = startLan({ inst: 'B', onError: (e) => errors.push(e) });
  const rooms = () => b.peers().map((p) => p.room).sort();
  const until = async (ok) => {
    for (let i = 0; i < 30 && !ok(); i++) await new Promise((r) => setTimeout(r, 100));
  };
  try {
    await new Promise((r) => setTimeout(r, 300));
    a.announce({ name: 'Maya', room: 'todo', port: 4321, r: 'r1', g: null }, 1);
    a.announce({ name: 'Maya', room: 'shop', port: 4321, r: 'r2', g: null }, 2);
    await until(() => rooms().length === 2);
    if (!rooms().length) return t.skip(`multicast is not available here${errors[0] ? ` (${errors[0].message})` : ''}`);
    assert.deepEqual(rooms(), ['shop', 'todo']);
    assert.deepEqual(a.peers(), [], 'an app does not find its own rooms');
    a.stop(1);
    a.announce({ name: 'Maya', room: 'shop', port: 4321, r: 'r2', g: null }, 2);
    assert.ok(true);
  } finally {
    a.close();
    b.close();
  }
});

async function serverWith(knocks, key = 'secret-key') {
  const server = await startServer({ port: 0, host: '127.0.0.1', key, knocks });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
const knock = (base, body) =>
  fetch(`${base}/api/knock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('knocking: the key is given only if the host allows it', async () => {
  const asked = [];
  let answer = true;
  const base = await serverWith({
    ask: async (req) => {
      asked.push(req);
      return answer;
    },
  });
  const info = await (await fetch(`${base}/api/info`)).json();
  assert.equal(info.knock, true);

  let res = await knock(base, { member: 'Maya', room: 'todo', project: { r: 'r1' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, room: 'todo', key: 'secret-key' });
  assert.deepEqual(asked[0], { member: 'Maya', room: 'todo', project: { r: 'r1' } });

  answer = false;
  res = await knock(base, { member: 'Eve', room: 'todo' });
  assert.equal(res.status, 403);
  assert.ok(!JSON.stringify(await res.json()).includes('secret-key'));

  res = await knock(base, { room: 'todo' });
  assert.equal(res.status, 400, 'a name is required');

  res = await fetch(`${base}/api/rooms/todo/state`);
  assert.equal(res.status, 401, 'knocking does not open the room itself');
});

test('knocking: servers that do not take requests say so, and the queue is limited', async () => {
  const plain = await serverWith(null);
  assert.equal((await knock(plain, { member: 'Maya', room: 'todo' })).status, 404);

  const waiting = [];
  const base = await serverWith({ ask: () => new Promise((resolve) => waiting.push(resolve)) });
  const pending = Array.from({ length: 5 }, (_, i) => knock(base, { member: `P${i}`, room: 'todo' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await knock(base, { member: 'P5', room: 'todo' })).status, 429);
  waiting.forEach((resolve) => resolve(false));
  await Promise.all(pending);
});
