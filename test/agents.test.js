// How each AI is started: Claude, DeepSeek and local models (in Claude Code), ChatGPT (Codex CLI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSpec, harnessPatch, apiModels, AGENTS, AGENT_IDS, agentLabel } from '../desktop/agents.js';
import { installCodexHooks } from '../cli/init.js';

const codev = { CODEV_SERVER: 'http://localhost:4321', CODEV_ROOM: 'r', CODEV_NAME: 'Ana · gpt', CODEV_KEY: 'k"ey' };
const runner = { exe: '/opt/CoDev/codev', cli: '/data/runtime/cli/codev.js', env: { ELECTRON_RUN_AS_NODE: '1' } };

test('every AI has a name for the header and a place in the picker', () => {
  assert.deepEqual(AGENT_IDS, ['claude', 'deepseek', 'local', 'chatgpt', 'gemini', 'grok', 'openrouter', 'openai-api', 'mistral', 'kimi', 'groq']);
  assert.equal(agentLabel('deepseek'), 'DeepSeek');
  assert.equal(agentLabel('chatgpt'), 'ChatGPT');
  assert.equal(agentLabel('nonsense'), 'Claude', 'an unknown AI falls back to the robot everybody knows');
  assert.ok(AGENTS.chatgpt.experimental, 'ChatGPT is still experimental');
  assert.ok(!AGENTS.claude.experimental);
  assert.equal(AGENTS.claude.engine, 'claude');
  assert.equal(AGENTS.deepseek.engine, 'harness');
  assert.equal(AGENTS.local.engine, 'harness');
  assert.equal(AGENTS.chatgpt.engine, 'codex');
});

test('Claude runs as it is', () => {
  assert.deepEqual(spawnSpec('claude'), { command: 'claude', args: [], env: {}, unset: [] });
});

test('DeepSeek runs in the Harness, without Claude Code', () => {
  assert.equal(AGENTS.deepseek.engine, 'harness');
  assert.throws(() => spawnSpec('deepseek', {}), /DeepSeek Harness/);
  const { patch, model, provider } = harnessPatch('deepseek', { model: 'deepseek-v4-pro', rules: '[CoDev] rules for Ana' });
  assert.equal(model, 'deepseek-v4-pro');
  assert.equal(provider, 'deepseek-official');
  assert.match(patch, /name: '@deepseek-ai\/dsh-acp'/);
  assert.match(patch, /provider: "deepseek-official"/);
  assert.match(patch, /model: "deepseek-v4-pro"/);
  assert.match(patch, /apiKeyEnv: "DEEPSEEK_API_KEY"/);
  assert.ok(patch.includes('[CoDev] rules for Ana'), 'the CoDev rules reach the Harness');
  assert.ok(!patch.includes('DEEPSEEK-API-KEY'), 'the key never goes in the patch file');
});

test('a local model runs in the Harness against Ollama', () => {
  assert.equal(AGENTS.local.engine, 'harness');
  assert.throws(() => spawnSpec('local', {}), /DeepSeek Harness/);
  const { patch, model, provider } = harnessPatch('local', { model: 'qwen2.5-coder:7b' });
  assert.equal(model, 'qwen2.5-coder:7b');
  assert.equal(provider, 'ollama');
  assert.match(patch, /api: "openai-completions"/);
  assert.match(patch, /baseURL: "http:\/\/localhost:11434\/v1"/);
  assert.match(patch, /apiKeyEnv: "OLLAMA_API_KEY"/);
  assert.match(patch, /id: "qwen2.5-coder:7b"/);
  assert.match(patch, /model: "qwen2.5-coder:7b"/);
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

test('Gemini, Grok and the other APIs run in the Harness through their pi-ai route, with their own key', () => {
  for (const id of ['gemini', 'grok', 'openrouter', 'openai-api', 'mistral', 'kimi', 'groq']) {
    const a = AGENTS[id];
    assert.equal(a.engine, 'harness', id);
    assert.ok(a.needsKey && a.keyEnv && a.keyUrl && a.route, id);
  }
  const { patch, model, provider } = harnessPatch('grok', { model: 'grok-4.6', rules: '[CoDev] rules' });
  assert.equal(provider, 'xai');
  assert.equal(model, 'grok-4.6', 'any model of the catalog, even one not in our list');
  assert.match(patch, /name: '@deepseek-ai\/dsh-llm-pi-ai'/);
  assert.match(patch, /xai:\n\s+apiKeyEnv: "XAI_API_KEY"/);
  assert.match(patch, /provider: "xai"/);
  assert.ok(!/AIza|xai-/.test(patch), 'no key is ever written in the patch');
  assert.equal(harnessPatch('gemini', {}).model, AGENTS.gemini.defaultModel);
});

test('the models of an API come from the installed catalog, our suggestions first', () => {
  const catalog = {
    'google-generative-ai': {
      'chat:gemini-2.5-pro': { id: 'gemini-2.5-pro' },
      'chat:gemini-pro-latest': { id: 'gemini-pro-latest' },
      'chat:deep-research-preview-04-2026': { id: 'deep-research-preview-04-2026' },
      'image:imagen-5': { id: 'imagen-5' },
      'chat:gemini-9-ultra': { id: 'gemini-9-ultra' },
    },
  };
  const list = apiModels('gemini', (route) => (route === 'google' ? catalog : null));
  assert.equal(list[0], 'gemini-pro-latest');
  assert.ok(list.includes('gemini-9-ultra'), 'newer models of the catalog show up');
  assert.ok(!list.includes('deep-research-preview-04-2026') && !list.includes('imagen-5'));
  assert.ok(!list.includes('gemini-flash-latest'), 'a suggestion the catalog lacks is left out');
  assert.deepEqual(apiModels('gemini', () => null), AGENTS.gemini.models, 'no catalog: our list');
  assert.deepEqual(apiModels('claude', () => catalog), []);
});
