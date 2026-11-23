// "codev init": connects the current project to a room and installs the hooks and the MCP server in Claude Code.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE } from './config.js';

const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codev.js');

/**
 * How the hooks and the MCP server run the CLI. From source: `node cli/codev.js`. The packaged app
 * has no separate Node, so it runs its own binary as Node (ELECTRON_RUN_AS_NODE=1) on a copy of the
 * CLI kept at a stable path (see desktop/main.js).
 */
let RUNNER = { exe: null, cli: CLI_PATH, env: {} };
export function useRunner(runner) {
  RUNNER = { env: {}, ...runner };
}
export const getRunner = () => ({ exe: RUNNER.exe || 'node', cli: RUNNER.cli, env: { ...RUNNER.env } });
const quote = (s) => `"${String(s).replace(/\\/g, '/')}"`;
const envPrefix = () => Object.entries(RUNNER.env).map(([k, v]) => `${k}=${v} `).join('');
const hookCommand = () => `${envPrefix()}${RUNNER.exe ? quote(RUNNER.exe) : 'node'} ${quote(RUNNER.cli)} hook`;
const HOOK_EVENTS = {
  SessionStart: null,
  UserPromptSubmit: null,
  PreToolUse: 'Edit|Write|MultiEdit|NotebookEdit',
  PostToolUse: '*',
  Stop: null,
  Notification: null,
  SessionEnd: null,
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const isCodevHook = (h) => typeof h?.command === 'string' && h.command.includes('codev') && h.command.endsWith(' hook');

export function installHooks(root) {
  const file = path.join(root, '.claude', 'settings.local.json');
  const settings = readJson(file);
  settings.hooks ||= {};
  const command = hookCommand();
  for (const [event, matcher] of Object.entries(HOOK_EVENTS)) {
    // Remove earlier CoDev installs and leave the user's own hooks untouched.
    const groups = (settings.hooks[event] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isCodevHook(h)) }))
      .filter((g) => g.hooks.length);
    const group = { hooks: [{ type: 'command', command, timeout: 10 }] };
    if (matcher) group.matcher = matcher;
    groups.push(group);
    settings.hooks[event] = groups;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

/**
 * Codex (ChatGPT) reads Claude-compatible hooks from .codex/hooks.json in the project. Same handler,
 * same events. Codex asks the user to trust new hooks once before running them.
 */
export function installCodexHooks(root) {
  const file = path.join(root, '.codex', 'hooks.json');
  const settings = readJson(file);
  settings.hooks ||= {};
  const command = hookCommand();
  for (const [event, matcher] of Object.entries({ SessionStart: null, UserPromptSubmit: null, PreToolUse: '*', PostToolUse: '*', Stop: null })) {
    const groups = (settings.hooks[event] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isCodevHook(h)) }))
      .filter((g) => g.hooks.length);
    const group = { hooks: [{ type: 'command', command, timeout: 10 }] };
    if (matcher) group.matcher = matcher;
    groups.push(group);
    settings.hooks[event] = groups;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  addToGitignore(root, ['.codex/hooks.json']);
  return file;
}

function addToGitignore(root, entries) {
  const file = path.join(root, '.gitignore');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = entries.filter((e) => !current.split('\n').includes(e));
  if (missing.length) fs.appendFileSync(file, (current && !current.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
}

function installMcp(root, env = process.env) {
  try {
    execFileSync('claude', ['mcp', 'remove', '--scope', 'local', 'codev'], { cwd: root, stdio: 'ignore', env });
  } catch {}
  try {
    const envArgs = Object.entries(RUNNER.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    execFileSync('claude', ['mcp', 'add', '--scope', 'local', 'codev', ...envArgs, '--', RUNNER.exe || 'node', RUNNER.cli, 'mcp'], {
      cwd: root,
      stdio: 'ignore',
      env,
    });
    return true;
  } catch {
    return false;
  }
}

/** codev/ in the repository: each person's AI keeps its own log there (see projectRules). */
function ensureCodevFolder(root) {
  const readme = path.join(root, 'codev', 'README.md');
  if (fs.existsSync(readme)) return;
  fs.mkdirSync(path.join(root, 'codev', 'history'), { recursive: true });
  fs.writeFileSync(
    readme,
    `# codev/

This folder is kept by the AIs of everyone working on this project with [CoDev](https://github.com/santigonzalezballbe-arch/CoDev).

- \`history/<name>.md\`: one log per person. After every task that changes files, that person's AI appends an entry:
  when, what was asked, what changed and why, and what is left to do.

Each person writes only their own file, so the logs never block each other and never conflict when you merge.
CoDev commits and pushes each person's log on its own (when a session opens or closes, and after each logged task),
so the team sees who is working without anyone committing by hand. Only that file goes in those commits, and
nobody's unpushed work is ever pushed for them. To turn it off, add \`"autoPush": false\` to \`.codev.json\`
or set \`CODEV_AUTOPUSH=0\`.
`
  );
}

/** Prepares a project for CoDev. Used by both `codev init` and the desktop app. */
export async function setupProject({ root, server, room, name, key = null, env }) {
  // .codev.json is git-ignored, so the room key never ends up in the repository.
  fs.writeFileSync(path.join(root, CONFIG_FILE), JSON.stringify({ server, room, name, ...(key && { key }) }, null, 2) + '\n');
  addToGitignore(root, [CONFIG_FILE, '.claude/settings.local.json', '.codev/']);
  ensureCodevFolder(root);
  const hooksFile = installHooks(root);
  const mcpOk = installMcp(root, env);
  let reachable = false;
  try {
    const res = await fetch(`${server}/api/rooms/${encodeURIComponent(room)}/state`, {
      signal: AbortSignal.timeout(2500),
      headers: key ? { 'x-codev-key': key } : {},
    });
    reachable = res.ok;
  } catch {}
  return { hooksFile, mcpOk, reachable };
}

export async function runInit(args) {
  const root = process.cwd();
  const server = (args.server || 'http://localhost:4321').replace(/\/$/, '');
  const room = args.room;
  const name = args.name;
  const key = typeof args.key === 'string' ? args.key : null;
  if (!room || !name) {
    console.error('Usage: codev init --room <room> --name <your-name> [--server http://host:4321] [--key <room-key>]');
    process.exit(1);
  }

  const { hooksFile, mcpOk, reachable } = await setupProject({ root, server, room, name, key });

  console.log(`✔ Created ${CONFIG_FILE} (room "${room}", name "${name}")`);
  console.log(`✔ Claude Code hooks in ${path.relative(root, hooksFile)}`);
  console.log(
    mcpOk
      ? '✔ MCP server "codev" added to Claude Code (local scope)'
      : `⚠ Could not add the MCP server. Add it by hand:\n   claude mcp add --scope local codev -- node "${CLI_PATH}" mcp`
  );
  console.log(reachable ? `✔ Server reachable at ${server}` : `⚠ Cannot reach ${server}. Start it with \`codev server\`.`);
  console.log(`\nOpen the split screen: ${server}/?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`);
  console.log('Then open Claude Code in this project (restart it if it was already open).');
}
