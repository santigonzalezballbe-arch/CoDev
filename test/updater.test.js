import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, installKind, pickAsset, checkLatest } from '../desktop/updater.js';

test('compareVersions orders by number, not text', () => {
  assert.ok(compareVersions('0.4.10', '0.4.9') > 0);
  assert.ok(compareVersions('v0.5.0', '0.4.2') > 0);
  assert.equal(compareVersions('v0.4.2', '0.4.2'), 0);
  assert.ok(compareVersions('0.4', '0.4.1') < 0);
});

test('installKind follows how this copy was installed', () => {
  const k = (o) => installKind({ packaged: true, arch: 'x64', ...o });
  assert.equal(k({ platform: 'linux', appImage: '/home/a/CoDev.AppImage' }), 'appimage');
  assert.equal(k({ platform: 'linux' }), 'deb');
  assert.equal(k({ platform: 'win32' }), 'nsis');
  assert.equal(k({ platform: 'darwin', arch: 'arm64' }), 'dmg');
  assert.equal(k({ platform: 'darwin' }), 'page'); // no Intel build
  assert.equal(installKind({ platform: 'linux', packaged: false }), 'page'); // from source
});

test('pickAsset matches the release file names', () => {
  const assets = ['CoDev-0.5.0-amd64.deb', 'CoDev-0.5.0-arm64.dmg', 'CoDev-0.5.0-x86_64.AppImage', 'CoDev-Setup-0.5.0.exe'].map(
    (name) => ({ name })
  );
  assert.equal(pickAsset(assets, 'appimage').name, 'CoDev-0.5.0-x86_64.AppImage');
  assert.equal(pickAsset(assets, 'deb').name, 'CoDev-0.5.0-amd64.deb');
  assert.equal(pickAsset(assets, 'nsis').name, 'CoDev-Setup-0.5.0.exe');
  assert.equal(pickAsset(assets, 'dmg').name, 'CoDev-0.5.0-arm64.dmg');
  assert.equal(pickAsset(assets, 'page'), null);
});

test('checkLatest reports only a newer, published release', async () => {
  const rel = (o) => async () => ({ ok: true, json: async () => ({ tag_name: 'v0.5.0', assets: [], ...o }) });
  assert.equal((await checkLatest('0.4.2', { fetchImpl: rel() })).version, '0.5.0');
  assert.equal(await checkLatest('0.5.0', { fetchImpl: rel() }), null);
  assert.equal(await checkLatest('0.4.2', { fetchImpl: rel({ prerelease: true }) }), null);
});

test('checkLatest falls back to the release page when the API is rate-limited', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, auth: opts.headers?.Authorization });
    if (url.includes('api.github.com')) return { ok: false, status: 403 };
    return { status: 302, url, headers: { get: (h) => (h === 'location' ? 'https://github.com/x/y/releases/tag/v0.5.0' : null) } };
  };
  const found = await checkLatest('0.4.13', { fetchImpl, token: 'tok' });
  assert.equal(calls[0].auth, 'Bearer tok');
  assert.equal(found.version, '0.5.0');
  assert.equal(pickAsset(found.assets, 'nsis').url, 'https://github.com/santigonzalezballbe-arch/CoDev/releases/download/v0.5.0/CoDev-Setup-0.5.0.exe');
  assert.equal(await checkLatest('0.5.0', { fetchImpl }), null);
});
