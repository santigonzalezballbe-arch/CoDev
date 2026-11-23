// Claude Code hook handler. Receives the event JSON on stdin.
// Golden rule: if CoDev fails (server down, etc.) it must never block the user's session.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { findConfig, toProjectPath, api, teamSummary, projectRules, historyPath } from './config.js';
import { autoPushEnabled, appendLog, stamp, publishLogInBackground } from './gitsync.js';
import { openMarker, closeMarker } from '../desktop/presence.js';

/** Writes a line in the person's log (if `entry`) and publishes the log to the git remote in the background. */
function syncLog(cfg, entry, message) {
  if (!autoPushEnabled(cfg)) return;
  const file = historyPath(cfg);
  try {
    if (entry) appendLog(cfg.root, file, entry);
  } catch {
    return;
  }
  publishLogInBackground(cfg.root, [file, 'codev/README.md'], message);
}

const agentName = (input) => (input.transcript_path ? 'Claude Code' : 'AI');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

function editedFile(cfg, input) {
  const ti = input.tool_input || {};
  return toProjectPath(cfg, ti.file_path || ti.notebook_path, input.cwd || cfg.root);
}

/** Codex (ChatGPT) edits with patches: "*** Update File: src/a.js", "*** Add File: …", "*** Delete File: …". */
export function patchOf(input) {
  const ti = input.tool_input;
  const texts = typeof ti === 'string' ? [ti] : Object.values(ti || {}).filter((v) => typeof v === 'string');
  if (Array.isArray(ti?.command)) texts.push(ti.command.join(' '));
  return texts.find((t) => t.includes('*** Begin Patch')) || null;
}
const patchFiles = (patch) => [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1].trim());

/** Every project file this tool call writes: Claude's edit tools or a Codex patch. */
function editedFiles(cfg, input) {
  if (EDIT_TOOLS.has(input.tool_name)) return [editedFile(cfg, input)].filter(Boolean);
  const patch = patchOf(input);
  if (!patch) return [];
  return [...new Set(patchFiles(patch).map((f) => toProjectPath(cfg, f, input.cwd || cfg.root)).filter(Boolean))];
}

/** Turns a tool call into a readable activity entry. */
export function describeTool(cfg, input) {
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  const cwd = input.cwd || cfg.root;
  const rel = (p) => toProjectPath(cfg, p, cwd) || p;
  switch (tool) {
    case 'Edit':
      return { kind: 'edit', summary: `Edited ${rel(ti.file_path)}`, files: [rel(ti.file_path)], diff: { old: ti.old_string, new: ti.new_string } };
    case 'MultiEdit': {
      const edits = ti.edits || [];
      return {
        kind: 'edit',
        summary: `Made ${edits.length} edits to ${rel(ti.file_path)}`,
        files: [rel(ti.file_path)],
        diff: { old: edits.map((e) => e.old_string).join('\n⋯\n'), new: edits.map((e) => e.new_string).join('\n⋯\n') },
      };
    }
    case 'Write': {
      const lines = (ti.content || '').split('\n').length;
      return { kind: 'edit', summary: `Wrote ${rel(ti.file_path)} (${lines} lines)`, files: [rel(ti.file_path)], diff: { old: '', new: ti.content } };
    }
    case 'NotebookEdit':
      return { kind: 'edit', summary: `Edited notebook ${rel(ti.notebook_path)}`, files: [rel(ti.notebook_path)] };
    case 'Bash':
      return { kind: 'command', summary: ti.description ? `${ti.description}: $ ${clip(ti.command, 200)}` : `$ ${clip(ti.command, 240)}` };
    case 'Read':
      return { kind: 'read', summary: `Read ${rel(ti.file_path)}`, files: [rel(ti.file_path)] };
    case 'Grep':
      return { kind: 'read', summary: `Searched for "${clip(ti.pattern, 80)}"${ti.path ? ` in ${rel(ti.path)}` : ''}` };
    case 'Glob':
      return { kind: 'read', summary: `Looked for files ${clip(ti.pattern, 80)}` };
    case 'WebFetch':
    case 'WebSearch':
      return { kind: 'web', summary: `Looked up ${clip(ti.url || ti.query, 120)}` };
    case 'Task':
    case 'Agent':
      return { kind: 'agent', summary: `Started a subagent: ${clip(ti.description || ti.prompt, 120)}` };
    case 'TodoWrite': {
      const todos = ti.todos || [];
      const current = todos.find((t) => t.status === 'in_progress');
      return { kind: 'plan', summary: `Plan (${todos.filter((t) => t.status === 'completed').length}/${todos.length})${current ? `: now → ${current.content}` : ''}` };
    }
    default: {
      if (/codev_/.test(tool || '')) return null; // CoDev's own tools already leave their own trace
      // Codex (ChatGPT): edits come as patches, commands as a command line.
      const patch = patchOf(input);
      if (patch) {
        const files = patchFiles(patch).map(rel);
        return { kind: 'edit', summary: `Edited ${files.join(', ') || 'files'}`, files, diff: { old: '', new: clip(patch, 4000) } };
      }
      const cmd = Array.isArray(ti.command) ? ti.command.join(' ') : typeof ti.command === 'string' ? ti.command : null;
      if (cmd) return { kind: 'command', summary: `$ ${clip(cmd.replace(/^(bash|sh) -l?c /, ''), 240)}` };
      return { kind: 'tool', summary: `Used ${tool}` };
    }
  }
}

/* What happened in the current turn, kept per session in .codev/turns/ (git-ignored). */
const turnFile = (cfg, input) => path.join(cfg.root, '.codev', 'turns', `${String(input.session_id || 'session').replace(/[^\w-]/g, '')}.json`);
function readTurn(cfg, input) {
  try {
    return JSON.parse(fs.readFileSync(turnFile(cfg, input), 'utf8'));
  } catch {
    return { edited: [], logged: false };
  }
}
function writeTurn(cfg, input, turn) {
  try {
    fs.mkdirSync(path.dirname(turnFile(cfg, input)), { recursive: true });
    fs.writeFileSync(turnFile(cfg, input), JSON.stringify(turn));
  } catch {}
}

/* Claude's own words, for the chat view: read from the session transcript Claude Code keeps
   (transcript_path, one JSON object per line). Only the text written since the last prompt. */
function readTail(file, bytes = 1_500_000) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    return len < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  }
}

const isPrompt = (content) =>
  typeof content === 'string'
    ? !content.startsWith('<')
    : Array.isArray(content) && content.some((c) => c.type === 'text') && !content.some((c) => c.type === 'tool_result');

/** Claude's texts since the last prompt, each with a stable id (the transcript entry's uuid). */
export function replyEntriesSinceLastPrompt(transcript) {
  const entries = [];
  for (const line of readTail(transcript).split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  let start = -1;
  entries.forEach((e, i) => {
    if (e.type === 'user' && !e.isMeta && isPrompt(e.message?.content)) start = i;
  });
  const out = [];
  for (const e of entries.slice(start + 1)) {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    e.message.content.forEach((c, j) => {
      if (c.type !== 'text' || !c.text?.trim()) return;
      const text = c.text.trim();
      out.push({ id: e.uuid ? `${e.uuid}:${j}` : `t:${hash(text)}`, text });
    });
  }
  return out;
}

const hash = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);

/* The replies already sent, per session. Kept apart from the turn (which is reset at every prompt
   and every Stop): a turn that starts without a prompt (a background task finishing, a wake-up)
   reads the same texts again, and a count would send them all twice. */
const sentFile = (cfg, input) => turnFile(cfg, input).replace(/\.json$/, '.sent.json');
function readSent(cfg, input) {
  try {
    return JSON.parse(fs.readFileSync(sentFile(cfg, input), 'utf8'));
  } catch {
    return [];
  }
}

/** Sends the replies not sent yet in this session. Returns how many were new. */
async function sendReplies(cfg, input) {
  if (!input.transcript_path) return 0;
  const sent = readSent(cfg, input);
  const seen = new Set(sent);
  const fresh = replyEntriesSinceLastPrompt(input.transcript_path).filter((r) => !seen.has(r.id));
  for (const r of fresh) {
    await api(cfg, 'activity', { kind: 'reply', tool: 'claude', summary: clip(r.text, 8000) });
    sent.push(r.id);
  }
  if (fresh.length) {
    try {
      fs.mkdirSync(path.dirname(sentFile(cfg, input)), { recursive: true });
      fs.writeFileSync(sentFile(cfg, input), JSON.stringify(sent.slice(-500)));
    } catch {}
  }
  return fresh.length;
}

function output(obj) {
  process.stdout.write(JSON.stringify(obj));
}

export async function runHook() {
  let input;
  try {
    input = JSON.parse((await readStdin()) || '{}');
  } catch {
    return;
  }
  const cfg = findConfig(input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!cfg) return;

  try {
    switch (input.hook_event_name) {
      case 'SessionStart':
      case 'UserPromptSubmit': {
        if (input.hook_event_name === 'UserPromptSubmit') writeTurn(cfg, input, { edited: [], logged: false });
        // A new session (not a /clear or a compaction): leave a line in the log and push it, so the
        // team sees in the repository that this person is working.
        if (input.hook_event_name === 'SessionStart' && !['clear', 'compact'].includes(input.source)) {
          const ts = Date.now();
          syncLog(
            cfg,
            `## ${stamp(new Date(ts))} — ${cfg.name} opened a session in room "${cfg.room}" (${agentName(input)})\n${openMarker({ ts, room: cfg.room, name: cfg.name })}`,
            `codev: ${cfg.name} opened a session`
          );
        }
        // The rules go in even if the server cannot be reached.
        let team = null;
        try {
          if (input.hook_event_name === 'UserPromptSubmit' && input.prompt) {
            await api(cfg, 'intent', { text: clip(input.prompt.trim(), 8000) });
          } else {
            await api(cfg, 'status', { status: 'idle', summary: 'Opened a session' });
          }
          team = teamSummary(cfg, await api(cfg, 'state'));
        } catch {}
        const context = [projectRules(cfg), team].filter(Boolean).join('\n\n');
        output({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: context } });
        return;
      }

      case 'PreToolUse': {
        // codev/ holds each person's own log: never locked, so nobody waits for it.
        const files = editedFiles(cfg, input).filter((f) => !f.startsWith('codev/'));
        if (!files.length) return;
        const { conflicts } = await api(cfg, 'claim', { files });
        if (conflicts?.length) {
          const c = conflicts[0];
          output({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason:
                `CoDev: ${c.file} is being changed right now by ${c.owner}'s AI` +
                (c.intent ? ` (task: "${clip(c.intent, 160)}")` : '') +
                `. Do not edit it. Take another approach, work in another file, or coordinate with ${c.owner} using the codev_send_note tool. ` +
                `Explain this to the user.`,
            },
          });
        }
        // No conflict: print nothing, so Claude Code's normal permission checks still apply.
        return;
      }

      case 'PostToolUse': {
        const changed = editedFiles(cfg, input);
        if (changed.length) {
          const turn = readTurn(cfg, input);
          for (const file of changed) {
            if (file === historyPath(cfg)) turn.logged = true;
            else if (!file.startsWith('codev/') && !turn.edited.includes(file)) turn.edited.push(file);
          }
          writeTurn(cfg, input, turn);
        }
        // What Claude said before using the tool comes first, then what it did.
        await sendReplies(cfg, input);
        const act = describeTool(cfg, input);
        if (act) await api(cfg, 'activity', { tool: input.tool_name, ...act, files: (act.files || []).filter(Boolean) });
        return;
      }

      case 'Notification':
        // Claude is waiting for the person: a permission to answer, a question, an idle prompt.
        if (input.message) await api(cfg, 'activity', { kind: 'attention', tool: 'claude', summary: clip(String(input.message), 300) });
        return;

      case 'Stop': {
        // Changed files but did not log it: ask Claude to write its entry before finishing (only once:
        // stop_hook_active means it is already continuing because of this hook).
        // Claude's last words of the turn (the transcript can lag a moment behind the Stop event).
        if (!(await sendReplies(cfg, input))) {
          await new Promise((r) => setTimeout(r, 400));
          if (!(await sendReplies(cfg, input)) && typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim()) {
            // Agents whose transcript we cannot read (Codex) may pass their last reply directly.
            const turn = readTurn(cfg, input);
            if (!turn.lastSent || turn.lastSent !== input.last_assistant_message) {
              await api(cfg, 'activity', { kind: 'reply', tool: 'ai', summary: clip(input.last_assistant_message.trim(), 8000) });
              writeTurn(cfg, input, { ...turn, lastSent: input.last_assistant_message });
            }
          }
        }
        const turn = readTurn(cfg, input);
        if (turn.edited.length && !turn.logged && !input.stop_hook_active) {
          output({
            decision: 'block',
            reason:
              `CoDev: you changed ${turn.edited.slice(0, 5).join(', ')}${turn.edited.length > 5 ? '…' : ''} in this turn but did not log it. ` +
              `Append an entry at the end of ${historyPath(cfg)} (a "## <date and time>" heading, the request, what changed and why, what is left), then finish.`,
          });
          return;
        }
        // The AI wrote its log entry: publish it now, without waiting for anyone to commit.
        if (turn.logged) syncLog(cfg, null, `codev: ${cfg.name}'s log`);
        writeTurn(cfg, input, { edited: [], logged: false });
        await api(cfg, 'status', { status: 'idle', summary: 'Finished its turn' });
        return;
      }

      case 'SessionEnd':
        {
          const ts = Date.now();
          syncLog(cfg, `## ${stamp(new Date(ts))} — ${cfg.name} closed the session\n${closeMarker({ ts })}`, `codev: ${cfg.name} closed a session`);
        }
        await api(cfg, 'release', {});
        await api(cfg, 'status', { status: 'offline', summary: 'Closed the session and released its files' });
        return;
    }
  } catch {
    // Fail open: CoDev must never break anyone's work.
  }
}
