// Minimal MCP server (JSON-RPC over stdio) so the AI can see the team and coordinate.
import readline from 'node:readline';
import { findConfig, toProjectPath, api, teamSummary } from './config.js';

const TOOLS = [
  {
    name: 'codev_team_status',
    description: "Shows what your teammates' AIs are doing right now: current task, claimed files and recent activity. Check it before starting a large task.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'codev_claim_files',
    description: "Claims files before you work on them so no teammate touches them. Returns the ones that already belong to someone else.",
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'File paths (relative to the project, or absolute)' },
        intent: { type: 'string', description: 'What you will do there, in one sentence' },
      },
      required: ['files'],
    },
  },
  {
    name: 'codev_release_files',
    description: 'Releases files you no longer need (or all of them, if you pass none) so teammates can work on them.',
    inputSchema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } } },
  },
  {
    name: 'codev_send_note',
    description: "Sends a note to a teammate (or the whole team): they see it on screen and their AI receives it. Useful to ask for a file or to announce an interface change.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        to: { type: 'string', description: "Teammate's name. Empty = the whole team" },
      },
      required: ['text'],
    },
  },
  {
    name: 'codev_set_intent',
    description: "Tells the team the plan or task you are working on now.",
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

async function callTool(cfg, name, args = {}) {
  if (!cfg) return 'CoDev is not set up in this project. Run `codev init` at the project root.';
  const files = (args.files || []).map((f) => toProjectPath(cfg, f) || f);
  switch (name) {
    case 'codev_team_status': {
      const state = await api(cfg, 'state');
      return teamSummary(cfg, state, { maxEvents: 12 }) || 'There are no teammates in the room right now.';
    }
    case 'codev_claim_files': {
      const { claimed, conflicts } = await api(cfg, 'claim', { files, intent: args.intent });
      let text = claimed.length ? `Claimed: ${claimed.join(', ')}.` : 'No files were claimed.';
      for (const c of conflicts) text += `\nTAKEN: ${c.file} belongs to ${c.owner}${c.intent ? ` (${c.intent})` : ''}. Do not modify it.`;
      return text;
    }
    case 'codev_release_files':
      await api(cfg, 'release', args.files?.length ? { files } : {});
      return args.files?.length ? `Released: ${files.join(', ')}` : 'All your files have been released.';
    case 'codev_send_note':
      await api(cfg, 'note', { text: args.text, to: args.to || null, from: 'ai' });
      return `Note sent${args.to ? ` to ${args.to}` : ' to the team'}.`;
    case 'codev_set_intent':
      await api(cfg, 'intent', { text: args.text });
      return 'Task announced to the team.';
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

export function runMcp() {
  const cfg = findConfig();
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id === undefined || msg.id === null) return; // notifications: no reply

    try {
      let result;
      switch (msg.method) {
        case 'initialize':
          result = {
            protocolVersion: msg.params?.protocolVersion || '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'codev', version: '0.1.0' },
          };
          break;
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools: TOOLS };
          break;
        case 'tools/call':
          try {
            const text = await callTool(cfg, msg.params?.name, msg.params?.arguments);
            result = { content: [{ type: 'text', text }] };
          } catch (err) {
            if (err.code) throw err;
            result = { content: [{ type: 'text', text: `CoDev error: ${err.message}` }], isError: true };
          }
          break;
        default:
          throw Object.assign(new Error(`Unsupported method: ${msg.method}`), { code: -32601 });
      }
      send({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code || -32603, message: err.message } });
    }
  });
}
