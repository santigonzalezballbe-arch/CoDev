// The local history file: <project>/.codev/history.jsonl
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { History } from '../desktop/history.js';

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codev-hist-')), '.codev', 'history.jsonl');

test('events are kept once, with their prompt, diff and files', () => {
  const f = file();
  const h = new History(f);
  const prompt = { id: 1, ts: 1000, member: 'Ana', kind: 'prompt', summary: 'Build the login page' };
  const edit = { id: 2, ts: 2000, member: 'Ana', kind: 'edit', summary: 'Edited src/auth.js', files: ['src/auth.js'], diff: { old: 'a', new: 'b' } };
  assert.equal(h.append([prompt, edit], 'demo'), 2);
  assert.equal(h.append([prompt, edit], 'demo'), 0, 'a reconnect sends the same events again: no duplicates');

  const rows = new History(f).read();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { room: 'demo', ts: 1000, member: 'Ana', kind: 'prompt', summary: 'Build the login page' });
  assert.deepEqual(rows[1].diff, { old: 'a', new: 'b' });
  assert.equal(rows[1].id, undefined, 'server-local ids are not stored');
});

test('it survives a half-written line and keeps working after a restart', () => {
  const f = file();
  new History(f).append([{ ts: 1, member: 'Marc', kind: 'note', summary: 'hi' }], 'r');
  fs.appendFileSync(f, '{"ts": 2, "memb');
  const h = new History(f);
  assert.equal(h.read().length, 1);
  assert.equal(h.append([{ ts: 1, member: 'Marc', kind: 'note', summary: 'hi' }], 'r'), 0, 'already stored');
  assert.equal(h.append([{ ts: 3, member: 'Marc', kind: 'command', summary: '$ npm test' }], 'r'), 1);
  assert.deepEqual(new History(f).read().map((r) => r.ts), [1, 3], 'the new event is not lost after the broken line');
});
