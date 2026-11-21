// "codev init": connects the current project to a room and installs the hooks and the MCP server in Claude Code.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE } from './config.js';

const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codev.js');
const HOOK_EVENTS = {
  SessionStart: null,
  UserPromptSubmit: null,
  PreToolUse: 'Edit|Write|MultiEdit|NotebookEdit',
  PostToolUse: '*',
  Stop: null,
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
  const command = `node "${CLI_PATH}" hook`;
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
    execFileSync('claude', ['mcp', 'add', '--scope', 'local', 'codev', '--', 'node', CLI_PATH, 'mcp'], { cwd: root, stdio: 'ignore', env });
    return true;
  } catch {
    return false;
  }
}

/** Prepares a project for CoDev. Used by both `codev init` and the desktop app. */
export async function setupProject({ root, server, room, name, key = null, env }) {
  // .codev.json is git-ignored, so the room key never ends up in the repository.
  fs.writeFileSync(path.join(root, CONFIG_FILE), JSON.stringify({ server, room, name, ...(key && { key }) }, null, 2) + '\n');
  addToGitignore(root, [CONFIG_FILE, '.claude/settings.local.json']);
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
