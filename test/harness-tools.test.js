// What the room sees when a DeepSeek Harness terminal uses a tool. The Harness sends every call as
// { title: <tool name>, kind: 'other', rawInput }, so the summary has to come from the arguments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { describeTool, patchFiles } from '../cli/harness-tools.js';

const root = '/work/app';
const toRel = (p) => {
  const rel = path.relative(root, path.resolve(root, p));
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
};
const call = (title, rawInput) => describeTool({ title, kind: 'other', rawInput }, toRel);

test('commands show the command, not "bash"', () => {
  assert.deepEqual(call('bash', { command: 'git status\n  --short', description: 'Show status' }), {
    kind: 'command',
    summary: '$ git status --short',
    files: [],
  });
});

test('reads, searches and the web say what they looked at', () => {
  assert.equal(call('read', { file_path: '/work/app/README.md' }).summary, 'Read README.md');
  assert.equal(call('grep', { pattern: 'TODO', paths: ['src'] }).summary, 'Searched "TODO" in src');
  assert.equal(call('glob', { pattern: '**/*.js', path: '/work/app/cli' }).summary, 'Listed **/*.js in cli');
  assert.equal(call('web_fetch', { url: 'https://example.com/a' }).summary, 'Fetched https://example.com/a');
  const search = call('web_search', { queries: ['deepseek acp', 'codev'] });
  assert.equal(search.kind, 'web');
  assert.equal(search.summary, 'Searched the web: deepseek acp · codev');
});

test('edits are edits, with the project files they touch', () => {
  assert.deepEqual(call('edit', { file_path: '/work/app/cli/hook.js', old_string: 'a', new_string: 'b' }), {
    kind: 'edit',
    summary: 'Edited cli/hook.js',
    files: ['cli/hook.js'],
  });
  assert.deepEqual(call('write', { file_path: 'notes.md', content: '' }).files, ['notes.md']);
  // A file outside the project is named but not tracked.
  const outside = call('write', { file_path: '/tmp/x.txt', content: 'x' });
  assert.equal(outside.summary, 'Wrote /tmp/x.txt');
  assert.deepEqual(outside.files, []);
  assert.equal(call('str_replace_editor', { command: 'view', path: 'a.js' }).kind, 'read');
  assert.equal(call('str_replace_editor', { command: 'str_replace', path: 'a.js', old_str: 'x', new_str: 'y' }).summary, 'Edited a.js');
});

test('apply_patch lists every file in the patch', () => {
  const input = [
    '*** Begin Patch',
    '*** Update File: src/a.js',
    '*** Move to: src/b.js',
    '@@',
    '-x',
    '+y',
    '*** Add File: src/c.js',
    '+hi',
    '*** Delete File: old.js',
    '*** End Patch',
  ].join('\n');
  assert.deepEqual(patchFiles(input), ['src/a.js', 'src/b.js', 'src/c.js', 'old.js']);
  assert.deepEqual(call('apply_patch', { input }), {
    kind: 'edit',
    summary: 'Edited src/a.js, src/b.js, src/c.js, old.js',
    files: ['src/a.js', 'src/b.js', 'src/c.js', 'old.js'],
  });
});

test('other tools show their main argument; standard ACP kinds still work', () => {
  assert.equal(call('subagent', { description: 'Review the tests' }).summary, 'subagent: Review the tests');
  assert.equal(call('todo', {}).summary, 'todo');
  assert.equal(describeTool({}, toRel), null);
  const acp = describeTool({ title: 'Edit file', kind: 'edit', locations: [{ path: '/work/app/x.js' }] }, toRel);
  assert.deepEqual(acp, { kind: 'edit', summary: 'Edited x.js', files: ['x.js'] });
});
