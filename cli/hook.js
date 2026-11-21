// Gestor dels hooks de Claude Code. Rep el JSON de l'esdeveniment per stdin.
// Regla d'or: si CoDev falla (servidor caigut, etc.) mai no ha de bloquejar la sessió de l'usuari.
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

/** Tradueix una crida d'eina a una entrada d'activitat llegible. */
export function describeTool(cfg, input) {
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  const cwd = input.cwd || cfg.root;
  const rel = (p) => toProjectPath(cfg, p, cwd) || p;
  switch (tool) {
    case 'Edit':
      return { kind: 'edit', summary: `Ha editat ${rel(ti.file_path)}`, files: [rel(ti.file_path)], diff: { old: ti.old_string, new: ti.new_string } };
    case 'MultiEdit': {
      const edits = ti.edits || [];
      return {
        kind: 'edit',
        summary: `Ha fet ${edits.length} edicions a ${rel(ti.file_path)}`,
        files: [rel(ti.file_path)],
        diff: { old: edits.map((e) => e.old_string).join('\n⋯\n'), new: edits.map((e) => e.new_string).join('\n⋯\n') },
      };
    }
    case 'Write': {
      const lines = (ti.content || '').split('\n').length;
      return { kind: 'edit', summary: `Ha escrit ${rel(ti.file_path)} (${lines} línies)`, files: [rel(ti.file_path)], diff: { old: '', new: ti.content } };
    }
    case 'NotebookEdit':
      return { kind: 'edit', summary: `Ha editat el notebook ${rel(ti.notebook_path)}`, files: [rel(ti.notebook_path)] };
    case 'Bash':
      return { kind: 'command', summary: ti.description ? `${ti.description}: $ ${clip(ti.command, 200)}` : `$ ${clip(ti.command, 240)}` };
    case 'Read':
      return { kind: 'read', summary: `Ha llegit ${rel(ti.file_path)}`, files: [rel(ti.file_path)] };
    case 'Grep':
      return { kind: 'read', summary: `Ha cercat "${clip(ti.pattern, 80)}"${ti.path ? ` a ${rel(ti.path)}` : ''}` };
    case 'Glob':
      return { kind: 'read', summary: `Ha buscat fitxers ${clip(ti.pattern, 80)}` };
    case 'WebFetch':
    case 'WebSearch':
      return { kind: 'web', summary: `Ha consultat ${clip(ti.url || ti.query, 120)}` };
    case 'Task':
    case 'Agent':
      return { kind: 'agent', summary: `Ha llançat un subagent: ${clip(ti.description || ti.prompt, 120)}` };
    case 'TodoWrite': {
      const todos = ti.todos || [];
      const current = todos.find((t) => t.status === 'in_progress');
      return { kind: 'plan', summary: `Pla (${todos.filter((t) => t.status === 'completed').length}/${todos.length})${current ? `: ara → ${current.content}` : ''}` };
    }
    default:
      if (tool?.startsWith('mcp__codev__')) return null; // les eines de CoDev ja deixen rastre pròpi
      return { kind: 'tool', summary: `Ha fet servir ${tool}` };
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
          await api(cfg, 'intent', { text: clip(input.prompt.trim(), 500) });
        } else {
          await api(cfg, 'status', { status: 'idle', summary: 'Ha obert una sessió' });
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
                `CoDev: ${c.file} ara mateix el modifica la IA de ${c.owner}` +
                (c.intent ? ` (tasca: "${clip(c.intent, 160)}")` : '') +
                `. No l'editis. Tria un altre enfocament, treballa en un altre fitxer o coordina't amb ${c.owner} amb l'eina codev_send_note. ` +
                `Explica-ho a l'usuari.`,
            },
          });
        }
        // Sense conflicte no escrivim res: així els permisos normals de Claude Code continuen aplicant-se.
        return;
      }

      case 'PostToolUse': {
        const act = describeTool(cfg, input);
        if (act) await api(cfg, 'activity', { tool: input.tool_name, ...act, files: (act.files || []).filter(Boolean) });
        return;
      }

      case 'Stop':
        await api(cfg, 'status', { status: 'idle', summary: 'Ha acabat el torn' });
        return;

      case 'SessionEnd':
        await api(cfg, 'release', {});
        await api(cfg, 'status', { status: 'offline', summary: 'Ha tancat la sessió i ha alliberat els seus fitxers' });
        return;
    }
  } catch {
    // Falla oberta: CoDev no pot trencar la feina de ningú.
  }
}
