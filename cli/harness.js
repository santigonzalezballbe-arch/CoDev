// CoDev's terminal for the DeepSeek Harness (DSH), without Claude Code.
//
// It speaks the Agent Client Protocol to `dsh --profile acp`, renders the conversation in the
// terminal CoDev already relays to the room, and publishes prompts, replies and tool activity to
// the CoDev server. The AI gets CoDev's MCP server, so it can see the team and claim files.
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { client, ndJsonStream } from '@agentclientprotocol/sdk';
import { findConfig, api, toProjectPath, teamSummary } from './config.js';
import { describeTool } from './harness-tools.js';

const cfg = findConfig();
const env = process.env;
const agent = env.CODEV_HARNESS_AGENT || 'deepseek';
const label = env.CODEV_HARNESS_LABEL || (agent === 'local' ? 'Local' : 'DeepSeek');
const model = env.CODEV_HARNESS_MODEL || '';
const dsh = env.CODEV_DSH || '';
const patch = env.CODEV_HARNESS_PATCH || '';
const mcpServers = JSON.parse(env.CODEV_HARNESS_MCP || '[]');

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const dim = (s) => `${DIM}${s}${RESET}`;

const say = (s = '') => process.stdout.write(`${s}\n`);

if (!cfg) {
  say(`${RED}CoDev: this terminal is not inside a CoDev project.${RESET}`);
  process.exit(1);
}
if (!dsh || !patch) {
  say(`${RED}CoDev: the DeepSeek Harness is not configured.${RESET}`);
  process.exit(1);
}

let busy = false;
let stopping = false;
let session = null;
let cancelCurrent = null;
let pendingAsk = null;

// DSH uses a native addon that does not support every Electron version: run it with real Node.
const node = env.CODEV_NODE || 'node';
const dshEnv = { ...env, DSH_PERMISSION_MODE: env.DSH_PERMISSION_MODE || 'danger-full-access' };
delete dshEnv.ELECTRON_RUN_AS_NODE;
const dshArgs = ['--profile', 'acp', '--patch', patch];
const isJs = /\.(cjs|mjs|js)$/.test(dsh);
const child = isJs
  ? spawn(node, [dsh, ...dshArgs], { cwd: cfg.root, env: dshEnv, stdio: ['pipe', 'pipe', 'pipe'] })
  : spawn(dsh, dshArgs, { cwd: cfg.root, env: dshEnv, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (data) => {
  const text = String(data).trim();
  // DSH logs model-list refreshes on stderr; only show lines that look like a problem.
  const line = text.split('\n').find((l) => /error|failed|invalid|cannot|unable|denied/i.test(l));
  if (line) say(dim(line.trim()));
});
child.on('exit', (code) => {
  if (!stopping) say(`${RED}The DeepSeek Harness exited (code ${code}).${RESET}`);
});

const toAgent = new WritableStream({
  write(chunk) {
    child.stdin.write(chunk);
  },
});
const fromAgent = new ReadableStream({
  start(controller) {
    child.stdout.on('data', (data) => controller.enqueue(new Uint8Array(data)));
  },
});

const app = client({ name: 'CoDev' });
// DSH asks before risky tools. CoDev runs it with full access, but answer anyway if a policy asks.
app.onRequest('session/request_permission', async (params) => {
  const allow =
    params.options.find((o) => o.kind === 'allow_once') ||
    params.options.find((o) => o.kind === 'allow_always') ||
    params.options.find((o) => o.kind?.startsWith('allow'));
  if (!allow) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId: allow.optionId } };
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 100 });

const ask = (question) =>
  new Promise((resolve) => {
    pendingAsk = resolve;
    rl.question(question, (answer) => {
      pendingAsk = null;
      resolve(answer);
    });
  });

function closeInput() {
  const resolve = pendingAsk;
  pendingAsk = null;
  if (resolve) resolve(null);
  rl.close();
}

/* ---------- CoDev room: prompts, replies and tool activity ---------- */
const publish = (action, body) => api(cfg, action, body).catch(() => {});
function isCodevTool(tool) {
  return /codev_/i.test(tool?.title || '') || /codev_/i.test(JSON.stringify(tool?.rawInput || {}));
}

const describe = (tool) => describeTool(tool, (p) => toProjectPath(cfg, p, cfg.root));

function publishTool(tool) {
  if (isCodevTool(tool)) return; // CoDev's own MCP tools already publish their own activity
  const action = describe(tool);
  if (action) publish('activity', { ...action, tool: 'harness', files: action.kind === 'edit' ? action.files : [] });
}

function printTool(tool) {
  const action = describe(tool);
  say(`\n${DIM}· ${action?.summary || tool.title || tool.kind || 'tool'}${RESET}`);
}

function handleUpdate(update) {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = update.content?.type === 'text' ? update.content.text : '';
      if (text) process.stdout.write(text);
      return text;
    }
    case 'tool_call':
      printTool(update);
      publishTool(update);
      return '';
    case 'plan':
      for (const entry of update.entries || []) say(`${DIM}· ${entry.status}: ${entry.content}${RESET}`);
      return '';
    case 'agent_thought_chunk':
      return '';
    default:
      return '';
  }
}

/* ---------- One turn ---------- */
async function runTurn(text) {
  busy = true;
  let reply = '';
  let failed = false;
  await publish('intent', { text: text.trim() });
  // Same as the Claude Code hook: give the AI the team's state before every prompt.
  let withTeam = text;
  try {
    const team = teamSummary(cfg, await api(cfg, 'state'));
    if (team) withTeam = `${team}\n\n[CoDev] Your task:\n${text}`;
  } catch {}
  const prompt = session.prompt(withTeam);
  const promptError = prompt.then(
    () => null,
    (error) => error
  );

  while (true) {
    const next = await Promise.race([
      session.nextUpdate().then((message) => ({ message })),
      promptError.then((error) => (error ? { error } : { never: true })),
    ]);
    if (next.never) {
      // The prompt settled without an update: wait for the queued stop.
      continue;
    }
    if (next.error) {
      failed = true;
      say(`\n${RED}${next.error.message || next.error}${RESET}`);
      break;
    }
    const message = next.message;
    if (message.kind === 'stop') break;
    reply += handleUpdate(message.update);
  }

  if (!failed) await prompt.catch(() => {});
  if (reply.trim()) await publish('activity', { kind: 'reply', tool: 'harness', summary: reply.trim() });
  await publish('status', { status: 'idle', summary: 'Finished its turn' });
  busy = false;
  cancelCurrent = null;
}

/* ---------- Input ---------- */
function cancel() {
  if (!busy || !cancelCurrent) return;
  say(dim('\nCancelling…'));
  cancelCurrent();
}

rl.on('SIGINT', () => {
  if (busy) cancel();
  else {
    stopping = true;
    closeInput();
  }
});

process.on('SIGTERM', () => {
  stopping = true;
  closeInput();
  child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
});

/* ---------- Main ---------- */
say(`\n${BOLD}CoDev${RESET} ${dim(`· ${label} Harness`)}`);
say(dim(`Model ${model} · ${path.basename(cfg.root)}`));
say(dim('Type a task and press Enter. Ctrl+C cancels a turn; /exit closes the terminal.'));

try {
  await app.connectWith(ndJsonStream(toAgent, fromAgent), async (ctx) => {
    session = await ctx
      .buildSession({ cwd: cfg.root, mcpServers })
      .start();
    cancelCurrent = () => ctx.notify('session/cancel', { sessionId: session.sessionId }).catch(() => {});
    say(dim(`Session ${session.sessionId.slice(0, 8)} ready.`));

    while (!stopping) {
      const line = await ask(`\n${BOLD}❯${RESET} `);
      if (line == null) break;
      const text = line.trim();
      if (!text) continue;
      if (text === '/exit' || text === '/quit') break;
      if (text === '/help') {
        say(dim('Just type a task. /exit closes the terminal. Ctrl+C cancels a running turn.'));
        continue;
      }
      try {
        await runTurn(text);
      } catch (error) {
        say(`\n${RED}${error.message || error}${RESET}`);
      }
      say('');
    }

    try {
      await ctx.request('session/close', { sessionId: session.sessionId });
    } catch {}
  });
} catch (error) {
  if (!/readline was closed/i.test(error?.message || '')) say(`\n${RED}CoDev: ${error.message || error}${RESET}`);
} finally {
  stopping = true;
  closeInput();
  child.kill('SIGTERM');
  await publish('release', {});
  await publish('status', { status: 'offline', summary: 'Closed the terminal and released its files' });
  process.exit(0);
}
