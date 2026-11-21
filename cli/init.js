// "codev init": connecta el projecte actual a una sala i instal·la els hooks i el MCP a Claude Code.
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
    // Treu instal·lacions anteriors de CoDev i deixa intactes els hooks propis de l'usuari.
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

function installMcp(root) {
  try {
    execFileSync('claude', ['mcp', 'remove', '--scope', 'local', 'codev'], { cwd: root, stdio: 'ignore' });
  } catch {}
  try {
    execFileSync('claude', ['mcp', 'add', '--scope', 'local', 'codev', '--', 'node', CLI_PATH, 'mcp'], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Prepara un projecte per a CoDev. La fan servir tant `codev init` com l'app d'escriptori. */
export async function setupProject({ root, server, room, name }) {
  fs.writeFileSync(path.join(root, CONFIG_FILE), JSON.stringify({ server, room, name }, null, 2) + '\n');
  addToGitignore(root, [CONFIG_FILE, '.claude/settings.local.json']);
  const hooksFile = installHooks(root);
  const mcpOk = installMcp(root);
  let reachable = false;
  try {
    const res = await fetch(`${server}/api/rooms/${encodeURIComponent(room)}/state`, { signal: AbortSignal.timeout(2500) });
    reachable = res.ok;
  } catch {}
  return { hooksFile, mcpOk, reachable };
}

export async function runInit(args) {
  const root = process.cwd();
  const server = (args.server || 'http://localhost:4321').replace(/\/$/, '');
  const room = args.room;
  const name = args.name;
  if (!room || !name) {
    console.error('Ús: codev init --room <sala> --name <el-teu-nom> [--server http://host:4321]');
    process.exit(1);
  }

  const { hooksFile, mcpOk, reachable } = await setupProject({ root, server, room, name });

  console.log(`✔ ${CONFIG_FILE} creat (sala "${room}", nom "${name}")`);
  console.log(`✔ Hooks de Claude Code a ${path.relative(root, hooksFile)}`);
  console.log(
    mcpOk
      ? '✔ Servidor MCP "codev" afegit a Claude Code (àmbit local)'
      : `⚠ No s'ha pogut afegir el MCP. Fes-ho a mà:\n   claude mcp add --scope local codev -- node "${CLI_PATH}" mcp`
  );
  console.log(reachable ? `✔ Servidor accessible a ${server}` : `⚠ No arribo a ${server}. Arrenca'l amb \`codev server\`.`);
  console.log(`\nObre la pantalla partida: ${server}/?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`);
  console.log('Després obre Claude Code en aquest projecte (si ja era obert, reinicia\'l).');
}
