// cloudflared download: works offline against a local server standing in for GitHub.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { downloadCloudflared, findCloudflared, CLOUDFLARED_VERSION } from '../desktop/cloudflared.js';

const BODY = Buffer.from('#!/bin/sh\necho fake cloudflared\n');
const GOOD = crypto.createHash('sha256').update(BODY).digest('hex');
const key = `${process.platform}-${process.arch}`;
let server, baseUrl;

before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': BODY.length });
    res.end(BODY);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codev-cf-'));

test('a download that matches its fingerprint is installed and found again', async () => {
  const dataDir = tmpDir();
  const progress = [];
  const bin = await downloadCloudflared(dataDir, {
    baseUrl,
    assets: { [key]: { file: 'cloudflared-test', sha256: GOOD } },
    onProgress: (p) => progress.push(p),
  });
  assert.ok(bin.endsWith(`cloudflared-${CLOUDFLARED_VERSION}${process.platform === 'win32' ? '.exe' : ''}`));
  assert.deepEqual(fs.readFileSync(bin), BODY);
  assert.equal(progress.at(-1), 1);
  if (process.platform !== 'win32') assert.ok(fs.statSync(bin).mode & 0o100, 'it is executable');
  assert.equal(findCloudflared({ PATH: '', dataDir }), bin, 'the next time it is found without downloading');
});

test('a download that does not match is thrown away', async () => {
  const dataDir = tmpDir();
  await assert.rejects(
    downloadCloudflared(dataDir, { baseUrl, assets: { [key]: { file: 'cloudflared-test', sha256: '0'.repeat(64) } } }),
    /did not match its expected fingerprint/
  );
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'bin')), [], 'nothing is left behind');
  assert.equal(findCloudflared({ PATH: '', dataDir }), null);
});

test("the user's own cloudflared on PATH comes first", () => {
  const dir = tmpDir();
  const exe = path.join(dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  fs.writeFileSync(exe, 'x');
  assert.equal(findCloudflared({ PATH: dir, dataDir: tmpDir() }), exe);
});
