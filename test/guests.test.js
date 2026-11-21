// Guest terminals: a browser visitor's Claude Code, run by the host's app. Here the app is a fake.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../server/server.js';

const servers = [];
after(() => servers.forEach((s) => s.close()));

async function serverWith(guests) {
  const server = await startServer({ port: 0, host: '127.0.0.1', guests });
  servers.push(server);
  return `ws://127.0.0.1:${server.address().port}/ws?room=g&member=`;
}

const connect = (url) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url);
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d)));
    ws.on('open', () => resolve({ ws, msgs, send: (m) => ws.send(JSON.stringify(m)) }));
  });
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

test('without the desktop app hosting the room, guests are told to install it', async () => {
  const base = await serverWith(null);
  const laura = await connect(base + 'Laura');
  laura.send({ t: 'guest-open', id: 'g1', cols: 80, rows: 24 });
  await tick();
  assert.match(laura.msgs.find((m) => m.t === 'guest-denied').reason, /Install the CoDev app/);
  laura.ws.close();
});

test('a guest drives only their own terminal, and it closes when they leave', async () => {
  const calls = [];
  const base = await serverWith({
    open: (req, reply) => {
      calls.push(['open', req.member, req.id]);
      reply({ t: 'guest-ready', id: req.id });
      reply({ t: 'guest-data', id: req.id, d: 'hello' });
    },
    input: (id, d) => calls.push(['input', id, d]),
    resize: (id, c, r) => calls.push(['resize', id, c, r]),
    close: (id) => calls.push(['close', id]),
  });
  const laura = await connect(base + 'Laura');
  const eve = await connect(base + 'Eve');
  laura.send({ t: 'guest-open', id: 'g1', cols: 100, rows: 30 });
  await tick();
  assert.deepEqual(calls[0], ['open', 'Laura', 'g1']);
  assert.ok(laura.msgs.some((m) => m.t === 'guest-ready'));
  assert.ok(laura.msgs.some((m) => m.t === 'guest-data' && m.d === 'hello'));
  assert.ok(!eve.msgs.some((m) => m.t === 'guest-data'), 'output goes only to the guest');

  laura.send({ t: 'guest-input', id: 'g1', d: 'ls\r' });
  eve.send({ t: 'guest-input', id: 'g1', d: 'rm -rf /\r' });
  await tick();
  assert.deepEqual(calls.filter((c) => c[0] === 'input'), [['input', 'g1', 'ls\r']], "nobody else can type in it");

  laura.ws.close();
  await tick();
  assert.deepEqual(calls.at(-1), ['close', 'g1']);
  eve.ws.close();
});

test('a visitor without a name cannot ask for a terminal', async () => {
  const base = await serverWith({ open: () => assert.fail('must not open'), input() {}, resize() {}, close() {} });
  const anon = await connect(base.replace('&member=', ''));
  anon.send({ t: 'guest-open', id: 'g2' });
  await tick();
  assert.ok(anon.msgs.some((m) => m.t === 'guest-denied'));
  anon.ws.close();
});
