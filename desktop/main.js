// Procés principal de l'app d'escriptori: finestra, terminals reals (PTY) i servidor opcional.
import { app, BrowserWindow, Menu, ipcMain, dialog, clipboard, shell } from 'electron';
import pty from '@lydell/node-pty';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { startServer } from '../server/server.js';
import { setupProject } from '../cli/init.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ptys = new Map(); // id -> procés
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
  // F12 obre les eines de desenvolupament (sense menú, Ctrl+C/Ctrl+V van directes a la terminal).
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  // Els enllaços externs s'obren al navegador, no dins l'app.
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
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Tria la carpeta del projecte' });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('host-server', async (_e, requested = 4321) => {
  const port = Number(process.env.CODEV_PORT) || requested;
  const local = `http://localhost:${port}`;
  if (!hostedServer) {
    // Si ja hi ha un servidor de CoDev compatible en aquest port (p. ex. arrencat amb la CLI), el reaprofitem.
    try {
      const res = await fetch(`${local}/api/info`, { signal: AbortSignal.timeout(800) });
      const info = res.ok ? await res.json() : null;
      if (info?.app === 'codev' && info.terminals) return { url: local, lan: lanAddresses(port), reused: true };
    } catch {}
    try {
      hostedServer = await startServer({ port, host: '0.0.0.0' });
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        throw new Error(`El port ${port} ja està ocupat (potser per una versió antiga de \`codev server\`). Atura-la i torna-ho a provar.`);
      }
      throw err;
    }
  }
  return { url: local, lan: lanAddresses(port) };
});

ipcMain.handle('setup-project', (_e, opts) => setupProject(opts));
ipcMain.handle('copy', (_e, text) => clipboard.writeText(text));

// PATH del shell de l'usuari (nvm, ~/.local/bin...). Si l'app s'obre des del menú, el PATH heretat és mínim.
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

// Si l'app s'ha obert des de dins d'una sessió de Claude Code, no passem les seves marques de sessió
// als Claude Code nous (si no, creuen que són subsessions i desactiven l'historial).
const SESSION_VARS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(CHILD_|SESSION_|MESSAGING_|ENTRYPOINT|EXECPATH|SSE_PORT))/;
function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !SESSION_VARS.test(k)));
}

ipcMain.handle('pty-create', async (e, { id, cwd, cols, rows, env, command }) => {
  const PATH = await getUserPath();
  let file = process.env.SHELL || '/bin/bash';
  if (command) {
    file = PATH.split(':').map((d) => path.join(d, command)).find((f) => fs.existsSync(f));
    if (!file) throw new Error(`No trobo \`${command}\` al PATH. Instal·la Claude Code: npm i -g @anthropic-ai/claude-code`);
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

app.whenReady().then(() => {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  createWindow();
});
app.on('window-all-closed', () => {
  for (const p of ptys.values()) p.kill();
  hostedServer?.close();
  app.quit();
});
