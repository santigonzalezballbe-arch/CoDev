// A locked server (the one the desktop app hosts): nothing is visible without the room key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startServer } from '../server/server.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'codev.js');
const KEY = 'test-room-key-123';
let server, base;

before(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1', key: KEY });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const state = (headers = {}) => fetch(`${base}/api/rooms/locked/state`, { headers });

test('without the key, the room cannot be read', async () => {
  assert.equal((await state()).status, 401);
  assert.equal((await state({ 'x-codev-key': 'wrong-key-of-same-size' })).status, 401);
  assert.equal((await fetch(`${base}/api/rooms/locked/stream`)).status, 401);
});

test('with the key, in a header or in the URL, it can', async () => {
  assert.equal((await state({ 'x-codev-key': KEY })).status, 200);
  assert.equal((await fetch(`${base}/api/rooms/locked/state?key=${KEY}`)).status, 200);
});

test('the info endpoint says the server is locked', async () => {
  const info = await (await fetch(`${base}/api/info`)).json();
  assert.equal(info.locked, true);
});

test('terminal WebSockets need the key', async () => {
  const wsBase = base.replace('http', 'ws') + '/ws?room=locked&member=Eve';
  const outcome = (url) =>
    new Promise((resolve) => {
      const ws = new WebSocket(url);
      ws.on('open', () => {
        ws.close();
        resolve('open');
      });
      ws.on('error', () => resolve('rejected'));
    });
  assert.equal(await outcome(wsBase), 'rejected');
  assert.equal(await outcome(`${wsBase}&key=${KEY}`), 'open');
});

test('hooks send the key from the environment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-key-'));
  await new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, 'hook'], {
      cwd: dir,
      env: { ...process.env, CODEV_SERVER: base, CODEV_ROOM: 'locked', CODEV_NAME: 'Ana', CODEV_ROOT: dir, CODEV_KEY: KEY },
    });
    p.on('close', resolve);
    p.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'Build the login', cwd: dir }));
  });
  const s = await (await state({ 'x-codev-key': KEY })).json();
  assert.equal(s.members.find((m) => m.name === 'Ana')?.intent, 'Build the login');
});
