// Finds cloudflared, or downloads it the first time "Share online" is used.
// The version and the SHA-256 of every file are pinned here: a download that does not match is thrown away.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export const CLOUDFLARED_VERSION = '2026.11.1';

// From https://github.com/cloudflare/cloudflared/releases/tag/2026.11.1
const ASSETS = {
  'linux-x64': { file: 'cloudflared-linux-amd64', sha256: '97bb3b02d23a5980fc9c15a1a270e692da1923f103f920d5b16d4931d5ab55e7' },
  'linux-arm64': { file: 'cloudflared-linux-arm64', sha256: 'b155cec3e48e489cfb8e5c602769fb8c771083018d8881d68b4d18a791567c5a' },
  'darwin-x64': { file: 'cloudflared-darwin-amd64.tgz', sha256: '5e0403b188dfee71fbd9b995e7dc9910d61b661c52371935ab6475d41185632f', tgz: true },
  'darwin-arm64': { file: 'cloudflared-darwin-arm64.tgz', sha256: '02fe4bcf08f2c09699cff30658228a739a0c47fb75f3653d1b8772a27ade4462', tgz: true },
  'win32-x64': { file: 'cloudflared-windows-amd64.exe', sha256: '341deda3db5ec498a0482254d6c38c0b7cf01a30c37bb5dd95d2216d08955e35' },
};

const EXE = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Looks for a usable cloudflared, in this order: the user's own install (PATH), one shipped
 * inside a packaged app (resourcesDir/bin), and one this app downloaded earlier (dataDir/bin).
 */
export function findCloudflared({ PATH = process.env.PATH || '', resourcesDir, dataDir } = {}) {
  for (const dir of PATH.split(path.delimiter)) {
    if (dir && isFile(path.join(dir, EXE))) return path.join(dir, EXE);
  }
  if (resourcesDir && isFile(path.join(resourcesDir, 'bin', EXE))) return path.join(resourcesDir, 'bin', EXE);
  const own = ownPath(dataDir);
  return own && isFile(own) ? own : null;
}

const ownPath = (dataDir) => dataDir && path.join(dataDir, 'bin', `cloudflared-${CLOUDFLARED_VERSION}${process.platform === 'win32' ? '.exe' : ''}`);

/** Downloads the pinned cloudflared for this system into dataDir/bin, verifying its SHA-256. */
export async function downloadCloudflared(dataDir, { onProgress = () => {}, assets = ASSETS, baseUrl } = {}) {
  const asset = assets[`${process.platform}-${process.arch}`];
  if (!asset) {
    throw new Error(
      `There is no cloudflared download for ${process.platform}-${process.arch}. Install it by hand: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/`
    );
  }
  const dir = path.join(dataDir, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const url = `${baseUrl || `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`}/${asset.file}`;
  const tmp = path.join(dir, `${asset.file}.part`);

  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok || !res.body) throw new Error(`Could not download cloudflared (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(tmp);
  let done = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      done += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (total) onProgress(Math.min(1, done / total));
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw new Error(`The cloudflared download was interrupted: ${err.message}`);
  }

  if (hash.digest('hex') !== asset.sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error('The downloaded cloudflared did not match its expected fingerprint, so it was discarded. Try again later.');
  }

  const final = ownPath(dataDir);
  if (asset.tgz) {
    // macOS builds come as a .tgz holding a single "cloudflared" binary.
    const unpack = path.join(dir, `unpack-${CLOUDFLARED_VERSION}`);
    fs.rmSync(unpack, { recursive: true, force: true });
    fs.mkdirSync(unpack);
    await new Promise((resolve, reject) => execFile('tar', ['-xzf', tmp, '-C', unpack], (err) => (err ? reject(err) : resolve())));
    fs.renameSync(path.join(unpack, 'cloudflared'), final);
    fs.rmSync(unpack, { recursive: true, force: true });
    fs.rmSync(tmp, { force: true });
  } else {
    fs.renameSync(tmp, final);
  }
  fs.chmodSync(final, 0o755);
  return final;
}

let pending = null;

/** Returns a cloudflared path, downloading it once if needed (concurrent calls share one download). */
export async function ensureCloudflared(opts) {
  const found = findCloudflared(opts);
  if (found) return found;
  pending ||= downloadCloudflared(opts.dataDir, opts).finally(() => {
    pending = null;
  });
  return pending;
}
