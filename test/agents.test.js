// How each AI is started: Claude, DeepSeek and local models (in Claude Code), ChatGPT (Codex CLI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSpec, AGENTS, AGENT_IDS, agentLabel } from '../desktop/agents.js';
import { installCodexHooks } from '../cli/init.js';

const codev = { CODEV_SERVER: 'http://localhost:4321', CODEV_ROOM: 'r', CODEV_NAME: 'Ana · gpt', CODEV_KEY: 'k"ey' };
const runner = { exe: '/opt/CoDev/codev', cli: '/data/runtime/cli/codev.js', env: { ELECTRON_RUN_AS_NODE: '1' } };

test('every AI has a name for the header and a place in the picker', () => {
  assert.deepEqual(AGENT_IDS, ['claude', 'deepseek', 'local', 'chatgpt']);
  assert.equal(agentLabel('deepseek'), 'DeepSeek');
  assert.equal(agentLabel('chatgpt'), 'ChatGPT');
  assert.equal(agentLabel('nonsense'), 'Claude', 'an unknown AI falls back to the robot everybody knows');
  assert.ok(AGENTS.chatgpt.experimental, 'ChatGPT is still experimental');
  assert.ok(!AGENTS.claude.experimental);
});

test('Claude runs as it is', () => {
  assert.deepEqual(spawnSpec('claude'), { command: 'claude', args: [], env: {}, unset: [] });
});

test('DeepSeek runs inside Claude Code against its Anthropic API, and needs a key', () => {
  assert.throws(() => spawnSpec('deepseek', {}), /API key/);
  const s = spawnSpec('deepseek', { key: 'sk-1', model: 'deepseek-reasoner' });
  assert.equal(s.command, 'claude');
  assert.deepEqual(s.args, ['--permission-mode', 'auto'], 'it works agentically, with Claude Code\'s safeguards');
  assert.equal(s.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, 'sk-1');
  assert.equal(s.env.ANTHROPIC_MODEL, 'deepseek-reasoner');
  assert.equal(s.env.ENABLE_TOOL_SEARCH, 'false', "DeepSeek's endpoint rejects Claude Code's tool search");
  assert.equal(s.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '128000', 'Claude Code must not assume its 1M window');
  assert.equal(s.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '120000');
  assert.ok(s.unset.includes('ANTHROPIC_API_KEY'), 'an inherited Anthropic key must not take over');
  assert.equal(spawnSpec('deepseek', { key: 'x', model: 'made-up' }).env.ANTHROPIC_MODEL, 'deepseek-chat');
});

test('a local model runs inside Claude Code against Ollama', () => {
  assert.throws(() => spawnSpec('local', {}), /local model/);
  const s = spawnSpec('local', { model: 'qwen3:14b' });
  assert.equal(s.command, 'claude');
  assert.equal(s.env.ANTHROPIC_BASE_URL, 'http://localhost:11434');
  assert.equal(s.env.ANTHROPIC_MODEL, 'qwen3:14b');
  assert.equal(s.env.ENABLE_TOOL_SEARCH, 'false', "Ollama's endpoint does not implement tool search");
});

test('ChatGPT runs in Codex with the CoDev MCP server and rules passed at launch', () => {
  const s = spawnSpec('chatgpt', { codev, runner, rules: 'Line one\n"quoted"', model: 'gpt-5' });
  assert.equal(s.command, 'codex');
  const values = Object.fromEntries(
    s.args.flatMap((a, i) => (s.args[i - 1] === '-c' ? [[a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]] : []))
  );
  assert.equal(JSON.parse(values['mcp_servers.codev.command']), '/opt/CoDev/codev');
  assert.deepEqual(JSON.parse(values['mcp_servers.codev.args']), ['/data/runtime/cli/codev.js', 'mcp']);
  assert.match(values['mcp_servers.codev.env'], /ELECTRON_RUN_AS_NODE = "1"/);
  assert.match(values['mcp_servers.codev.env'], /CODEV_KEY = "k\\"ey"/, 'values are escaped');
  assert.equal(JSON.parse(values.developer_instructions), 'Line one\n"quoted"');
  assert.deepEqual(s.args.slice(-2), ['-m', 'gpt-5']);
  assert.ok(AGENTS.chatgpt.experimental);
});

test('the Codex hooks go to .codex/hooks.json without touching other hooks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-codex-'));
  const file = path.join(root, '.codex', 'hooks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook' }] }] } }));

  installCodexHooks(root);
  installCodexHooks(root); // running it again must replace CoDev's hook, not add a second one
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
    assert.ok(settings.hooks[event]?.length, `${event} has a CoDev hook`);
  }
  const codevHooks = Object.values(settings.hooks)
    .flatMap((groups) => groups.flatMap((g) => g.hooks || []))
    .filter((h) => h.command.includes('codev') && h.command.endsWith(' hook'));
  assert.equal(codevHooks.length, 5);
  assert.ok(settings.hooks.PreToolUse.some((g) => g.matcher === 'Bash' && g.hooks[0].command === 'my-own-hook'), "the user's own hooks stay");
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /\.codex\/hooks\.json/);
  fs.rmSync(root, { recursive: true, force: true });
});
