// Publishes a person's CoDev log (codev/history/<name>.md) to the team's git remote on its own:
// a commit with only that file, then a push. So teammates see who is working, and the log, without
// anyone committing by hand.
// Safe by design: it never commits other files, never pushes the person's own unpushed commits,
// never pulls or rebases, and gives up quietly when anything is off (no repo, no upstream, behind…).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const git = (root, args, timeout = 20_000) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
const tryGit = (root, args, timeout) => {
  try {
    return git(root, args, timeout);
  } catch {
    return null;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const autoPushEnabled = (cfg) => cfg.autoPush !== false && process.env.CODEV_AUTOPUSH !== '0';

/** Appends a line-level entry to the log, creating the file if needed. */
export function appendLog(root, file, text) {
  const abs = path.join(root, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const sep = !current ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  fs.appendFileSync(abs, `${sep}${text.trim()}\n`);
}

export const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * Commits `files` (only them) and pushes to the branch's upstream. Returns what happened, for tests:
 * 'no-repo' | 'nothing' | 'committed' (not pushed) | 'pushed' | 'error'.
 */
export async function publishLog(root, files, message) {
  if (tryGit(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return 'no-repo';
  const paths = files.filter((f) => fs.existsSync(path.join(root, f)));
  if (!paths.length) return 'nothing';
  // Another AI of the same project may be committing at the same moment: retry on the index lock.
  let committed = false;
  for (let i = 0; i < 5 && !committed; i++) {
    try {
      git(root, ['add', '--', ...paths]);
      if (!tryGit(root, ['diff', '--cached', '--name-only', '--', ...paths])) break; // nothing new
      git(root, ['commit', '--no-verify', '--quiet', '-m', message, '--only', '--', ...paths]);
      committed = true;
    } catch {
      await sleep(400 + Math.random() * 800);
    }
  }

  const target = upstreamOf(root);
  if (!target) return committed ? 'committed' : 'nothing';
  const { upstream, remote, branch } = target;
  tryGit(root, ['fetch', '--quiet', remote, branch], 30_000); // a teammate may have pushed meanwhile
  const pending = tryGit(root, ['diff', '--name-only', `${upstream}...HEAD`]);
  if (pending === null || !pending) return committed ? 'committed' : 'nothing';
  const changed = pending.split('\n').filter(Boolean);
  const logs = changed.filter(isCodev);
  if (!logs.length) return committed ? 'committed' : 'nothing';
  // Only CoDev files pending and a fast-forward: push HEAD. Otherwise (the person has unpushed work
  // of their own, or the remote moved on) never push their commits nor pull or rebase their branch:
  // build one commit on top of the remote with only our version of the logs, and push that. So the
  // team always sees who opened a session, even while someone has work not ready to publish.
  const ff = changed.every(isCodev) && tryGit(root, ['merge-base', '--is-ancestor', upstream, 'HEAD']) !== null;
  const sha = ff ? 'HEAD' : logsOnTop(root, upstream, logs, message);
  if (!sha) return 'error';
  const ok = tryGit(root, ['push', '--no-verify', '--quiet', remote, `${sha}:${branch}`], 30_000);
  return ok === null ? 'error' : 'pushed';
}

const isCodev = (f) => /^codev\/history\/[^/]+\.md$/.test(f) || f === 'codev/README.md';

/** The remote branch to publish to: the upstream, or else <remote>/<current branch> if it exists. */
function upstreamOf(root) {
  const up = tryGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (up && up.includes('/')) {
    const [remote, ...rest] = up.split('/');
    return { upstream: up, remote, branch: rest.join('/') };
  }
  // No upstream set (a branch created locally, a clone made by hand…): try the same branch on a remote.
  const branch = tryGit(root, ['symbolic-ref', '--short', 'HEAD']);
  const remotes = (tryGit(root, ['remote']) || '').split('\n').filter(Boolean);
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  if (!branch || !remote) return null;
  tryGit(root, ['fetch', '--quiet', remote, branch], 30_000);
  if (tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`]) === null) return null;
  return { upstream: `${remote}/${branch}`, remote, branch };
}

/** A commit whose parent is `upstream` and whose logs are HEAD's version of `files`. Its sha, or null. */
function logsOnTop(root, upstream, files, message) {
  const index = path.join(tryGit(root, ['rev-parse', '--absolute-git-dir']) || root, `codev-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: index, GIT_TERMINAL_PROMPT: '0' };
  const run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env, timeout: 20_000 }).trim();
  try {
    run(['read-tree', upstream]);
    for (const f of files) {
      const blob = tryGit(root, ['rev-parse', '--verify', '--quiet', `HEAD:${f}`]);
      if (blob) run(['update-index', '--add', '--cacheinfo', `100644,${blob},${f}`]);
      else run(['update-index', '--force-remove', '--', f]);
    }
    return run(['commit-tree', run(['write-tree']), '-p', upstream, '-m', message]);
  } catch {
    return null;
  } finally {
    fs.rmSync(index, { force: true });
  }
}

/** Runs publishLog in a detached process, so the hook returns at once and a slow push blocks no one. */
export function publishLogInBackground(root, files, message) {
  try {
    // Inside the packaged app the hook runs on Electron as Node; an AppImage's binary lives on a
    // mount that goes away with it, so run the AppImage file then. Plain Node: itself. (APPIMAGE is
    // also set in every terminal CoDev opens, so it alone does not mean we run inside it.)
    const exe = process.versions.electron && process.env.APPIMAGE ? process.env.APPIMAGE : process.execPath;
    const child = spawn(exe, [process.argv[1], 'publish-log', '--root', root, '--message', message, ...files.flatMap((f) => ['--file', f])], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
      windowsHide: true,
    });
    child.unref();
  } catch {}
}
