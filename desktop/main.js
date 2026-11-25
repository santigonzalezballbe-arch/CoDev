// Desktop app main process: window, real terminals (PTY) and an optional embedded server.
import { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, shell, safeStorage, powerSaveBlocker } from 'electron';
import pty from '@lydell/node-pty';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { startServer } from '../server/server.js';
import { setupProject, useRunner, getRunner, installCodexHooks } from '../cli/init.js';
import { projectRules, cliCommand } from '../cli/config.js';
import { AGENTS, spawnSpec, harnessPatch, ollamaModels, apiModels } from './agents.js';
import { ensureCloudflared } from './cloudflared.js';
import { History } from './history.js';
import { openSessions, needsClose, closeMarker } from './presence.js';
import { appendLog, stamp } from '../cli/gitsync.js';
import { historyPath } from '../cli/config.js';
import { closeDeadSessions } from '../cli/sessions.js';
import {
  fingerprint,
  sameProject,
  projectIdentity,
  startLan,
  publishGithubRoom,
  unpublishGithubRoom,
  listGithubRooms,
  roomRef,
  roomMessage,
} from './discovery.js';
import { checkLatest, installKind, install as installUpdate, RELEASES_PAGE } from './updater.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ptys = new Map(); // "<window>:<id>" -> process
let hostedServer = null;

/*
 * One window per project: every window has its own room, terminals, history and guests, so several
 * projects can be worked on at once. The embedded server, the online link (tunnel) and the network
 * listener are shared: one server hosts any number of rooms.
 */
const contexts = new Map(); // webContents id -> window context
function ctxOf(sender) {
  let c = contexts.get(sender.id);
  if (!c) {
    c = {
      id: sender.id,
      sender,
      win: BrowserWindow.fromWebContents(sender),
      history: null,
      hostCtx: null, // { root, room, name } of the room this window hosts
      hostIdentity: null, // { rootCommit, repo, fp } of that project
      ghPublished: null, // { repo, name } while that room is written in the repository
      ghTimer: null,
      sharing: false, // this window asked for the online link
      awake: false,
    };
    contexts.set(sender.id, c);
  }
  return c;
}
const ptyKey = (sender, id) => `${sender.id}:${id}`;
const leaving = new Set(); // windows closing: their rooms are being left (the quit waits for them)
const allWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
const mainWindow = () => BrowserWindow.getFocusedWindow() || allWindows()[0] || null;
const sendAll = (channel, ...args) => allWindows().forEach((w) => w.webContents.send(channel, ...args));
const ctxByRoom = (room) => [...contexts.values()].find((c) => c.hostCtx && c.hostCtx.room === room) || null;

// Linux desktops may offer more than one secret store (KWallet, gnome-keyring). If the one Electron
// picks is not running, safeStorage cannot save the DeepSeek key. CODEV_PASSWORD_STORE chooses it.
if (process.platform === 'linux' && process.env.CODEV_PASSWORD_STORE) {
  app.commandLine.appendSwitch('password-store', process.env.CODEV_PASSWORD_STORE);
}

function createWindow() {
  const prev = mainWindow();
  const win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 480,
    minHeight: 420,
    backgroundColor: '#0e1016',
    title: 'CoDev',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(DIR, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  // A new window opens a little below and to the right of the current one, so both are visible.
  if (prev) {
    const [x, y] = prev.getPosition();
    win.setPosition(x + 36, y + 36);
  }
  win.loadFile(path.join(DIR, 'index.html'));
  const wc = win.webContents;
  const wcId = wc.id;
  // F12 opens DevTools; Ctrl+Shift+N (Cmd+Shift+N) opens a window for another project. There is no
  // menu, so Ctrl+C/Ctrl+V go straight to the terminal.
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') wc.toggleDevTools();
    else if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'n') {
      e.preventDefault();
      createWindow();
    }
  });
  // Closing a window leaves its room (the other windows keep theirs).
  wc.once('destroyed', () => {
    const c = contexts.get(wcId);
    contexts.delete(wcId);
    if (c) leaving.add(leaveRoom(c).catch(() => {}));
  });
  wc.once('did-finish-load', () => {
    if (update) wc.send('update-available', { version: update.version, current: currentVersion(), auto: updateKind() !== 'page' });
  });
  // External links open in the browser, not inside the app.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}
ipcMain.handle('new-window', () => {
  createWindow();
  return true;
});

function lanAddresses(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
  }
  return out;
}

ipcMain.handle('pick-folder', async (e) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openDirectory'], title: 'Choose the project folder' });
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
        hostedServer = await startServer({ port, host: '0.0.0.0', key: roomKey, guests: guestHooks, knocks: knockHooks });
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
  const ctx = ctxOf(e.sender);
  ctx.sharing = true;
  // One link for the whole app: every room of this server is reachable through it.
  if (tunnel?.ready) {
    announceRoom(ctx);
    return { url: tunnel.url };
  }
  const failed = (err) => {
    ctx.sharing = false;
    throw err;
  };
  if (tunnel?.starting) return tunnel.starting.then((r) => (announceRoom(ctx), r), failed);
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
  const starting = new Promise((resolve, reject) => {
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
      if (m && !tunnel?.url) {
        clearTimeout(timer);
        tunnel = { ...tunnel, proc, url: m[0] };
        // Cloudflare prints the address a few seconds before it resolves in DNS:
        // only report the room as online once the public address really answers.
        waitUntilReachable(m[0]).then(
          () => {
            if (tunnel?.proc === proc) tunnel.ready = true;
            resolve({ url: m[0] });
            // Teammates on the same GitHub repository can find the rooms now.
            for (const c of contexts.values()) if (c.sharing) announceRoom(c);
          },
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
      if (tunnel?.starting === starting) tunnel = null;
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
      if (tunnel?.proc === proc || tunnel?.starting === starting) tunnel = null;
      reject(new Error('The online link closed.'));
    });
  });
  tunnel = { starting };
  return starting.catch(failed);
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

ipcMain.handle('share-stop', async (e) => {
  const ctx = ctxOf(e.sender);
  ctx.sharing = false;
  stopTunnelIfUnused();
  await unannounceGithub(ctx);
  return true;
});
/** The online link is shared by every window: it closes when no window wants it any more. */
function stopTunnelIfUnused() {
  if ([...contexts.values()].some((c) => c.sharing)) return;
  tunnel?.proc?.kill();
  tunnel = null;
}

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

/* GitHub sign-in (OAuth device flow): CoDev shows a code, the browser opens github.com/login/device,
 * the user pastes it and approves. The token is saved encrypted (safeStorage) and is used to list the
 * repositories (also the ones you are a collaborator on), to clone private ones and, in your own
 * terminals, for git push / gh. Without it, an existing `gh` session is used. */
const GITHUB_CLIENT_ID = process.env.CODEV_GITHUB_CLIENT_ID || 'Ov23liG2v6tB0doYh76h';
let ghSessionToken = null; // when there is no keychain, the token lives only until CoDev closes
let ghAuthFlow = null; // { device_code, interval, expires } while the user is signing in

async function githubToken() {
  const saved = getKey('github') || ghSessionToken;
  if (saved) return { token: saved, own: true };
  try {
    const t = (await run('gh', ['auth', 'token'], { env: { ...process.env, PATH: await getUserPath(), GH_PROMPT_DISABLED: '1' } })).trim();
    if (t) return { token: t, own: false };
  } catch {}
  return null;
}

async function githubApi(pathname, token) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'CoDev' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw Object.assign(new Error(`GitHub answered ${res.status}`), { status: res.status });
  return res.json();
}

/** git reads these and sends the token to github.com only; nothing is written to .git/config. */
function gitTokenEnv(token) {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    GH_TOKEN: token,
  };
}
/** Env for the user's own terminals: only the token CoDev got from the sign-in (gh already handles its own). */
const ownGithubEnv = () => gitTokenEnv(getKey('github') || ghSessionToken);

function saveGithubToken(token) {
  if (!hasSecureStorage()) {
    ghSessionToken = token;
    return false;
  }
  const keys = readKeys();
  if (token) keys.github = safeStorage.encryptString(token).toString('base64');
  else delete keys.github;
  fs.mkdirSync(path.dirname(keysFile()), { recursive: true });
  fs.writeFileSync(keysFile(), JSON.stringify(keys), { mode: 0o600 });
  return true;
}

ipcMain.handle('gh-login-start', async () => {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: 'repo read:org' }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  const body = res && (await res.json().catch(() => null));
  if (!body?.device_code) throw new Error(`Could not reach GitHub to sign in${body?.error_description ? `: ${body.error_description}` : '.'}`);
  ghAuthFlow = { device_code: body.device_code, interval: body.interval || 5, expires: Date.now() + body.expires_in * 1000 };
  shell.openExternal(body.verification_uri);
  return { code: body.user_code, url: body.verification_uri };
});

/** Waits until the user approves in the browser (or the code expires) and returns the login. */
ipcMain.handle('gh-login-wait', async () => {
  const flow = ghAuthFlow;
  if (!flow) throw new Error('Start the sign-in again.');
  while (ghAuthFlow === flow && Date.now() < flow.expires) {
    await new Promise((r) => setTimeout(r, flow.interval * 1000));
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, device_code: flow.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
      signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    const body = res && (await res.json().catch(() => null));
    if (!body) continue;
    if (body.access_token) {
      ghAuthFlow = null;
      saveGithubToken(body.access_token);
      const user = await githubApi('/user', body.access_token).catch(() => ({}));
      return { login: user.login || null };
    }
    if (body.error === 'slow_down') flow.interval = body.interval || flow.interval + 5;
    else if (body.error === 'access_denied') throw new Error('The sign-in was cancelled on GitHub.');
    else if (body.error && body.error !== 'authorization_pending') throw new Error(body.error_description || body.error);
  }
  if (ghAuthFlow === flow) ghAuthFlow = null;
  throw new Error('The code expired. Try signing in again.');
});
ipcMain.handle('gh-login-cancel', () => {
  ghAuthFlow = null;
});
ipcMain.handle('gh-logout', () => {
  ghSessionToken = null;
  saveGithubToken(null);
});

ipcMain.handle('gh-repos', async () => {
  const auth = await githubToken();
  if (!auth) return { ok: false, repos: [] };
  try {
    const user = await githubApi('/user', auth.token);
    const repos = [];
    // Your own, the ones you were added to as a collaborator and your organizations' ones.
    for (let page = 1; page <= 5; page++) {
      const batch = await githubApi(`/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100&page=${page}`, auth.token);
      repos.push(...batch.map((r) => ({ nameWithOwner: r.full_name, description: r.description, isPrivate: r.private, updatedAt: r.updated_at })));
      if (batch.length < 100) break;
    }
    return { ok: true, login: user.login, own: auth.own, repos };
  } catch (err) {
    if (err.status === 401 && auth.own) saveGithubToken(null); // revoked on GitHub: ask to sign in again
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
  if (fs.existsSync(path.join(dest, '.git'))) {
    // Already here: bring it up to date, so the code and the teammates' logs (codev/history/) are the
    // latest. Fast-forward only: never a merge, and local work is left as it is (a pull that would
    // touch it simply fails, and you enter with what you have).
    const auth = await githubToken();
    const env = { ...process.env, PATH: await getUserPath(), GIT_TERMINAL_PROMPT: '0', ...gitTokenEnv(auth?.token) };
    const pulled = await run('git', ['-C', dest, 'pull', '--ff-only', '--quiet'], { env, timeout: 60_000 }).then(() => true, () => false);
    return { root: dest, full, cloned: false, pulled };
  }
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const auth = await githubToken();
  const existed = fs.existsSync(dest);
  const env = { ...process.env, PATH: await getUserPath(), GIT_TERMINAL_PROMPT: '0', ...gitTokenEnv(auth?.token) };
  try {
    await run('git', ['clone', `https://github.com/${full}.git`, dest], { env, timeout: 300_000 });
  } catch (err) {
    if (!existed) fs.rmSync(dest, { recursive: true, force: true }); // a failed clone leaves a half folder
    const why = String(err.stderr || err.message).trim().split('\n').pop();
    if (!auth) throw new Error(`Could not clone ${full}. If it is private, sign in with GitHub first. (${why})`);
    throw new Error(
      `Could not clone ${full} with your GitHub account. If you were added as a collaborator, accept the invitation at github.com/${full}/invitations and try again. (${why})`
    );
  }
  return { root: dest, full, cloned: true };
});

// With the user's PATH: an app opened from the desktop menu or the Dock does not have ~/.local/bin
// or npm's folder in its own, and then `claude mcp add` failed and that person's AI had no codev tools.
ipcMain.handle('setup-project', async (_e, opts) => setupProject({ ...opts, env: { ...cleanEnv(), PATH: await getUserPath() } }));

/**
 * The CoDev MCP server for one Claude Code terminal, as a file for `claude --mcp-config`. It holds
 * the room key, so it lives in the app's data folder, readable by this user only.
 */
function codevMcpConfig(name, codevEnv) {
  const runner = getRunner();
  const file = path.join(app.getPath('userData'), 'mcp', `${String(name).replace(/[^\w.-]/g, '_')}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const server = { type: 'stdio', command: runner.exe, args: [runner.cli, 'mcp'], env: { ...runner.env, ...codevEnv } };
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { codev: server } }, null, 2), { mode: 0o600 });
  return file;
}
ipcMain.handle('copy', (_e, text) => clipboard.writeText(text));
ipcMain.handle('focus-window', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// While an AI is working the screen stays on and does not lock, as when a video is playing.
let awakeId = null;
function updateAwake() {
  const on = [...contexts.values()].some((c) => c.awake);
  if (on && awakeId === null) awakeId = powerSaveBlocker.start('prevent-display-sleep');
  else if (!on && awakeId !== null) {
    powerSaveBlocker.stop(awakeId);
    awakeId = null;
  }
}
ipcMain.handle('keep-awake', (e, on) => {
  ctxOf(e.sender).awake = !!on;
  updateAwake();
});

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

/* ---------- AIs: which ones are installed, keys, local models ---------- */
// API keys are encrypted with the system keychain (safeStorage) and never reach the UI.
const keysFile = () => path.join(app.getPath('userData'), 'keys.json');
/** On Linux, safeStorage can fall back to `basic_text` (a hardcoded key) and still report
 * encryption as available. The README promises not to save a key in that case. */
const hasSecureStorage = () =>
  safeStorage.isEncryptionAvailable() &&
  (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
function readKeys() {
  try {
    return JSON.parse(fs.readFileSync(keysFile(), 'utf8'));
  } catch {
    return {};
  }
}
function getKey(agent) {
  const enc = readKeys()[agent];
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return null;
  }
}
ipcMain.handle('agent-key-set', (_e, agent, key) => {
  const a = AGENTS[agent];
  if (!a?.needsKey) throw new Error('That AI does not take an API key.');
  // No keychain, no key: CoDev never writes an API key in plain text.
  if (!hasSecureStorage()) throw new Error('This system has no keychain available, so CoDev cannot save the key encrypted.');
  const keys = readKeys();
  if (key) keys[agent] = safeStorage.encryptString(String(key).trim()).toString('base64');
  else delete keys[agent];
  fs.mkdirSync(path.dirname(keysFile()), { recursive: true });
  fs.writeFileSync(keysFile(), JSON.stringify(keys), { mode: 0o600 });
  balanceCache.delete(agent);
  return true;
});

/** What is left on the DeepSeek account (GET /user/balance). The key stays here; the UI gets only the amounts.
 * Cached for a minute, so several DeepSeek terminals do not each ask the API. */
const balanceCache = new Map();
ipcMain.handle('agent-balance', async (_e, agent, fresh = false) => {
  if (agent !== 'deepseek') return null;
  const cached = balanceCache.get(agent);
  if (cached && Date.now() - cached.at < (fresh ? 10_000 : 60_000)) return cached.value;
  const key = getKey(agent);
  if (!key) return { error: 'no key' };
  let value;
  try {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(res.status === 401 ? 'invalid key' : `HTTP ${res.status}`);
    const data = await res.json();
    value = {
      available: data.is_available !== false,
      balances: (data.balance_infos || []).map((b) => ({ currency: b.currency, total: Number(b.total_balance) })),
    };
  } catch (err) {
    value = { error: err.name === 'TimeoutError' ? 'timeout' : err.message };
  }
  balanceCache.set(agent, { at: Date.now(), value });
  return value;
});

const IS_WIN = process.platform === 'win32';
// On Windows a command is claude.exe, codex.cmd…: try the executable extensions, never the bare name
// (npm also leaves a shell script called just `codex` there, which Windows cannot run).
const COMMAND_EXTS = IS_WIN ? ['.exe', '.cmd', '.bat', '.com'] : [''];
/** Where installers put commands, even before this app's PATH knows about them (it is read once at start). */
function installDirs() {
  const home = os.homedir();
  return IS_WIN
    ? [path.join(home, '.local', 'bin'), path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm')]
    : [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/usr/local/bin', '/opt/homebrew/bin'];
}
function findCommand(PATH, command) {
  const dirs = [...new Set([...String(PATH || '').split(path.delimiter).filter(Boolean), ...installDirs()])];
  for (const dir of dirs) {
    for (const ext of COMMAND_EXTS) {
      const file = path.join(dir, command + ext);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {}
    }
  }
  return null;
}

/* ---------- Installing Claude Code when it is missing ---------- */
// Anthropic's native installer: it needs neither Node.js nor npm, and puts `claude` in ~/.local/bin.
const CLAUDE_INSTALLER = IS_WIN
  ? { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'] }
  : { file: '/bin/bash', args: ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'] };
// On Windows Claude Code runs its commands in Git Bash, so it needs Git for Windows.
const GIT_INSTALLER = {
  file: 'winget.exe',
  args: ['install', '--id', 'Git.Git', '-e', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements'],
};

/** Runs an installer in a terminal of its own and streams what it prints to the window. */
function runInstaller({ file, args }, { cols, rows, PATH, say }) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env: { ...cleanEnv(), PATH, TERM: 'xterm-256color' } });
    } catch (err) {
      say(`${err.message}\r\n`);
      return resolve(-1);
    }
    proc.onData(say);
    proc.onExit(({ exitCode }) => resolve(exitCode));
  });
}

function findGitBash(PATH) {
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH && fs.existsSync(process.env.CLAUDE_CODE_GIT_BASH_PATH)) return process.env.CLAUDE_CODE_GIT_BASH_PATH;
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')];
  for (const root of roots.filter(Boolean)) {
    const bash = path.join(root, 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(bash)) return bash;
  }
  const git = findCommand(PATH, 'git'); // …\Git\cmd\git.exe → …\Git\bin\bash.exe
  const bash = git && path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe');
  return bash && fs.existsSync(bash) ? bash : null;
}

let claudeInstall = null; // one install at a time, shared by every terminal that asks for it
/** Finds Claude Code, installing it (and Git for Windows, which it needs there) when it is missing. */
async function ensureClaude(PATH, opts) {
  const dim = (t) => opts.say(`\x1b[2m${t}\x1b[0m\r\n`);
  if (IS_WIN && !findGitBash(PATH)) {
    dim('CoDev: Claude Code needs Git for Windows, which is not installed. Installing it with winget…');
    const code = await runInstaller(GIT_INSTALLER, opts);
    if (!findGitBash(PATH)) {
      throw new Error(
        `Could not install Git for Windows${code ? ` (winget exit code ${code})` : ''}. Install it from https://git-scm.com/download/win and open the terminal again.`
      );
    }
  }
  let file = findCommand(PATH, 'claude');
  if (file) return file;
  claudeInstall ||= (async () => {
    dim('CoDev: Claude Code is not installed on this computer. Installing it now (about a minute)…');
    const code = await runInstaller(CLAUDE_INSTALLER, opts);
    return { code, file: findCommand(PATH, 'claude') };
  })().finally(() => (claudeInstall = null));
  const result = await claudeInstall;
  if (!result.file) {
    const how = IS_WIN ? 'irm https://claude.ai/install.ps1 | iex (in PowerShell)' : 'curl -fsSL https://claude.ai/install.sh | bash';
    throw new Error(`Could not install Claude Code${result.code ? ` (exit code ${result.code})` : ''}. Install it with ${how} and open the terminal again.`);
  }
  dim('CoDev: Claude Code is installed. The first time it asks you to sign in with your Claude account.');
  return result.file;
}

/** The DeepSeek Harness CLI: on PATH, or in the npm npx cache (how `npx @deepseek-ai/dsh` installs it). */
function findDsh(PATH) {
  const direct = findCommand(PATH, 'dsh');
  if (direct) return fs.realpathSync(direct);
  const home = os.homedir();
  const npx = path.join(home, '.npm', '_npx');
  try {
    for (const dir of fs.readdirSync(npx)) {
      const file = path.join(npx, dir, 'node_modules', '.bin', 'dsh');
      if (fs.existsSync(file)) return fs.realpathSync(file);
    }
  } catch {}
  for (const file of [path.join(home, '.local', 'bin', 'dsh'), '/usr/local/bin/dsh']) {
    if (fs.existsSync(file)) return fs.realpathSync(file);
  }
  return null;
}

/** The pi-ai model catalog of one provider, from the installed DeepSeek Harness (null if not found). */
function piCatalog(dsh, route) {
  if (!dsh || !/^[a-z0-9-]+$/.test(route)) return null;
  const rel = path.join('@earendil-works', 'pi-ai', 'dist', 'providers', 'data', `${route}.json`);
  for (let dir = path.dirname(dsh), i = 0; i < 8 && dir !== path.dirname(dir); dir = path.dirname(dir), i++) {
    for (const file of [path.join(dir, 'node_modules', rel), path.join(dir, rel)]) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {}
    }
  }
  return null;
}

ipcMain.handle('agents-info', async () => {
  const PATH = await getUserPath();
  const dsh = findDsh(PATH);
  const keyed = Object.values(AGENTS).filter((a) => a.needsKey);
  return {
    agents: AGENTS,
    installed: { claude: !!findCommand(PATH, 'claude'), codex: !!findCommand(PATH, 'codex'), dsh: !!dsh },
    hasKey: Object.fromEntries(keyed.map((a) => [a.id, !!getKey(a.id)])),
    // The models each API provider offers, from the Harness's own catalog (so they always exist there).
    models: Object.fromEntries(keyed.filter((a) => a.api).map((a) => [a.id, apiModels(a.id, (route) => piCatalog(dsh, route))])),
    ollama: await ollamaModels(),
    secureStorage: hasSecureStorage(),
  };
});

ipcMain.handle('pty-create', async (e, { id, cwd, cols, rows, env, command, agent, model }) => {
  const PATH = await getUserPath();
  let file = IS_WIN ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/bash';
  let args = [];
  let extraEnv = {};
  let unset = [];
  if (command || agent) {
    const agentId = agent || 'claude';
    const a = AGENTS[agentId] || AGENTS.claude;
    const key = a.needsKey ? getKey(agentId) : null;
    if (a.needsKey && !key) throw new Error(`No ${a.label} API key saved. Add it on the start screen and try again.`);
    const codevEnv = Object.fromEntries(Object.entries(env || {}).filter(([k]) => k.startsWith('CODEV_')));
    const rules = projectRules({ name: env?.CODEV_NAME || 'You', room: env?.CODEV_ROOM || '' }, { cli: cliCommand(getRunner()) });
    if (a.engine === 'harness') {
      const dsh = findDsh(PATH);
      if (!dsh) throw new Error(`The DeepSeek Harness is not installed. Install it with: ${a.install}`);
      const node = findCommand(PATH, 'node');
      if (!node) throw new Error('The DeepSeek Harness needs Node.js 20 or newer. Install it from https://nodejs.org and try again.');
      const spec = harnessPatch(agentId, {
        model,
        rules:
          `${rules}\n\n[CoDev Harness] You run in the DeepSeek Harness. Use the codev MCP tools: call codev_set_intent before starting, ` +
          'codev_claim_files before changing a file (if it is held by someone else, leave it alone), codev_release_files after, ' +
          'and codev_team_status to see your teammates. Keep the codev/history log as instructed.',
      });
      const patchFile = path.join(app.getPath('userData'), 'harness', `${ptyKey(e.sender, id).replace(/[^\w.-]/g, '_')}.yml`);
      fs.mkdirSync(path.dirname(patchFile), { recursive: true });
      fs.writeFileSync(patchFile, spec.patch);
      const runner = getRunner();
      const mcp = [
        {
          name: 'codev',
          command: node,
          args: [runner.cli, 'mcp'],
          env: Object.entries(codevEnv).map(([name, value]) => ({ name, value: String(value) })),
        },
      ];
      file = process.execPath;
      args = [path.join(path.dirname(runner.cli), 'harness.js')];
      extraEnv = {
        ...runner.env,
        ELECTRON_RUN_AS_NODE: '1',
        CODEV_DSH: dsh,
        CODEV_NODE: node,
        CODEV_HARNESS_AGENT: agentId,
        CODEV_HARNESS_LABEL: a.label,
        CODEV_HARNESS_MODEL: spec.model,
        CODEV_HARNESS_PATCH: patchFile,
        CODEV_HARNESS_MCP: JSON.stringify(mcp),
        DSH_PERMISSION_MODE: 'danger-full-access',
        ...(a.needsKey ? { [a.keyEnv || 'DEEPSEEK_API_KEY']: key } : { OLLAMA_API_KEY: 'ollama' }),
      };
      unset = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL'];
    } else {
      const spec = spawnSpec(agentId, {
        model,
        key,
        codev: codevEnv,
        runner: getRunner(),
        rules,
        mcpConfig: codevEnv.CODEV_ROOM ? codevMcpConfig(ptyKey(e.sender, id), codevEnv) : null,
      });
      file = findCommand(PATH, spec.command);
      if (!file && spec.command === 'claude') {
        const sender = e.sender;
        const say = (data) => !sender.isDestroyed() && sender.send('pty-data', id, data);
        file = await ensureClaude(PATH, { cols, rows, PATH, say });
      }
      if (!file) {
        throw new Error(`Cannot find \`${spec.command}\`. Install it with: ${a.install}${a.login ? `, then sign in with: ${a.login}` : ''}`);
      }
      // Codex asks for trust once; if the hooks cannot be written the terminal still works, only without locking.
      if (spec.command === 'codex') {
        try {
          installCodexHooks(cwd);
        } catch (err) {
          console.warn(`CoDev: cannot install the Codex hooks in ${cwd}:`, err.message);
        }
      }
      args = spec.args;
      extraEnv = spec.env;
      unset = spec.unset;
    }
  }
  const base = cleanEnv();
  for (const k of unset) delete base[k];
  // A .cmd or .bat (an npm command on Windows) runs through cmd.exe.
  if (IS_WIN && /\.(cmd|bat)$/i.test(file)) {
    args = ['/d', '/s', '/c', file, ...args];
    file = process.env.ComSpec || 'cmd.exe';
  }
  const proc = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...base, PATH, ...ownGithubEnv(), ...env, ...extraEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'CoDev' },
  });
  const key = ptyKey(e.sender, id);
  ptys.get(key)?.kill(); // the same terminal id again (a reloaded window): the old process goes
  ptys.set(key, proc);
  if ((command || agent) && env?.CODEV_NAME) aiSessions.set(key, { root: env.CODEV_ROOT || cwd, name: env.CODEV_NAME, since: Date.now() });
  const sender = e.sender;
  proc.onData((data) => !sender.isDestroyed() && sender.send('pty-data', id, data));
  proc.onExit(({ exitCode }) => {
    if (ptys.get(key) === proc) ptys.delete(key);
    endSession(key, 3000);
    if (!sender.isDestroyed()) sender.send('pty-exit', id, exitCode);
  });
  return true;
});

/* ---------- The "closed" line when an AI's terminal ends ----------
   The SessionEnd hook writes it, but not when the terminal is killed (closing its tab or the app; on
   Windows that ends Claude Code at once) nor for Codex, which has no SessionEnd. Then the team saw a
   session open for hours. So when an AI terminal ends, the app writes the line itself if the log
   still says "open" for a session started by that terminal, and publishes it like the hook does. */
const aiSessions = new Map(); // pty id -> { root, name, since }
function endSession(id, delay = 0) {
  const s = aiSessions.get(id);
  if (!s) return Promise.resolve();
  aiSessions.delete(id);
  // Another terminal of the same person on the same project is still working: their session is open.
  if ([...aiSessions.values()].some((o) => o.root === s.root && o.name === s.name)) return Promise.resolve();
  // A clean exit runs the hook first: give it a moment to write its own line.
  return new Promise((r) => setTimeout(r, delay)).then(() => closeLog(s));
}
function closeLog({ root, name, since }) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, '.codev.json'), 'utf8'));
    if (cfg.autoPush === false || process.env.CODEV_AUTOPUSH === '0') return Promise.resolve();
  } catch {}
  const file = historyPath({ name });
  try {
    const abs = path.join(root, file);
    if (!needsClose(fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '', since)) return Promise.resolve();
    const ts = Date.now();
    appendLog(root, file, `## ${stamp(new Date(ts))} — ${name} closed the session\n${closeMarker({ ts })}`);
  } catch {
    return Promise.resolve();
  }
  return publishClosed(root, file, name);
}
// The push runs in its own process (as the hook's does), so it never blocks the window and can
// finish after the app has quit.
function publishClosed(root, file, name) {
  return new Promise((resolve) => {
    try {
      const r = getRunner();
      const child = spawn(r.exe, [r.cli, 'publish-log', '--root', root, '--message', `codev: ${name} closed a session`, '--file', file, '--file', 'codev/README.md'], {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...cleanEnv(), ...r.env },
      });
      child.on('exit', resolve);
      child.on('error', resolve);
      child.unref();
    } catch {
      resolve();
    }
  });
}
// AIs that died without closing their session, whatever ran them (a terminal window closed
// abruptly, this app killed or crashed last time): close them. On start and every minute.
function closeDeadAiSessions() {
  try {
    for (const d of closeDeadSessions()) publishClosed(d.root, d.file, d.name);
  } catch {}
}
const endAllSessions = () => Promise.all([...aiSessions.keys()].map((id) => endSession(id)));

ipcMain.on('pty-write', (e, id, data) => ptys.get(ptyKey(e.sender, id))?.write(data));
ipcMain.on('pty-resize', (e, id, cols, rows) => {
  try {
    ptys.get(ptyKey(e.sender, id))?.resize(cols, rows);
  } catch {}
});
ipcMain.on('pty-kill', (e, id) => {
  const key = ptyKey(e.sender, id);
  ptys.get(key)?.kill();
  ptys.delete(key);
});

/* ---------- Local history (<project>/.codev/history.jsonl) ---------- */
ipcMain.handle('history-open', (e, { root }) => {
  const c = ctxOf(e.sender);
  c.history = new History(path.join(root, '.codev', 'history.jsonl'));
  return c.history.file;
});
ipcMain.handle('history-append', (e, events, room) => ctxOf(e.sender).history?.append(events, room) ?? 0);
ipcMain.handle('history-read', (e) => ctxOf(e.sender).history?.read() ?? []);
ipcMain.handle('history-reveal', (e) => {
  const history = ctxOf(e.sender).history;
  if (history) {
    fs.mkdirSync(path.dirname(history.file), { recursive: true });
    if (!fs.existsSync(history.file)) fs.writeFileSync(history.file, '');
    shell.showItemInFolder(history.file);
  }
  return true;
});

/* ---------- Guest terminals: a browser visitor's own Claude Code, on this computer ---------- */
// Someone watching from a browser cannot run Claude Code there, so they can ask the host for one.
// It only starts if the host clicks Allow. It runs in its own git worktree (branch codev/<name>) and
// with a throwaway Claude config folder, so the guest signs in with their own Claude account and
// nothing of theirs stays here when they close it.
const guests = new Map(); // id -> { proc, configDir, member, ctx }
const guestAsks = new Map(); // request id -> { resolve(allowed), ctx }
let askSeq = 0;

ipcMain.handle('host-context', (e, hostCtx) => {
  const c = ctxOf(e.sender);
  c.hostCtx = hostCtx;
  c.hostIdentity = null;
  announceRoom(c);
  return true;
});
ipcMain.handle('guest-decision', (_e, reqId, allow) => {
  guestAsks.get(reqId)?.resolve(!!allow);
  guestAsks.delete(reqId);
  return true;
});
ipcMain.handle('guest-stop', (_e, id) => {
  guestHooks.close(id);
  return true;
});

const notifyGuests = () => {
  for (const c of contexts.values()) {
    if (!c.sender.isDestroyed()) c.sender.send('guests', [...guests].filter(([, g]) => g.ctx === c).map(([id]) => id));
  }
};
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'guest';

async function isGitRepo(root) {
  try {
    return (await run('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

/** The guest's own copy of the project: a git worktree on branch codev/<name>, or the same folder. */
async function guestWorkspace(hostCtx, member) {
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

function askHost(ctx, req, plan, timeoutMs = 120_000) {
  const win = ctx.win;
  if (!win || win.isDestroyed()) return Promise.resolve(false);
  const reqId = ++askSeq;
  win.webContents.send('guest-request', { reqId, member: req.member, ...plan });
  if (win.isMinimized()) win.restore();
  win.flashFrame(true);
  return new Promise((resolve) => {
    guestAsks.set(reqId, { resolve, ctx });
    setTimeout(() => {
      if (guestAsks.has(reqId)) {
        guestAsks.delete(reqId);
        if (!win.isDestroyed()) win.webContents.send('guest-request-expired', reqId);
        resolve(false);
      }
    }, timeoutMs);
  });
}

const guestHooks = {
  async open(req, reply) {
    const deny = (reason) => reply({ t: 'guest-denied', id: req.id, reason });
    const ctx = ctxByRoom(req.room);
    const hostCtx = ctx?.hostCtx;
    if (!hostCtx) return deny('The host is not in this room any more.');
    if (guests.has(req.id)) return deny('That terminal is already open.');
    const sameFolder = !(await isGitRepo(hostCtx.root));
    const plan = { sameFolder, branch: sameFolder ? null : `codev/${slug(req.member)}`, project: path.basename(hostCtx.root) };
    if (!(await askHost(ctx, req, plan))) return deny(`${hostCtx.name} did not let you in this time.`);
    try {
      const { dir } = await guestWorkspace(hostCtx, req.member);
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
      const proc = pty.spawn(claude, ['--mcp-config', codevMcpConfig(`guest-${req.id}`, codevEnv)], {
        name: 'xterm-256color',
        cols: req.cols,
        rows: req.rows,
        cwd: dir,
        env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'CoDev' },
      });
      guests.set(req.id, { proc, configDir, member: req.member, ctx });
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

/* ---------- Leaving the room: back to the start screen ---------- */
// Everything tied to the room stops (terminals, guests, the online link, the announcements); the
// embedded server keeps running, so creating a room again reuses it.
// Only this window's room: the other windows (other projects) keep theirs.
async function leaveRoom(c) {
  const mine = (key) => key.startsWith(`${c.id}:`);
  const keys = [...ptys.keys()].filter(mine);
  const closing = Promise.all([...aiSessions.keys()].filter(mine).map((k) => endSession(k))); // before the kills
  for (const k of keys) {
    try {
      ptys.get(k).kill();
    } catch {}
    ptys.delete(k);
  }
  for (const [id, g] of [...guests]) if (g.ctx === c) guestHooks.close(id);
  for (const [reqId, a] of [...guestAsks]) {
    if (a.ctx !== c) continue;
    a.resolve(false);
    guestAsks.delete(reqId);
  }
  c.sharing = false;
  stopTunnelIfUnused();
  lan?.stop(c.id);
  c.hostCtx = null;
  c.hostIdentity = null;
  c.history = null;
  c.awake = false;
  updateAwake();
  await Promise.race([Promise.all([unannounceGithub(c).catch(() => {}), closing]), new Promise((r) => setTimeout(r, 4000))]);
}
ipcMain.handle('leave-room', async (e) => {
  await leaveRoom(ctxOf(e.sender));
  return true;
});

/* ---------- Teammates on the same project: find their rooms, knock, let them in ---------- */
// See discovery.js. Rooms are announced on the local network while hosted, and in the GitHub
// repository while shared online. Finding a room gives no access: the visitor knocks, the host decides.
const INSTANCE = crypto.randomUUID();
let lan = null;
const lanDiscovery = () =>
  (lan ||= startLan({ inst: INSTANCE, onError: (err) => console.warn('CoDev: local network discovery:', err.message) }));

async function identityOf(root) {
  const id = await projectIdentity(root, run);
  return { ...id, fp: fingerprint(id) };
}
// The sign-in token, or the one from an existing `gh` session: the API is called directly, so `gh` is optional.
const ghToken = async () => (await githubToken())?.token || null;

async function announceRoom(c) {
  if (!c?.hostCtx || !hostedServer) return;
  const { hostCtx } = c;
  try {
    c.hostIdentity ||= await identityOf(hostCtx.root);
  } catch {
    return;
  }
  if (c.hostCtx !== hostCtx) return; // left the room meanwhile
  const { fp, repo } = c.hostIdentity;
  if (fp.r || fp.g) {
    lanDiscovery().announce({ name: hostCtx.name, room: hostCtx.room, port: hostedServer.address().port, r: fp.r, g: fp.g }, c.id);
  }
  if (!repo || !tunnel?.url || !c.sharing) return;
  const publish = async () => {
    if (c.hostCtx !== hostCtx || !tunnel?.url || !c.sharing) return;
    const token = await ghToken();
    try {
      await publishGithubRoom({ repo, name: hostCtx.name, room: hostCtx.room, url: tunnel.url, token });
      c.ghPublished = { repo, name: hostCtx.name };
    } catch (err) {
      // No token (or no API write access): the same git credentials that push the session logs
      // can push the room's ref. Without this, teammates see the session but never the room.
      try {
        await publishRoomWithGit(hostCtx.root, { name: hostCtx.name, room: hostCtx.room, url: tunnel.url });
        c.ghPublished = { repo, name: hostCtx.name, root: hostCtx.root };
        return;
      } catch (gitErr) {
        console.warn('CoDev: git push of the room failed too:', gitErr.stderr || gitErr.message);
      }
      console.warn(`CoDev: could not list the room in ${repo} on GitHub:`, err.message);
      // Tell the host: otherwise teammates on other networks just never see the room.
      const why = token ? `you need write access to ${repo} (${err.message})` : 'sign in with GitHub on the start screen';
      if (!c.sender.isDestroyed()) c.sender.send('discovery-warning', `Teammates on other networks will not find this room: ${why}. The invite link still works.`);
    }
  };
  await publish();
  clearInterval(c.ghTimer);
  c.ghTimer = setInterval(publish, 10 * 60 * 1000); // listings older than 30 minutes are ignored
}

async function unannounceGithub(c) {
  clearInterval(c.ghTimer);
  c.ghTimer = null;
  const p = c.ghPublished;
  c.ghPublished = null;
  if (!p) return;
  if (p.root) return gitInRoot(p.root, ['push', '--quiet', 'origin', '--delete', `refs/${roomRef(p.name)}`]).catch(() => {});
  await unpublishGithubRoom({ ...p, token: await ghToken() });
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
async function gitInRoot(root, args) {
  const auth = await githubToken().catch(() => null);
  const env = { ...process.env, PATH: await getUserPath(), GIT_TERMINAL_PROMPT: '0', ...gitTokenEnv(auth?.token) };
  return (await run('git', ['-C', root, ...args], { env, timeout: 30_000 })).trim();
}
/** The room as a commit on refs/codev/rooms/<name>, pushed with git (listGithubRooms reads its message). */
async function publishRoomWithGit(root, room) {
  const sha = await gitInRoot(root, [
    '-c', 'user.name=CoDev', '-c', 'user.email=codev@localhost',
    'commit-tree', EMPTY_TREE, '-m', roomMessage(room),
  ]);
  await gitInRoot(root, ['push', '--quiet', '--force', 'origin', `${sha}:refs/${roomRef(room.name)}`]);
}

const knockHooks = {
  async ask({ room, member, project }) {
    const c = ctxByRoom(room);
    if (!c) return false;
    const { hostCtx } = c;
    c.hostIdentity ||= await identityOf(hostCtx.root).catch(() => null);
    const hostIdentity = c.hostIdentity;
    const theirs = { r: typeof project?.r === 'string' ? project.r : null, g: typeof project?.g === 'string' ? project.g : null };
    const same = !!hostIdentity && sameProject(hostIdentity.fp, theirs);
    return askHost(
      c,
      { member },
      { kind: 'knock', sameProject: same, project: hostIdentity?.repo || path.basename(hostCtx.root) },
      90_000 // under Cloudflare's 100-second limit for an open request
    );
  },
};

/* Who has a session open, from the CoDev logs in the repository (presence.js). Read from the local
   clone after a fetch, or through the GitHub API when the repository is not cloned yet. At most once
   a minute per project: discovery asks every few seconds. */
const presenceCache = new Map(); // key -> { at, sessions }
async function logsFromClone(root) {
  const git = (args, opts) => run('git', ['-C', root, ...args], opts).then((o) => o.trim());
  const auth = await githubToken();
  const env = { ...process.env, PATH: await getUserPath(), GIT_TERMINAL_PROMPT: '0', ...gitTokenEnv(auth?.token) };
  await git(['fetch', '--quiet'], { env, timeout: 30_000 }).catch(() => {});
  const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => null);
  if (!up) {
    const dir = path.join(root, 'codev', 'history');
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
    return names.map((f) => ({ file: `codev/history/${f}`, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
  }
  const files = (await git(['ls-tree', '--name-only', up, 'codev/history/']).catch(() => '')).split('\n').filter((f) => f.endsWith('.md'));
  return Promise.all(files.map(async (file) => ({ file, text: await git(['show', `${up}:${file}`]).catch(() => '') })));
}
async function logsFromGithub(full) {
  const token = await ghToken();
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'CoDev', ...(token && { authorization: `Bearer ${token}` }) };
  const res = await fetch(`https://api.github.com/repos/${full}/contents/codev/history`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return [];
  const list = (await res.json()).filter((f) => f.type === 'file' && f.name.endsWith('.md'));
  return Promise.all(
    list.map(async (f) => {
      const r = await fetch(f.url, { headers: { ...headers, accept: 'application/vnd.github.raw' }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
      return { file: f.path, text: r?.ok ? await r.text() : '' };
    })
  );
}
async function presenceOf({ root, repo }) {
  const key = root || repo;
  const hit = presenceCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.sessions;
  presenceCache.set(key, { at: Date.now(), sessions: hit?.sessions || [] }); // one read at a time
  const sessions = openSessions(await (root ? logsFromClone(root) : logsFromGithub(repo)).catch(() => []));
  presenceCache.set(key, { at: Date.now(), sessions });
  return sessions;
}

/* The rooms listed on GitHub, at most every 30 s per repository (2 min without a token, which gets
   60 API requests an hour): discovery asks every 8 seconds. */
const githubRoomsCache = new Map(); // repo -> { at, rooms, ttl }
async function githubRoomsOf(repo) {
  const hit = githubRoomsCache.get(repo);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.rooms;
  const token = await ghToken();
  const ttl = token ? 30_000 : 120_000;
  githubRoomsCache.set(repo, { at: Date.now(), rooms: hit?.rooms || [], ttl }); // one read at a time
  const rooms = await listGithubRooms({ repo, token }).catch(() => []);
  githubRoomsCache.set(repo, { at: Date.now(), rooms, ttl });
  return rooms;
}

/** Rooms of teammates on the same project as `root` (a folder) or `repo` (owner/name). */
ipcMain.handle('discover', async (_e, { root, repo } = {}) => {
  let id = { rootCommit: null, repo: null };
  if (root && fs.existsSync(root)) id = await projectIdentity(root, run);
  if (!id.repo && repo) id.repo = parseRepo(repo);
  const fp = fingerprint(id);
  // Sessions open according to the logs: a folder, or the clone of the repository if there is one.
  const full = !root && repo ? parseRepo(repo) : null;
  const clone = full && fs.existsSync(path.join(repoDest(full), '.git')) ? repoDest(full) : null;
  const where = root && fs.existsSync(root) ? { root } : clone ? { root: clone } : full ? { repo: full } : null;
  // Presence can wait on a `git fetch` (up to 30 s): do not hold the room listing behind it.
  const presence = where ? presenceOf(where).catch(() => []) : Promise.resolve([]);
  if (!fp.r && !fp.g) return { fp, rooms: [], sessions: await presence };
  const found = lanDiscovery().peers().filter((p) => sameProject(fp, p));
  const [sessions, ghRooms] = await Promise.all([presence, id.repo ? githubRoomsOf(id.repo) : []]);
  found.push(...ghRooms);
  const seen = new Set();
  const rooms = [];
  await Promise.all(
    found.map(async (r) => {
      const k = `${r.name}\n${r.room}`;
      if (seen.has(k) || [...contexts.values()].some((c) => c.hostCtx && r.name === c.hostCtx.name && r.room === c.hostCtx.room)) return;
      seen.add(k); // the local network comes first, so it wins over the same room on GitHub
      try {
        const res = await fetch(`${r.url}/api/info`, { signal: AbortSignal.timeout(3000) });
        if ((await res.json()).knock) rooms.push({ name: r.name, room: r.room, url: r.url, via: r.via });
      } catch {} // a room that does not answer is closed
    })
  );
  return { fp, rooms, sessions };
});

/* ---------- Packaged app: a stable copy of the CLI for the hooks and the MCP server ---------- */
// Inside a package the CLI lives in app.asar (and in an AppImage, under a mount path that changes on
// every launch). Claude Code runs the hooks on its own, even when CoDev is closed, so they need a path
// that stays put: we copy the CLI to the user data folder and run it with this app's own binary as
// Node. An AppImage is run through its own file ($APPIMAGE), which does not move.
function prepareRuntime() {
  if (!app.isPackaged) return;
  const dir = path.join(app.getPath('userData'), 'runtime', app.getVersion());
  const copy = (from, to) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, fs.readFileSync(from));
  };
  const copyTree = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, entry.name);
      const b = path.join(to, entry.name);
      if (entry.isDirectory()) copyTree(a, b);
      else fs.writeFileSync(b, fs.readFileSync(a));
    }
  };
  if (!fs.existsSync(path.join(dir, 'cli', 'codev.js'))) {
    for (const f of fs.readdirSync(path.join(APP_DIR, 'cli'))) if (f.endsWith('.js')) copy(path.join(APP_DIR, 'cli', f), path.join(dir, 'cli', f));
    copy(path.join(APP_DIR, 'desktop', 'history.js'), path.join(dir, 'desktop', 'history.js'));
    copy(path.join(APP_DIR, 'desktop', 'presence.js'), path.join(dir, 'desktop', 'presence.js')); // the hook writes its markers
    // The Harness terminal (cli/harness.js) imports the ACP SDK; the packaged app runs the bridge from this folder.
    try {
      copyTree(path.join(APP_DIR, 'node_modules', '@agentclientprotocol', 'sdk'), path.join(dir, 'node_modules', '@agentclientprotocol', 'sdk'));
      // The SDK's peer dependency: its generated schema modules import zod at runtime.
      copyTree(path.join(APP_DIR, 'node_modules', 'zod'), path.join(dir, 'node_modules', 'zod'));
    } catch (err) {
      console.warn('CoDev: cannot copy the ACP SDK to the runtime folder:', err.message);
    }
    fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n');
  }
  useRunner({ exe: process.env.APPIMAGE || process.execPath, cli: path.join(dir, 'cli', 'codev.js'), env: { ELECTRON_RUN_AS_NODE: '1' } });
}

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
  const win = mainWindow();
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
  if (process.platform === 'linux') {
    // From source, or from an AppImage (which installs nothing), we write the .desktop entry
    // for the scheme ourselves. The .deb package ships its own entry; we only make it the default.
    const appImage = app.isPackaged && process.env.APPIMAGE;
    if (app.isPackaged && !appImage) {
      execFile('xdg-mime', ['default', 'codev.desktop', 'x-scheme-handler/codev'], () => {});
      return;
    }
    try {
      const dir = path.join(os.homedir(), '.local', 'share', 'applications');
      const name = appImage ? 'codev-appimage.desktop' : 'codev-dev.desktop';
      const exec = appImage ? `"${appImage}" %u` : `"${process.execPath}" "${APP_DIR}" %u`;
      const entry = [
        '[Desktop Entry]',
        'Type=Application',
        'Name=CoDev',
        'Comment=Code as a team with AI without stepping on each other',
        `Exec=${exec}`,
        'Terminal=false',
        'NoDisplay=true',
        'MimeType=x-scheme-handler/codev;',
        '',
      ].join('\n');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, name);
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== entry) fs.writeFileSync(file, entry);
      execFile('xdg-mime', ['default', name, 'x-scheme-handler/codev'], () => {});
    } catch {}
  } else if (app.isPackaged) {
    app.setAsDefaultProtocolClient('codev');
  } else {
    app.setAsDefaultProtocolClient('codev', process.execPath, [APP_DIR]);
  }
}

/* ---------- Updates from GitHub releases ---------- */
// CODEV_FAKE_VERSION=0.0.1 makes this copy look old, to try the update notice.
const currentVersion = () => process.env.CODEV_FAKE_VERSION || app.getVersion();
const updateKind = () =>
  installKind({ platform: process.platform, arch: process.arch, packaged: app.isPackaged, appImage: process.env.APPIMAGE });
let update = null; // the newer release, once found
let updating = false;

async function checkForUpdate() {
  if (updating) return;
  try {
    const found = await checkLatest(currentVersion(), { token: await ghToken().catch(() => null) });
    if (!found) return;
    update = found;
    sendAll('update-available', {
      version: found.version,
      current: currentVersion(),
      auto: updateKind() !== 'page',
    });
  } catch (err) {
    console.warn('[codev] update check failed:', err.message); // offline: try again later
  }
}
ipcMain.handle('update-check', () => checkForUpdate());
// Desktops like KDE start CoDev as a systemd service: when it quits, systemd kills everything
// left in that service, including the copy app.relaunch() just started (the AppImage then fails
// with "Cannot mount AppImage"). So there we start the new copy in its own scope, once we have exited.
function relaunch({ execPath = process.execPath, args = process.argv.slice(1) } = {}) {
  if (process.platform === 'linux' && process.env.INVOCATION_ID) {
    const wait = `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done; exec "$@"`;
    const child = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', 'sh', '-c', wait, 'codev', execPath, ...args], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => app.relaunch({ execPath, args })); // no systemd-run: Electron's own relaunch
    child.unref();
    return;
  }
  app.relaunch({ execPath, args });
}

ipcMain.handle('update-install', async () => {
  if (!update || updating) return { ok: false };
  const kind = updateKind();
  if (kind === 'page') {
    shell.openExternal(update.url || RELEASES_PAGE);
    return { ok: true, page: true };
  }
  updating = true;
  try {
    const next = await installUpdate(update, {
      kind,
      appImage: process.env.APPIMAGE,
      execPath: process.execPath,
      onProgress: (p) => sendAll('update-progress', p),
    });
    if (next.relaunch) relaunch(next.relaunch);
    // Closing the window runs the usual cleanup (terminals, tunnel, room) and then quits.
    // (The pause also lets systemd-run move the new copy into its own scope before we exit.)
    setTimeout(() => (allWindows().length ? allWindows().forEach((w) => w.close()) : app.quit()), 1000);
    return { ok: true };
  } catch (err) {
    updating = false;
    return { ok: false, error: err.message, page: update.url || RELEASES_PAGE };
  }
});
ipcMain.handle('open-releases', () => shell.openExternal(update?.url || RELEASES_PAGE));

// One window per profile: a codev:// link opened while CoDev runs goes to the open window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Opening CoDev again while it runs: an invite link goes to the open window; otherwise a new
  // window opens, for another project.
  app.on('second-instance', (_e, argv) => {
    const link = argv.map(parseAppLink).find(Boolean);
    if (link) deliverLink(link);
    else createWindow();
  });
  app.on('open-url', (e, url) => {
    e.preventDefault();
    deliverLink(parseAppLink(url));
  });
  pendingLink = process.argv.map(parseAppLink).find(Boolean) || null;

  app.whenReady().then(() => {
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    prepareRuntime();
    registerProtocol();
    const first = createWindow();
    lanDiscovery(); // start listening early: rooms on the network are heard every few seconds
    first.webContents.once('did-finish-load', () => setTimeout(checkForUpdate, 3000));
    setInterval(checkForUpdate, 4 * 60 * 60 * 1000);
    closeDeadAiSessions();
    setInterval(closeDeadAiSessions, 60 * 1000);
  });
}
app.on('window-all-closed', () => {
  const closing = endAllSessions(); // before the kills, so their exits do not race it
  for (const p of ptys.values()) p.kill();
  tunnel?.proc?.kill();
  for (const id of [...guests.keys()]) guestHooks.close(id);
  hostedServer?.close();
  lan?.close();
  // Take the rooms off the GitHub repositories, but never hold the quit for long.
  const unannounce = [...contexts.values()].map((c) => unannounceGithub(c).catch(() => {}));
  Promise.race([Promise.all([...unannounce, ...leaving, closing]), new Promise((r) => setTimeout(r, 8000))]).finally(() => app.quit());
});
