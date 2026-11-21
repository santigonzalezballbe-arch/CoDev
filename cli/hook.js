// Claude Code hook handler. Receives the event JSON on stdin.
// Golden rule: if CoDev fails (server down, etc.) it must never block the user's session.
import { findConfig, toProjectPath, api, teamSummary } from './config.js';

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
    default:
      if (tool?.startsWith('mcp__codev__')) return null; // CoDev's own tools already leave their own trace
      return { kind: 'tool', summary: `Used ${tool}` };
  }
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
        if (input.hook_event_name === 'UserPromptSubmit' && input.prompt) {
          await api(cfg, 'intent', { text: clip(input.prompt.trim(), 8000) });
        } else {
          await api(cfg, 'status', { status: 'idle', summary: 'Opened a session' });
        }
        const state = await api(cfg, 'state');
        const context = teamSummary(cfg, state);
        if (context) output({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: context } });
        return;
      }

      case 'PreToolUse': {
        if (!EDIT_TOOLS.has(input.tool_name)) return;
        const file = editedFile(cfg, input);
        if (!file) return;
        const { conflicts } = await api(cfg, 'claim', { files: [file] });
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
        const act = describeTool(cfg, input);
        if (act) await api(cfg, 'activity', { tool: input.tool_name, ...act, files: (act.files || []).filter(Boolean) });
        return;
      }

      case 'Stop':
        await api(cfg, 'status', { status: 'idle', summary: 'Finished its turn' });
        return;

      case 'SessionEnd':
        await api(cfg, 'release', {});
        await api(cfg, 'status', { status: 'offline', summary: 'Closed the session and released its files' });
        return;
    }
  } catch {
    // Fail open: CoDev must never break anyone's work.
  }
}
