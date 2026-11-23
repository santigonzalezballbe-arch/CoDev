// Publishing a person's CoDev log to the git remote on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { publishLog, appendLog } from '../cli/gitsync.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const LOG = 'codev/history/ana.md';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-sync-'));
  const remote = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  git(dir, 'init', '--bare', '-b', 'main', remote);
  git(dir, 'clone', remote, work);
  git(work, 'config', 'user.name', 'Ana');
  git(work, 'config', 'user.email', 'ana@example.com');
  fs.writeFileSync(path.join(work, 'app.js'), 'v1\n');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'init');
  git(work, 'push', '-u', 'origin', 'main');
  return { remote, work };
}

test('the log alone is committed and pushed; the rest of the work stays untouched', async () => {
  const { remote, work } = setup();
  fs.writeFileSync(path.join(work, 'app.js'), 'v2 work in progress\n');
  fs.writeFileSync(path.join(work, 'staged.js'), 'x\n');
  git(work, 'add', 'staged.js');
  appendLog(work, LOG, '## 2026-11-23 10:00 — Ana opened a session');

  assert.equal(await publishLog(work, [LOG, 'codev/README.md'], 'codev: Ana opened a session'), 'pushed');
  assert.equal(git(remote, 'log', '-1', '--format=%s', 'main'), 'codev: Ana opened a session');
  assert.equal(git(remote, 'show', '--name-only', '--format=', 'main'), LOG);
  assert.match(git(work, 'status', '--porcelain'), /^ ?M app\.js$/m, 'unstaged work is still there');
  assert.match(git(work, 'status', '--porcelain'), /^A  staged\.js$/m, 'staged work stays staged');

  assert.equal(await publishLog(work, [LOG], 'again'), 'nothing', 'nothing new: no empty commit');
});

test("the person's own unpushed commits are never pushed for them", async () => {
  const { remote, work } = setup();
  fs.writeFileSync(path.join(work, 'app.js'), 'v2\n');
  git(work, 'commit', '-am', 'my work, not ready');
  appendLog(work, LOG, '## entry');

  assert.equal(await publishLog(work, [LOG], 'codev: log'), 'committed');
  assert.equal(git(remote, 'log', '-1', '--format=%s', 'main'), 'init', 'the remote did not move');
});

test('logs still reach the remote after it moved on, and earlier unpushed logs go with them', async () => {
  const { remote, work } = setup();
  // A teammate pushes in between.
  const other = path.join(path.dirname(remote), 'other');
  git(path.dirname(remote), 'clone', remote, other);
  git(other, 'config', 'user.name', 'Pau');
  git(other, 'config', 'user.email', 'pau@example.com');
  appendLog(other, 'codev/history/pau.md', '## Pau <!-- codev:open ts=1 -->');
  git(other, 'add', '.');
  git(other, 'commit', '-m', 'pau');
  git(other, 'push');
  // Here: earlier log commits that never got pushed, then a new one.
  appendLog(work, 'codev/history/ana-ai0.md', '<!-- codev:open ts=2 -->');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'old');
  appendLog(work, 'codev/history/ana-ai0.md', '<!-- codev:close ts=3 -->');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'old close');
  appendLog(work, LOG, '## entry');

  assert.equal(await publishLog(work, [LOG], 'codev: Ana'), 'pushed');
  assert.match(git(remote, 'show', 'main:codev/history/ana-ai0.md'), /codev:close/, 'the stuck close is published');
  assert.match(git(remote, 'show', 'main:codev/history/pau.md'), /Pau/, "the teammate's log is kept");
  assert.match(git(remote, 'show', `main:${LOG}`), /entry/);
  assert.equal(git(remote, 'show', 'main:app.js'), 'v1');
});

test('outside a git repository it does nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-norepo-'));
  appendLog(dir, LOG, '## entry');
  assert.equal(await publishLog(dir, [LOG], 'x'), 'no-repo');
});
