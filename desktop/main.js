// Desktop app main process: window, real terminals (PTY) and an optional embedded server.
import { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, shell } from 'electron';
import pty from '@lydell/node-pty';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { startServer } from '../server/server.js';
import { setupProject } from '../cli/init.js';
import { ensureCloudflared } from './cloudflared.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ptys = new Map(); // id -> process
let win;
let hostedServer = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0e1016',
    title: 'CoDev',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(DIR, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(path.join(DIR, 'index.html'));
  // F12 opens DevTools (there is no menu, so Ctrl+C/Ctrl+V go straight to the terminal).
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  // External links open in the browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function lanAddresses(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
  }
  return out;
}

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose the project folder' });
  return r.canceled ? null : r.filePaths[0];
});

let roomKey = null;
let tunnel = null; // { proc, url }

ipcMain.handle('host-server', async (_e, requested = 4321) => {
  const first = Number(process.env.CODEV_PORT) || requested;
  if (!hostedServer) {
    // Every room this app hosts is locked with a random key: nobody sees anything without the invite.
    roomKey = crypto.randomBytes(18).toString('base64url');
    // Use the first free port from the requested one (an old `codev server` may be holding 4321).
    for (let port = first; port < first + 10 && !hostedServer; port++) {
      try {
        hostedServer = await startServer({ port, host: '0.0.0.0', key: roomKey, guests: guestHooks });
      } catch (err) {
        if (err.code !== 'EADDRINUSE') throw err;
      }
    }
    if (!hostedServer) throw new Error(`Ports ${first}-${first + 9} are all in use.`);
  }
  const port = hostedServer.address().port;
  return { url: `http://localhost:${port}`, lan: lanAddresses(port), key: roomKey };
});

/* ---------- Sharing over the internet (Cloudflare quick tunnel) ---------- */
ipcMain.handle('share-start', async (e) => {
  if (!hostedServer) throw new Error('Create a room first.');
  if (tunnel) return { url: tunnel.url };
  const PATH = await getUserPath();
  const port = hostedServer.address().port;
  // Use the user's cloudflared if they have one; otherwise download it once (version and SHA-256 pinned).
  const bin = await ensureCloudflared({
    // CODEV_IGNORE_SYSTEM_CLOUDFLARED=1 tests the first-time download on a machine that already has it.
    PATH: process.env.CODEV_IGNORE_SYSTEM_CLOUDFLARED ? '' : PATH,
    resourcesDir: app.isPackaged ? process.resourcesPath : null,
    dataDir: app.getPath('userData'),
    onProgress: (p) => !e.sender.isDestroyed() && e.sender.send('share-progress', p),
  });
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
      env: { ...process.env, PATH },
    });
    let log = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Cloudflare did not answer in 40 seconds. Check your internet connection and try again.'));
    }, 40_000);
    const onData = (chunk) => {
      log += chunk;
      const m = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !tunnel) {
        clearTimeout(timer);
        tunnel = { proc, url: m[0] };
        // Cloudflare prints the address a few seconds before it resolves in DNS:
        // only report the room as online once the public address really answers.
        waitUntilReachable(m[0]).then(
          () => resolve({ url: m[0] }),
          (err) => {
            proc.kill();
            reject(err);
          }
        );
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          err.code === 'ENOENT' || err.code === 'EACCES'
            ? `Could not start cloudflared (${bin}). Delete it and try again, or install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`
            : err.message
        )
      );
    });
    proc.on('exit', () => {
      clearTimeout(timer);
      if (tunnel?.proc === proc) tunnel = null;
    });
  });
});

async function waitUntilReachable(url, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('The online link did not come up in time. Try again in a moment.');
}

ipcMain.handle('share-stop', () => {
  tunnel?.proc.kill();
  tunnel = null;
  return true;
});

/* ---------- GitHub ---------- */
const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 10_000_000, ...opts }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stderr })) : resolve(stdout)
    );
  });

const WORKSPACE = process.env.CODEV_WORKSPACE || path.join(os.homedir(), 'CoDev');

/** Accepts "owner/repo", an https URL or git@github.com:... and returns "owner/repo". */
function parseRepo(input) {
  const m = String(input || '').trim().match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function repoDest(full) {
  const [owner, name] = full.split('/');
  const plain = path.join(WORKSPACE, name);
  if (!fs.existsSync(plain)) return plain;
  try {
    const cfg = fs.readFileSync(path.join(plain, '.git', 'config'), 'utf8');
    if (cfg.toLowerCase().includes(`${full.toLowerCase()}`)) return plain;
  } catch {}
  return path.join(WORKSPACE, `${owner}-${name}`);
}

ipcMain.handle('gh-repos', async () => {
  const PATH = await getUserPath();
  try {
    const login = (await run('gh', ['api', 'user', '--jq', '.login'], { env: { ...process.env, PATH } })).trim();
    const list = JSON.parse(
      await run('gh', ['repo', 'list', '--limit', '100', '--json', 'nameWithOwner,description,isPrivate,updatedAt'], { env: { ...process.env, PATH } })
    );
    return { ok: true, login, repos: list };
  } catch {
    return { ok: false, repos: [] };
  }
});

ipcMain.handle('repo-status', (_e, input) => {
  const full = parseRepo(input);
  if (!full) return { valid: false };
  const dest = repoDest(full);
  return { valid: true, full, dest: dest.replace(os.homedir(), '~'), exists: fs.existsSync(path.join(dest, '.git')) };
});

ipcMain.handle('prepare-repo', async (_e, input) => {
  const full = parseRepo(input);
  if (!full) throw new Error('Write the repository as owner/name or paste its GitHub URL.');
  const dest = repoDest(full);
  if (fs.existsSync(path.join(dest, '.git'))) return { root: dest, full, cloned: false };
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const env = { ...process.env, PATH: await getUserPath(), GIT_TERMINAL_PROMPT: '0' };
  try {
    // With gh, private repositories can be cloned too, using the user's session.
    await run('gh', ['repo', 'clone', full, dest], { env, timeout: 300_000 });
  } catch {
    try {
      await run('git', ['clone', `https://github.com/${full}.git`, dest], { env, timeout: 300_000 });
    } catch (err) {
      throw new Error(`Could not clone ${full}. Is it private, or does it not exist? (${String(err.stderr || err.message).trim().split('\n').pop()})`);
    }
  }
  return { root: dest, full, cloned: true };
});

ipcMain.handle('setup-project', (_e, opts) => setupProject(opts));
ipcMain.handle('copy', (_e, text) => clipboard.writeText(text));

// The user's shell PATH (nvm, ~/.local/bin...). When the app is opened from a menu, the inherited PATH is minimal.
let userPath;
function getUserPath() {
  userPath ||= new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/bash';
    execFile(shell, ['-ilc', 'printf "__CODEV_PATH__%s" "$PATH"'], { timeout: 8000 }, (_err, stdout = '') => {
      const i = stdout.lastIndexOf('__CODEV_PATH__');
      resolve(i >= 0 ? stdout.slice(i + 14).trim() : process.env.PATH);
    });
  });
  return userPath;
}

// If the app was opened from inside a Claude Code session, don't pass that session's markers on
// to the new Claude Code instances (otherwise they think they are subsessions and turn off history).
const SESSION_VARS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(CHILD_|SESSION_|MESSAGING_|ENTRYPOINT|EXECPATH|SSE_PORT))/;
function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !SESSION_VARS.test(k)));
}

ipcMain.handle('pty-create', async (e, { id, cwd, cols, rows, env, command }) => {
  const PATH = await getUserPath();
  let file = process.env.SHELL || '/bin/bash';
  if (command) {
    file = PATH.split(':').map((d) => path.join(d, command)).find((f) => fs.existsSync(f));
    if (!file) throw new Error(`Cannot find \`${command}\` in PATH. Install Claude Code: npm i -g @anthropic-ai/claude-code`);
  }
  const proc = pty.spawn(file, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...cleanEnv(), PATH, ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'CoDev' },
  });
  ptys.set(id, proc);
  const sender = e.sender;
  proc.onData((data) => !sender.isDestroyed() && sender.send('pty-data', id, data));
  proc.onExit(({ exitCode }) => {
    ptys.delete(id);
    if (!sender.isDestroyed()) sender.send('pty-exit', id, exitCode);
  });
  return true;
});

ipcMain.on('pty-write', (_e, id, data) => ptys.get(id)?.write(data));
ipcMain.on('pty-resize', (_e, id, cols, rows) => {
  try {
    ptys.get(id)?.resize(cols, rows);
  } catch {}
});
ipcMain.on('pty-kill', (_e, id) => {
  ptys.get(id)?.kill();
  ptys.delete(id);
});

/* ---------- Guest terminals: a browser visitor's own Claude Code, on this computer ---------- */
// Someone watching from a browser cannot run Claude Code there, so they can ask the host for one.
// It only starts if the host clicks Allow. It runs in its own git worktree (branch codev/<name>) and
// with a throwaway Claude config folder, so the guest signs in with their own Claude account and
// nothing of theirs stays here when they close it.
let hostCtx = null; // { root, room, name } of the room this app hosts
const guests = new Map(); // id -> { proc, configDir, member }
const guestAsks = new Map(); // request id -> resolve(allowed)
let askSeq = 0;

ipcMain.handle('host-context', (_e, ctx) => {
  hostCtx = ctx;
  return true;
});
ipcMain.handle('guest-decision', (_e, reqId, allow) => {
  guestAsks.get(reqId)?.(!!allow);
  guestAsks.delete(reqId);
  return true;
});
ipcMain.handle('guest-stop', (_e, id) => {
  guestHooks.close(id);
  return true;
});

const notifyGuests = () => win && !win.isDestroyed() && win.webContents.send('guests', [...guests.keys()]);
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'guest';

async function isGitRepo(root) {
  try {
    return (await run('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

/** The guest's own copy of the project: a git worktree on branch codev/<name>, or the same folder. */
async function guestWorkspace(member) {
  const root = hostCtx.root;
  if (!(await isGitRepo(root))) return { dir: root, branch: null };
  const branch = `codev/${slug(member)}`;
  const dir = path.join(WORKSPACE, 'worktrees', `${path.basename(root)}-${slug(member)}`);
  if (fs.existsSync(path.join(dir, '.git'))) return { dir, branch };
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  let exists = true;
  try {
    await run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  } catch {
    exists = false;
  }
  await run('git', ['-C', root, 'worktree', 'add', ...(exists ? [dir, branch] : ['-b', branch, dir])]);
  return { dir, branch };
}

function askHost(req, plan) {
  if (!win || win.isDestroyed()) return Promise.resolve(false);
  const reqId = ++askSeq;
  win.webContents.send('guest-request', { reqId, member: req.member, ...plan });
  if (win.isMinimized()) win.restore();
  win.flashFrame(true);
  return new Promise((resolve) => {
    guestAsks.set(reqId, resolve);
    setTimeout(() => {
      if (guestAsks.has(reqId)) {
        guestAsks.delete(reqId);
        win?.webContents.send('guest-request-expired', reqId);
        resolve(false);
      }
    }, 120_000);
  });
}

const guestHooks = {
  async open(req, reply) {
    const deny = (reason) => reply({ t: 'guest-denied', id: req.id, reason });
    if (!hostCtx || req.room !== hostCtx.room) return deny('The host is not in this room any more.');
    if (guests.has(req.id)) return deny('That terminal is already open.');
    const sameFolder = !(await isGitRepo(hostCtx.root));
    const plan = { sameFolder, branch: sameFolder ? null : `codev/${slug(req.member)}`, project: path.basename(hostCtx.root) };
    if (!(await askHost(req, plan))) return deny(`${hostCtx.name} did not let you in this time.`);
    try {
      const { dir } = await guestWorkspace(req.member);
      const configDir = fs.mkdtempSync(path.join(app.getPath('userData'), 'guest-'));
      const PATH = await getUserPath();
      const claude = PATH.split(':').map((d) => path.join(d, 'claude')).find((f) => fs.existsSync(f));
      if (!claude) return deny(`Claude Code is not installed on ${hostCtx.name}'s computer.`);
      const port = hostedServer.address().port;
      const codevEnv = {
        CODEV_SERVER: `http://localhost:${port}`,
        CODEV_ROOM: hostCtx.room,
        CODEV_NAME: req.member,
        CODEV_ROOT: dir,
        CODEV_KEY: roomKey,
      };
      const env = { ...cleanEnv(), PATH, ...codevEnv, CLAUDE_CONFIG_DIR: configDir };
      await setupProject({ root: dir, server: codevEnv.CODEV_SERVER, room: hostCtx.room, name: req.member, key: roomKey, env });
      const proc = pty.spawn(claude, [], {
        name: 'xterm-256color',
        cols: req.cols,
        rows: req.rows,
        cwd: dir,
        env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'CoDev' },
      });
      guests.set(req.id, { proc, configDir, member: req.member });
      proc.onData((d) => reply({ t: 'guest-data', id: req.id, d }));
      proc.onExit(({ exitCode }) => {
        reply({ t: 'guest-exit', id: req.id, code: exitCode });
        guestHooks.close(req.id);
      });
      reply({ t: 'guest-ready', id: req.id });
      notifyGuests();
    } catch (err) {
      deny(`Could not start your terminal: ${String(err.stderr || err.message).trim().split('\n').pop()}`);
    }
  },
  input: (id, d) => guests.get(id)?.proc.write(d),
  resize: (id, cols, rows) => {
    try {
      if (cols > 0 && rows > 0) guests.get(id)?.proc.resize(cols, rows);
    } catch {}
  },
  close(id) {
    const g = guests.get(id);
    if (!g) return;
    guests.delete(id);
    try {
      g.proc.kill();
    } catch {}
    // The guest's Claude sign-in lived only in this folder: remove it.
    fs.rmSync(g.configDir, { recursive: true, force: true });
    notifyGuests();
  },
};

/* ---------- Invite links: codev://join?server=…&room=…&key=… ---------- */
const APP_DIR = path.join(DIR, '..');
let pendingLink = null;

function parseAppLink(arg) {
  if (typeof arg !== 'string' || !arg.startsWith('codev://')) return null;
  try {
    const u = new URL(arg);
    const server = u.searchParams.get('server') || '';
    if (!/^https?:\/\//.test(server)) return null;
    return { server, room: u.searchParams.get('room') || '', key: u.searchParams.get('key') || '' };
  } catch {
    return null;
  }
}

function deliverLink(link) {
  if (!link) return;
  if (win && !win.webContents.isLoading()) {
    win.webContents.send('deep-link', link);
    if (win.isMinimized()) win.restore();
    win.focus();
  } else {
    pendingLink = link;
  }
}
ipcMain.handle('pending-link', () => {
  const l = pendingLink;
  pendingLink = null;
  return l;
});

/**
 * Makes the system open codev:// links with this app. Packaged builds register through their
 * installer; while running from source on Linux we write a small .desktop file for the scheme.
 */
function registerProtocol() {
  if (process.platform === 'linux' && !app.isPackaged) {
    try {
      const dir = path.join(os.homedir(), '.local', 'share', 'applications');
      const file = path.join(dir, 'codev-dev.desktop');
      const entry = [
        '[Desktop Entry]',
        'Type=Application',
        'Name=CoDev',
        'Comment=Code as a team with AI without stepping on each other',
        `Exec="${process.execPath}" "${APP_DIR}" %u`,
        'Terminal=false',
        'NoDisplay=true',
        'MimeType=x-scheme-handler/codev;',
        '',
      ].join('\n');
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== entry) fs.writeFileSync(file, entry);
      execFile('xdg-mime', ['default', 'codev-dev.desktop', 'x-scheme-handler/codev'], () => {});
    } catch {}
  } else if (app.isPackaged) {
    app.setAsDefaultProtocolClient('codev');
  } else {
    app.setAsDefaultProtocolClient('codev', process.execPath, [APP_DIR]);
  }
}

// One window per profile: a codev:// link opened while CoDev runs goes to the open window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => deliverLink(argv.map(parseAppLink).find(Boolean)));
  app.on('open-url', (e, url) => {
    e.preventDefault();
    deliverLink(parseAppLink(url));
  });
  pendingLink = process.argv.map(parseAppLink).find(Boolean) || null;

  app.whenReady().then(() => {
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    registerProtocol();
    createWindow();
  });
}
app.on('window-all-closed', () => {
  for (const p of ptys.values()) p.kill();
  tunnel?.proc.kill();
  for (const id of [...guests.keys()]) guestHooks.close(id);
  hostedServer?.close();
  app.quit();
});
