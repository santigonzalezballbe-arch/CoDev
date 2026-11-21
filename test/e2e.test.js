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
  assert.equal(lines[1].result.tools.length, 7);
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
  ana.ws.send(JSON.stringify({ t: 'term-open', id: 't1', title: 'DeepSeek', agent: 'deepseek', cols: 100, rows: 30, d: 'FOTO' }));
  ana.ws.send(JSON.stringify({ t: 'term-data', id: 't1', d: '+dades' }));
  await tick();
  assert.ok(marc.msgs.some((m) => m.t === 'terms' && m.list.some((t) => t.id === 't1' && t.member === 'Ana' && t.agent === 'deepseek')), 'each screen knows which AI the terminal runs');
  assert.ok(marc.msgs.some((m) => m.t === 'term-data' && m.d === '+dades'));

  // Marc cannot write to Ana's terminal.
  marc.ws.send(JSON.stringify({ t: 'term-data', id: 't1', d: 'intruder' }));
  await tick();
  assert.ok(!ana.msgs.some((m) => m.d === 'intruder'));

  const late = await open('Laura');
  await tick();
  const init = late.msgs.find((m) => m.t === 'term-init');
  assert.equal(init.d, 'FOTO+dades');
  assert.equal(init.agent, 'deepseek', 'a late joiner gets the AI too');

  ana.ws.close();
  await tick();
  assert.ok(marc.msgs.findLast((m) => m.t === 'terms').list.length === 0, 'when it closes, the terminal goes away');
  marc.ws.close();
  late.ws.close();
});

test('a turn that changed files must be logged in codev/history before it ends', async () => {
  const sid = { session_id: 'turn-test' };
  await hook(dirB, { ...sid, hook_event_name: 'UserPromptSubmit', prompt: 'Rename the button' });
  // codev/ is never claimed, so teammates never wait for each other's logs
  const pre = await hook(dirB, { ...sid, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'codev/history/marc.md', content: 'x' } });
  assert.equal(pre.out, '');
  assert.ok(!(await state()).claims.some((c) => c.file.startsWith('codev/')));

  await hook(dirB, { ...sid, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/button.js', old_string: 'a', new_string: 'b' } });
  const blocked = JSON.parse((await hook(dirB, { ...sid, hook_event_name: 'Stop' })).out);
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /codev\/history\/marc\.md/);
  assert.match(blocked.reason, /src\/button\.js/);

  // Already continuing because of this hook: let it finish instead of looping
  assert.equal((await hook(dirB, { ...sid, hook_event_name: 'Stop', stop_hook_active: true })).out, '');

  await hook(dirB, { ...sid, hook_event_name: 'UserPromptSubmit', prompt: 'Rename it again' });
  await hook(dirB, { ...sid, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/button.js', old_string: 'b', new_string: 'c' } });
  await hook(dirB, { ...sid, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'codev/history/marc.md', content: '## log' } });
  assert.equal((await hook(dirB, { ...sid, hook_event_name: 'Stop' })).out, '', 'logged: it may finish');
});

test('every session starts with the CoDev rules, even alone in the room', async () => {
  const solo = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-solo-'));
  fs.writeFileSync(path.join(solo, '.codev.json'), JSON.stringify({ server: base, room: 'solo-room', name: 'Zoe' }));
  const ctx = JSON.parse((await hook(solo, { hook_event_name: 'SessionStart' })).out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /codev\/history\/zoe\.md/);
});

test("Claude's replies reach the room once, and so does a request for attention", async () => {
  const transcript = path.join(dirA, 'transcript.jsonl');
  const line = (o) => fs.appendFileSync(transcript, JSON.stringify(o) + '\n');
  line({ type: 'user', message: { role: 'user', content: 'An old prompt' } });
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'An old answer' }] } });
  line({ type: 'user', message: { role: 'user', content: 'Add a dark mode' } });
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'I will look at the CSS first.' }, { type: 'tool_use', name: 'Read' }] } });
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: '...' }] } });

  const sid = { session_id: 'replies', transcript_path: transcript };
  await hook(dirA, { ...sid, hook_event_name: 'UserPromptSubmit', prompt: 'Add a dark mode' });
  await hook(dirA, { ...sid, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'style.css' } });
  line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done: **dark mode** follows the system setting.' }] } });
  await hook(dirA, { ...sid, hook_event_name: 'Stop' });
  await hook(dirA, { ...sid, hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });

  const evs = (await state()).events.filter((e) => e.member === 'Ana');
  assert.deepEqual(evs.filter((e) => e.kind === 'reply').map((e) => e.summary), ['I will look at the CSS first.', 'Done: **dark mode** follows the system setting.']);
  assert.equal(evs.findLast((e) => e.kind === 'attention').summary, 'Claude needs your permission to use Bash');
});

/** Runs one MCP tool call in project `cwd` and returns its text. */
async function mcpCall(cwd, name, args = {}) {
  const p = spawn(process.execPath, [CLI, 'mcp'], { cwd });
  let buf = '';
  const done = new Promise((resolve) => {
    p.stdout.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n').filter(Boolean)) {
        try {
          const m = JSON.parse(line);
          if (m.id === 2) resolve(m.result.content[0].text);
        } catch {}
      }
    });
  });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  const text = await done;
  p.kill();
  return text;
}

test('the AIs can read the chat and search the whole history', async () => {
  const note = (body) => fetch(`${base}/api/rooms/test/note`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await note({ member: 'Laura', text: 'Team: we freeze the API until Friday' });
  await note({ member: 'Ana', to: 'Laura', text: 'Ok for me' });

  // A message to everyone reaches every AI with its next prompt (not only messages addressed to it)
  const ctx = JSON.parse((await hook(dirB, { hook_event_name: 'UserPromptSubmit', prompt: 'Next task' })).out).hookSpecificOutput.additionalContext;
  assert.match(ctx, /we freeze the API until Friday/);
  assert.match(ctx, /codev_search_history/);

  const chat = await mcpCall(dirB, 'codev_read_chat');
  assert.match(chat, /Laura wrote to everyone: Team: we freeze the API until Friday/);
  assert.match(chat, /Ana wrote to Laura: Ok for me/);

  const who = await mcpCall(dirB, 'codev_search_history', { query: 'auth.js', kind: 'edit' });
  assert.match(who, /Ana changed: Edited src\/auth\.js/);
  const prompts = await mcpCall(dirB, 'codev_search_history', { person: 'ana', kind: 'prompt' });
  assert.match(prompts, /Ana asked Claude: Build the login/);
  assert.equal(await mcpCall(dirB, 'codev_search_history', { query: 'nothing-like-this' }), 'Nothing in the history matches that.');
});

test('history search also reads the project history file the app keeps', async () => {
  const file = path.join(dirB, '.codev', 'history.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = Date.now() - 3 * 24 * 3_600_000;
  fs.appendFileSync(file, JSON.stringify({ room: 'test', ts: old, member: 'Marc', kind: 'prompt', summary: 'Migrate the database to Postgres' }) + '\n');
  fs.appendFileSync(file, JSON.stringify({ room: 'other', ts: old, member: 'Marc', kind: 'prompt', summary: 'Something in another room' }) + '\n');
  const found = await mcpCall(dirB, 'codev_search_history', { query: 'postgres' });
  assert.match(found, /Marc asked Claude: Migrate the database to Postgres/);
  assert.equal(await mcpCall(dirB, 'codev_search_history', { query: 'another room' }), 'Nothing in the history matches that.', 'other rooms stay out');
  assert.equal(await mcpCall(dirB, 'codev_search_history', { query: 'postgres', since_hours: 24 }), 'Nothing in the history matches that.');
});

test("ChatGPT's patches (Codex) are locked and logged like Claude's edits", async () => {
  const patch = '*** Begin Patch\n*** Update File: src/auth.js\n@@\n-a\n+b\n*** Add File: src/new.js\n+x\n*** End Patch';
  // Marc's ChatGPT wants to patch src/auth.js, which Ana holds: denied
  await hook(dirA, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/auth.js', old_string: 'a', new_string: 'b' } });
  const res = JSON.parse((await hook(dirB, { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { input: patch } })).out);
  assert.equal(res.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(res.hookSpecificOutput.permissionDecisionReason, /src\/auth\.js/);

  await hook(dirB, { hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { input: patch } });
  await hook(dirB, { hook_event_name: 'PostToolUse', tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'npm test'] } });
  const evs = (await state()).events.filter((e) => e.member === 'Marc');
  assert.equal(evs.findLast((e) => e.kind === 'edit').summary, 'Edited src/auth.js, src/new.js');
  assert.equal(evs.findLast((e) => e.kind === 'command').summary, '$ npm test');
});
