// Updates from GitHub releases: finds a newer version, downloads the right installer and installs it.
// No update server and no signing: the release assets the Release workflow already publishes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile, spawn } from 'node:child_process';

export const REPO = 'santigonzalezballbe-arch/CoDev';
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

/** Compares "0.4.10" with "v0.5.0": > 0 if a is newer, < 0 if older, 0 if the same. */
export function compareVersions(a, b) {
  const parse = (v) => String(v).trim().replace(/^v/, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * How this copy was installed, so the update reaches it the same way.
 * 'appimage' | 'deb' | 'nsis' | 'dmg' | 'page' (no way to install it: open the release page).
 */
export function installKind({ platform, arch, packaged, appImage }) {
  if (!packaged) return 'page';
  if (platform === 'linux') return appImage ? 'appimage' : arch === 'x64' ? 'deb' : 'page';
  if (platform === 'win32') return 'nsis';
  if (platform === 'darwin') return arch === 'arm64' ? 'dmg' : 'page';
  return 'page';
}

/** The release asset for an install kind (the names come from "artifactName" in package.json). */
export function pickAsset(assets, kind) {
  const test = {
    appimage: (n) => /\.AppImage$/i.test(n),
    deb: (n) => /amd64\.deb$/i.test(n),
    nsis: (n) => /^CoDev-Setup-.*\.exe$/i.test(n),
    dmg: (n) => /arm64\.dmg$/i.test(n),
  }[kind];
  return test ? assets.find((a) => test(a.name)) || null : null;
}

/** The installer names the Release workflow publishes for a version (see "artifactName" in package.json). */
export function knownAssets(version) {
  const base = `https://github.com/${REPO}/releases/download/v${version}/`;
  return [`CoDev-${version}-x86_64.AppImage`, `CoDev-${version}-amd64.deb`, `CoDev-Setup-${version}.exe`, `CoDev-${version}-arm64.dmg`].map(
    (name) => ({ name, size: 0, url: base + encodeURIComponent(name), digest: null })
  );
}

/**
 * Latest version from the github.com page, which is not under the API's rate limit
 * (60 requests an hour per IP without a token): /releases/latest redirects to /releases/tag/vX.
 */
async function latestFromPage(current, fetchImpl) {
  const res = await fetchImpl(RELEASES_PAGE, {
    method: 'HEAD',
    redirect: 'manual',
    headers: { 'User-Agent': 'CoDev-updater' },
    signal: AbortSignal.timeout(15000),
  });
  const tag = (res.headers.get('location') || res.url || '').match(/\/releases\/tag\/([^/?#]+)/)?.[1];
  if (!tag) throw new Error(`GitHub answered ${res.status} without a release`);
  const version = decodeURIComponent(tag).replace(/^v/, '');
  if (compareVersions(version, current) <= 0) return null;
  return { version, url: `https://github.com/${REPO}/releases/tag/${tag}`, assets: knownAssets(version) };
}

/** Latest release on GitHub, or null if it is not newer than `current`. */
export async function checkLatest(current, { fetchImpl = fetch, token = null } = {}) {
  let res;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'CoDev-updater',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    res = null;
  }
  // Rate-limited (403/429), a bad token (401) or the API down: ask the web page instead.
  if (!res?.ok) return latestFromPage(current, fetchImpl);
  const rel = await res.json();
  if (rel.draft || rel.prerelease || compareVersions(rel.tag_name, current) <= 0) return null;
  return {
    version: rel.tag_name.replace(/^v/, ''),
    url: rel.html_url || RELEASES_PAGE,
    assets: (rel.assets || []).map((a) => ({
      name: a.name,
      size: a.size,
      url: a.browser_download_url,
      digest: a.digest || null, // "sha256:..." when GitHub provides it
    })),
  };
}

/** Downloads an asset to `dest`, checking size and SHA-256. onProgress(0..1). */
export async function download(asset, dest, onProgress = () => {}) {
  const res = await fetch(asset.url, { headers: { 'User-Agent': 'CoDev-updater' } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = asset.size || Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  let got = 0;
  let last = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    hash.update(chunk);
    got += chunk.length;
    if (total && Date.now() - last > 200) {
      last = Date.now();
      onProgress(Math.min(1, got / total));
    }
  });
  const tmp = `${dest}.part`;
  await pipeline(body, fs.createWriteStream(tmp));
  if (asset.size && got !== asset.size) throw new Error('The download is incomplete');
  const want = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null;
  if (want && hash.digest('hex') !== want) {
    fs.rmSync(tmp, { force: true });
    throw new Error('The download does not match the release (SHA-256)');
  }
  fs.renameSync(tmp, dest);
  onProgress(1);
  return dest;
}

const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 10 * 60 * 1000 }, (err, _out, stderr) =>
      err ? reject(new Error((stderr || err.message).trim().split('\n').pop())) : resolve()
    )
  );

/**
 * Downloads and installs the update. Returns what the app must do next:
 * { relaunch: { execPath?, args? } } to restart into the new version, or { quit: true }
 * when an installer takes over (Windows).
 */
export async function install(update, { kind, appImage, execPath, onProgress }) {
  const asset = pickAsset(update.assets, kind);
  if (!asset) throw new Error('This release has no installer for this system');
  if (kind === 'appimage') {
    // Download next to the running AppImage and swap it in: Linux keeps the running copy alive.
    const next = `${appImage}.new`;
    await download(asset, next, onProgress);
    fs.chmodSync(next, 0o755);
    fs.renameSync(next, appImage);
    return { relaunch: { execPath: appImage, args: [] } };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-update-'));
  const file = await download(asset, path.join(dir, asset.name), onProgress);

  if (kind === 'deb') {
    // pkexec asks for the password in a system window.
    await run('pkexec', ['dpkg', '-i', file]);
    return { relaunch: {} };
  }
  if (kind === 'nsis') {
    // Silent install into the same folder; --force-run opens CoDev again when it finishes.
    spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    return { quit: true };
  }
  if (kind === 'dmg') {
    const bundle = path.resolve(execPath, '..', '..', '..'); // .../CoDev.app/Contents/MacOS/CoDev
    const mnt = path.join(dir, 'mnt');
    await run('hdiutil', ['attach', '-nobrowse', '-quiet', '-mountpoint', mnt, file]);
    try {
      const app = fs.readdirSync(mnt).find((n) => n.endsWith('.app'));
      if (!app) throw new Error('No app inside the disk image');
      const staged = `${bundle}.new`;
      fs.rmSync(staged, { recursive: true, force: true });
      await run('ditto', [path.join(mnt, app), staged]);
      fs.rmSync(bundle, { recursive: true, force: true });
      fs.renameSync(staged, bundle);
    } finally {
      await run('hdiutil', ['detach', '-quiet', mnt]).catch(() => {});
    }
    return { relaunch: { execPath: path.join(bundle, 'Contents', 'MacOS', path.basename(execPath)) } };
  }
  throw new Error('Automatic install is not available here');
}
