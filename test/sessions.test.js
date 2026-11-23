// Sessions whose AI died without writing "closed" (window closed abruptly, app killed) get closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-sessions-'));
process.env.CODEV_SESSIONS_DIR = path.join(tmp, 'sessions');
const { registerSession, unregisterSession, closeDeadSessions, agentPid, alive } = await import('../cli/sessions.js');
const { openMarker, lastSession } = await import('../desktop/presence.js');

function project(name, logText) {
  const root = fs.mkdtempSync(path.join(tmp, 'p-'));
  fs.writeFileSync(path.join(root, '.codev.json'), JSON.stringify({ name, room: 'r' }));
  const file = `codev/history/${name.toLowerCase()}.md`;
  fs.mkdirSync(path.join(root, 'codev/history'), { recursive: true });
  fs.writeFileSync(path.join(root, file), logText);
  return { root, file };
}
const read = (p) => fs.readFileSync(path.join(p.root, p.file), 'utf8');

test('a dead session whose log still says open gets its closed line, once', () => {
  const ts = 1795449000000;
  const p = project('Pau', `## open\n${openMarker({ ts, room: 'r', name: 'Pau' })}\n`);
  registerSession({ pid: 111, root: p.root, name: 'Pau', file: p.file, since: ts });
  const closed = closeDeadSessions(() => false);
  assert.equal(closed.length, 1);
  assert.equal(lastSession(read(p)).state, 'close');
  assert.equal(closeDeadSessions(() => false).length, 0); // forgotten
});

test('a living session, or a later open, is left alone', () => {
  const ts = 1795449000000;
  const p = project('Ana', `${openMarker({ ts, room: 'r', name: 'Ana' })}\n`);
  registerSession({ pid: 222, root: p.root, name: 'Ana', file: p.file, since: ts });
  assert.equal(closeDeadSessions((pid) => pid === 222).length, 0);
  assert.equal(lastSession(read(p)).state, 'open');
  // Another AI of Ana on the same project is still running.
  registerSession({ pid: 333, root: p.root, name: 'Ana', file: p.file, since: ts });
  assert.equal(closeDeadSessions((pid) => pid === 333).length, 0);
  unregisterSession(333);
  // The log's last open is a newer session (maybe from another computer).
  const q = project('Joan', `${openMarker({ ts: ts + 5000, room: 'r', name: 'Joan' })}\n`);
  registerSession({ pid: 444, root: q.root, name: 'Joan', file: q.file, since: ts });
  assert.equal(closeDeadSessions(() => false).length, 0);
  assert.equal(lastSession(read(q)).state, 'open');
});

test('the AI process is the first ancestor that is not a shell', { skip: process.platform === 'win32' }, async () => {
  // node (this test) -> sh -c -> node child: the child should find this test's process.
  const child = spawn('/bin/sh', ['-c', `"${process.execPath}" --input-type=module -e "import('${path.resolve('cli/sessions.js')}').then(m => console.log(m.agentPid()))"; true`]);
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  await new Promise((r) => child.on('exit', r));
  assert.equal(Number(out.trim()), process.pid);
  assert.ok(alive(process.pid));
  assert.ok(!alive(2 ** 22 + 12345));
});
