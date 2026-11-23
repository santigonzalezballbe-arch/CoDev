// The sessions open on this computer, so a session whose AI died without writing its "closed" line
// (its window was closed abruptly, the app or the computer was killed) gets closed anyway.
// The SessionStart hook registers the AI's process here; the SessionEnd hook removes it. Whoever
// looks next (a new session's hook, or the CoDev app every minute) finds the dead processes and
// writes the "closed" line for them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { lastSession, closeMarker } from '../desktop/presence.js';
import { appendLog, stamp } from './gitsync.js';

export const sessionsDir = () => process.env.CODEV_SESSIONS_DIR || path.join(os.homedir(), '.codev', 'sessions');

/** Whether a process is still running (EPERM: it runs, as another user). */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const SHELLS = /^(sh|bash|dash|zsh|fish|ksh|cmd|cmd\.exe|powershell|powershell\.exe|pwsh|pwsh\.exe|bash\.exe|sh\.exe|env|timeout)$/i;

/** [pid, parentPid, name] of every process (Windows) or of one (elsewhere). */
function parentOf(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
      return { ppid: Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]), name };
    }
    const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).trim();
    const [, ppid, name] = out.match(/^(\d+)\s+(.*)$/) || [];
    return ppid ? { ppid: Number(ppid), name: path.basename(name) } : null;
  } catch {
    return null;
  }
}

function windowsTable() {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true }
    );
    const t = new Map();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^(\d+) (\d+) (.*)$/);
      if (m) t.set(Number(m[1]), { ppid: Number(m[2]), name: m[3].trim() });
    }
    return t;
  } catch {
    return null;
  }
}

/**
 * The AI's process that ran this hook: the first ancestor that is not a shell (hooks run through
 * `sh -c …` or similar). Null when it cannot be told.
 */
export function agentPid(start = process.ppid) {
  const table = process.platform === 'win32' ? windowsTable() : null;
  if (process.platform === 'win32' && !table) return null;
  const info = (pid) => (table ? table.get(pid) || null : parentOf(pid));
  let pid = start;
  for (let i = 0; i < 6 && pid > 1; i++) {
    const p = info(pid);
    if (!p) return null;
    if (!SHELLS.test(p.name)) return pid;
    pid = p.ppid;
  }
  return null;
}

const fileOf = (pid) => path.join(sessionsDir(), `${pid}.json`);

/** Remembers that the AI process `pid` has a session open in `root`'s log `file` since `since`. */
export function registerSession({ pid, root, name, file, since }) {
  if (!pid) return;
  try {
    fs.mkdirSync(sessionsDir(), { recursive: true });
    fs.writeFileSync(fileOf(pid), JSON.stringify({ pid, root, name, file, since }));
  } catch {}
}

export function unregisterSession(pid) {
  try {
    if (pid) fs.rmSync(fileOf(pid), { force: true });
  } catch {}
}

/** Sessions whose process has died, now forgotten. Those still running are kept. */
export function deadSessions(isAlive = alive) {
  let names = [];
  try {
    names = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const all = [];
  for (const f of names) {
    try {
      all.push(JSON.parse(fs.readFileSync(path.join(sessionsDir(), f), 'utf8')));
    } catch {
      fs.rmSync(path.join(sessionsDir(), f), { force: true });
    }
  }
  const living = all.filter((s) => isAlive(s.pid));
  const dead = all.filter((s) => !living.includes(s));
  for (const s of dead) unregisterSession(s.pid);
  // Another AI of the same person on the same project still works: that log is rightly open.
  return dead.filter((s) => !living.some((o) => o.root === s.root && o.file === s.file));
}

/**
 * Writes the "closed" line for each dead session whose log still says "open" for it. Returns the
 * ones written, [{ root, name, file }], for the caller to publish.
 */
export function closeDeadSessions(isAlive = alive, now = Date.now()) {
  const closed = [];
  for (const s of deadSessions(isAlive)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(s.root, '.codev.json'), 'utf8'));
      if (cfg.autoPush === false || process.env.CODEV_AUTOPUSH === '0') continue;
      const abs = path.join(s.root, s.file);
      // Only when the log's last line is still this very session's "open" (not a later one, which
      // may come from another computer).
      const last = lastSession(fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '');
      if (!last || last.state !== 'open' || last.ts !== s.since) continue;
      appendLog(s.root, s.file, `## ${stamp(new Date(now))} — ${s.name} closed the session\n${closeMarker({ ts: now })}`);
      closed.push(s);
    } catch {}
  }
  return closed;
}
