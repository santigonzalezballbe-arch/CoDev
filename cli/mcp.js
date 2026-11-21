// Minimal MCP server (JSON-RPC over stdio) so the AI can see the team and coordinate.
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { findConfig, toProjectPath, api, teamSummary } from './config.js';
import { History } from '../desktop/history.js';

const KINDS = ['prompt', 'reply', 'edit', 'command', 'read', 'note', 'conflict', 'attention'];

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
    description: "Sends a message to a teammate's AI (or to every AI in the room) through the AIs' chat: it reaches that AI on its own, and people can watch. Useful to ask for a file, make a request, or announce an interface change.",
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
    name: 'codev_read_chat',
    description:
      "Reads the AIs' chat: messages and requests the AIs sent each other, and CoDev's alerts when it stopped an AI. Use it to catch up on what your teammates' AIs asked or decided. (The people's chat is private to the humans.)",
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'How many of the latest messages (default 40)' } } },
  },
  {
    name: 'codev_search_history',
    description:
      "Searches the room's history: every prompt, Claude reply, file change, command and chat message, from every teammate. " +
      'Use it to answer questions like "who changed src/auth.js and why?" or "what did Marc ask for yesterday?".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to find (all must appear) in the text, file names or person. Empty = latest entries' },
        person: { type: 'string', description: "Only this person's entries" },
        kind: { type: 'string', enum: KINDS, description: 'Only this kind of entry' },
        since_hours: { type: 'number', description: 'Only the last N hours' },
        limit: { type: 'number', description: 'How many results (default 25)' },
      },
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
    case 'codev_read_chat': {
      const msgs = (await roomHistory(cfg)).filter((e) => (e.kind === 'note' && e.from === 'ai') || e.kind === 'conflict').slice(-(args.limit || 40));
      if (!msgs.length) return 'The chat is empty.';
      return `Chat of room "${cfg.room}" (oldest first):\n` + msgs.map(formatEntry).join('\n');
    }
    case 'codev_search_history': {
      const words = String(args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
      const since = args.since_hours ? Date.now() - args.since_hours * 3_600_000 : 0;
      const hits = (await roomHistory(cfg)).filter(
        (e) =>
          e.kind !== 'status' &&
          !isPeopleChat(e) &&
          e.ts >= since &&
          (!args.person || e.member.toLowerCase().startsWith(String(args.person).toLowerCase())) &&
          (!args.kind || e.kind === args.kind) &&
          words.every((w) => [e.summary, e.member, ...(e.files || [])].join(' ').toLowerCase().includes(w))
      );
      if (!hits.length) return 'Nothing in the history matches that.';
      const shown = hits.slice(-(args.limit || 25));
      return `${hits.length} match${hits.length === 1 ? '' : 'es'}${hits.length > shown.length ? `, the latest ${shown.length}` : ''} (oldest first):\n` + shown.map(formatEntry).join('\n');
    }
    case 'codev_set_intent':
      await api(cfg, 'intent', { text: args.text });
      return 'Task announced to the team.';
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

/** A message of the people's chat: for the humans only, never shown to an AI. */
const isPeopleChat = (e) => e.kind === 'note' && e.from !== 'ai';

/**
 * The room's history as complete as this computer has it: what the server still keeps, plus the
 * project's local history file (.codev/history.jsonl, written by the CoDev app), without duplicates.
 */
async function roomHistory(cfg) {
  const byKey = new Map();
  const add = (e) => byKey.set(`${e.ts}|${e.member}|${e.kind}|${String(e.summary || '').slice(0, 80)}`, e);
  const file = path.join(cfg.root, '.codev', 'history.jsonl');
  if (fs.existsSync(file)) for (const e of new History(file).read()) if (!e.room || e.room === cfg.room) add(e);
  try {
    for (const e of (await api(cfg, 'state', null, { query: '?events=all' })).events) add(e);
  } catch {}
  return [...byKey.values()].sort((a, b) => a.ts - b.ts);
}

const WORD = { prompt: 'asked Claude', reply: 'Claude replied', edit: 'changed', command: 'ran', read: 'read', note: 'wrote', conflict: 'was stopped by CoDev', attention: 'Claude asked for attention' };

function formatEntry(e) {
  const d = new Date(e.ts);
  const when = `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 5)}`;
  const who = e.from === 'ai' ? `${e.member}'s AI` : e.member;
  const to = e.kind === 'note' ? ` to ${e.to || 'everyone'}` : '';
  const text = String(e.summary || '').replace(/\s+/g, ' ');
  const files = e.files?.length && e.kind !== 'edit' ? ` [${e.files.join(', ')}]` : '';
  return `- ${when} · ${who} ${WORD[e.kind] || e.kind}${to}: ${text.length > 700 ? text.slice(0, 700) + '…' : text}${files}`;
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
