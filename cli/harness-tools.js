// Turns a DeepSeek Harness tool call into a line CoDev can show: what kind of action it is,
// a readable summary ("$ npm test", "Read README.md", "Edited cli/hook.js") and the files it touches.
// The Harness's ACP bridge sends every tool call as { title: <tool name>, kind: 'other', rawInput },
// with no locations, so the details have to come from the arguments of each tool.

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Standard ACP kinds, for agents that do fill them in.
const ACP_KINDS = { edit: 'edit', delete: 'edit', move: 'edit', execute: 'command', read: 'read', search: 'read', fetch: 'web' };

/** Files named in an apply_patch body (*** Add/Update/Delete File: path, *** Move to: path). */
export function patchFiles(input) {
  const files = [];
  for (const m of String(input || '').matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) {
    const file = m[1].trim();
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

/**
 * @param tool - an ACP tool_call update (title, kind, rawInput, locations).
 * @param toRel - maps a path the tool used to a project-relative path (or null if outside).
 * @returns {{ kind: string, summary: string, files: string[] } | null}
 */
export function describeTool(tool, toRel = (p) => p) {
  const name = String(tool?.title || '').trim();
  const args = tool?.rawInput && typeof tool.rawInput === 'object' ? tool.rawInput : {};
  const rel = (p) => (p ? toRel(p) || p : '');
  const relAll = (list) => list.map(rel).filter(Boolean);
  // Files an edit touches: only those inside the project (CoDev tracks project files).
  const inProject = (list) => list.map((p) => (p ? toRel(p) : null)).filter(Boolean);
  const where = (p) => (p ? ` in ${rel(p)}` : '');

  switch (name.toLowerCase()) {
    case 'bash':
    case 'pwsh':
    case 'terminal':
      if (args.command) return { kind: 'command', summary: `$ ${oneLine(args.command)}`, files: [] };
      break;
    case 'read':
    case 'read_image':
      if (args.file_path) return { kind: 'read', summary: `Read ${rel(args.file_path)}`, files: [] };
      break;
    case 'write':
      if (args.file_path) {
        return { kind: 'edit', summary: `Wrote ${rel(args.file_path)}`, files: inProject([args.file_path]) };
      }
      break;
    case 'edit':
      if (args.file_path) {
        return { kind: 'edit', summary: `Edited ${rel(args.file_path)}`, files: inProject([args.file_path]) };
      }
      break;
    case 'str_replace_editor':
      if (args.path) {
        const file = rel(args.path);
        if (args.command === 'view') return { kind: 'read', summary: `Read ${file}`, files: [] };
        return { kind: 'edit', summary: `${args.command === 'create' ? 'Wrote' : 'Edited'} ${file}`, files: inProject([args.path]) };
      }
      break;
    case 'apply_patch': {
      const named = patchFiles(args.input ?? args.patch);
      if (named.length) return { kind: 'edit', summary: `Edited ${relAll(named).join(', ')}`, files: inProject(named) };
      break;
    }
    case 'grep':
      if (args.pattern) {
        const paths = Array.isArray(args.paths) ? args.paths : args.path ? [args.path] : [];
        const scope = paths.length ? ` in ${relAll(paths).join(', ')}` : '';
        return { kind: 'read', summary: `Searched "${oneLine(args.pattern)}"${scope}`, files: [] };
      }
      break;
    case 'glob':
      if (args.pattern) return { kind: 'read', summary: `Listed ${oneLine(args.pattern)}${where(args.path)}`, files: [] };
      break;
    case 'web_fetch':
      if (args.url) return { kind: 'web', summary: `Fetched ${args.url}`, files: [] };
      break;
    case 'web_search': {
      const queries = Array.isArray(args.queries) ? args.queries : args.query ? [args.query] : [];
      if (queries.length) return { kind: 'web', summary: `Searched the web: ${queries.map(oneLine).join(' · ')}`, files: [] };
      break;
    }
  }

  // Agents that fill in the standard ACP kind and locations.
  const kind = ACP_KINDS[tool?.kind];
  if (kind) {
    const paths = (tool.locations || []).map((l) => l.path);
    const title = name || tool.kind;
    if (kind === 'edit') return { kind, summary: `Edited ${relAll(paths).join(', ') || title}`, files: inProject(paths) };
    if (kind === 'command') return { kind, summary: `$ ${title}`, files: [] };
    return { kind, summary: title, files: [] };
  }

  // Anything else (todo, subagent, skill…): the tool name plus its main argument, if it has one.
  if (!name) return null;
  const main = ['description', 'command', 'file_path', 'path', 'url', 'query', 'pattern', 'name', 'prompt']
    .map((k) => args[k])
    .find((v) => typeof v === 'string' && v.trim());
  return { kind: 'tool', summary: main ? `${name}: ${oneLine(main)}` : name, files: [] };
}
