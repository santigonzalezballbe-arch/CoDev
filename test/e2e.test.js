// End-to-end test: a real server + "codev hook" and "codev mcp" run exactly as Claude Code would.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/server.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'codev.js');
let server, base, dirA, dirB;

function project(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `codev-${name}-`));
  fs.writeFileSync(path.join(dir, '.codev.json'), JSON.stringify({ server: base, room: 'test', name }));
  return dir;
}

function run(args, stdin, cwd) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
    p.stdin.end(stdin);
  });
}

const hook = (cwd, payload) => run(['hook'], JSON.stringify({ cwd, ...payload }), cwd);
const state = async () => (await fetch(`${base}/api/rooms/test/state`)).json();

before(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${server.address().port}`;
  dirA = project('Ana');
  dirB = project('Marc');
});
after(() => server.close());

test('the prompt is published as the current task', async () => {
  await hook(dirA, { hook_event_name: 'UserPromptSubmit', prompt: 'Build the login' });
  const s = await state();
  assert.equal(s.members.find((m) => m.name === 'Ana').intent, 'Build the login');
});

test("an edit claims the file and blocks the teammate's AI", async () => {
  const edit = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/auth.js', old_string: 'a', new_string: 'b' } };
  const a = await hook(dirA, edit);
  assert.equal(a.out, '', 'without a conflict it must not interfere with permissions');

  const b = await hook(dirB, { ...edit, tool_input: { ...edit.tool_input, file_path: path.join(dirB, 'src/auth.js') } });
  const res = JSON.parse(b.out);
  assert.equal(res.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(res.hookSpecificOutput.permissionDecisionReason, /Ana/);

  const s = await state();
  assert.deepEqual(s.claims.map((c) => [c.file, c.owner]), [['src/auth.js', 'Ana']]);
  assert.ok(s.events.some((e) => e.kind === 'conflict' && e.member === 'Marc'));
});

test('the AI gets context about what the teammate is doing', async () => {
  const r = await hook(dirB, { hook_event_name: 'UserPromptSubmit', prompt: 'Build the profile' });
  const ctx = JSON.parse(r.out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Ana/);
  assert.match(ctx, /src\/auth\.js/);
  assert.match(ctx, /Build the login/);
});

test('PostToolUse publishes the activity with a diff', async () => {
  await hook(dirA, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/auth.js', old_string: 'x', new_string: 'y' } });
  const ev = (await state()).events.findLast((e) => e.kind === 'edit');
  assert.equal(ev.summary, 'Edited src/auth.js');
  assert.deepEqual(ev.diff, { old: 'x', new: 'y' });
});

test('SessionEnd releases the files', async () => {
  await hook(dirA, { hook_event_name: 'SessionEnd' });
  assert.equal((await state()).claims.length, 0);
});

test('the MCP server answers and its tools work', async () => {
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'codev_claim_files', arguments: { files: ['src/Profile.jsx'], intent: 'perfil' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'codev_team_status', arguments: {} } },
  ];
  const p = spawn(process.execPath, [CLI, 'mcp'], { cwd: dirB });
  const lines = [];
  let buf = '';
  const done = new Promise((resolve) => {
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
        if (lines.length === 4) resolve();
      }
    });
  });
  for (const m of msgs) p.stdin.write(JSON.stringify(m) + '\n');
  await done;
  p.kill();
  lines.sort((a, b) => a.id - b.id);
  assert.equal(lines[0].result.serverInfo.name, 'codev');
  assert.equal(lines[1].result.tools.length, 5);
  assert.match(lines[2].result.content[0].text, /Claimed: src\/Profile\.jsx/);
  assert.match(lines[3].result.content[0].text, /Ana/);
});

test('terminals are relayed and late joiners get the snapshot', async () => {
  const { WebSocket } = await import('ws');
  const wsUrl = base.replace('http', 'ws') + '/ws?room=test&member=';
  const open = (name) =>
    new Promise((resolve) => {
      const ws = new WebSocket(wsUrl + name);
      const msgs = [];
      ws.on('message', (d) => msgs.push(JSON.parse(d)));
      ws.on('open', () => resolve({ ws, msgs }));
    });
  const tick = () => new Promise((r) => setTimeout(r, 100));

  const ana = await open('Ana');
  const marc = await open('Marc');
  ana.ws.send(JSON.stringify({ t: 'term-open', id: 't1', title: 'Claude Code', cols: 100, rows: 30, d: 'FOTO' }));
  ana.ws.send(JSON.stringify({ t: 'term-data', id: 't1', d: '+dades' }));
  await tick();
  assert.ok(marc.msgs.some((m) => m.t === 'terms' && m.list.some((t) => t.id === 't1' && t.member === 'Ana')));
  assert.ok(marc.msgs.some((m) => m.t === 'term-data' && m.d === '+dades'));

  // Marc cannot write to Ana's terminal.
  marc.ws.send(JSON.stringify({ t: 'term-data', id: 't1', d: 'intruder' }));
  await tick();
  assert.ok(!ana.msgs.some((m) => m.d === 'intruder'));

  const late = await open('Laura');
  await tick();
  assert.equal(late.msgs.find((m) => m.t === 'term-init').d, 'FOTO+dades');

  ana.ws.close();
  await tick();
  assert.ok(marc.msgs.findLast((m) => m.t === 'terms').list.length === 0, 'when it closes, the terminal goes away');
  marc.ws.close();
  late.ws.close();
});
