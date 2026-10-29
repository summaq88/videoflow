import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { openDb } from '../src/db.js';
import { DownloadManager } from '../src/downloadManager.js';
import { createApp } from '../src/app.js';
import { AppError } from '../src/security.js';
import { detectProvider } from '../src/providers/index.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-test-'));
const downloadDir = path.join(tmp, 'dl');
fs.mkdirSync(downloadDir, { recursive: true });
openDb(':memory:');

const meta = (id = 'v1') => ({ videoKey: `youtube:${id}`, title: `Video ${id}`, uploader: 'u', thumbnail: null, duration: 10, qualities: [] });

/** Fake downloader: emits progress, writes a file, can be killed. */
function fakeStart({ failTimes = 0, transient = true, slow = false } = {}) {
  let calls = 0;
  const fn = ({ homeDir, outTemplate, onProgress }) => {
    calls++;
    const child = new EventEmitter();
    let killed = false;
    child.kill = () => { killed = true; child.emit('killed'); };
    const done = new Promise((resolve, reject) => {
      child.on('killed', () => reject(new AppError('KILLED', 'stopped', 499)));
      const steps = slow ? 40 : 3;
      let i = 0;
      const tick = () => {
        if (killed) return;
        i++;
        onProgress({ downloaded: i * 10, total: steps * 10, speed: 1000, eta: steps - i, percent: Math.round((i / steps) * 100) });
        if (i < steps) return setTimeout(tick, 10);
        if (calls <= failTimes) return reject(new AppError('NETWORK', 'net', 503, { transient }));
        const fp = path.join(homeDir, outTemplate.replace(/%\([^)]+\)s/g, 'x').replace('.80B', ''));
        fs.writeFileSync(fp, 'video-bytes');
        resolve({ filepath: fp });
      };
      setTimeout(tick, 5);
    });
    return { child, done };
  };
  fn.calls = () => calls;
  return fn;
}

const waitFor = async (cond, ms = 3000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const provider = detectProvider(new URL('https://youtube.com'));
const mk = (opts = {}) => {
  const m = new DownloadManager({ downloadDir, tempRoot: path.join(tmp, 'tmp'), getInfo: async () => meta('auto'), ...opts });
  m.providerLookup = (u) => detectProvider(new URL(u));
  return m;
};

test('download completes with real progress values and a file on disk', async () => {
  const m = mk({ startDownload: fakeStart() });
  const seen = [];
  m.on('job', (j) => seen.push(j.progress));
  const job = m.add({ url: 'https://youtube.com/watch?v=a', provider, meta: meta('a') });
  await waitFor(() => m.jobs.get(job.id).status === 'completed');
  const j = m.jobs.get(job.id);
  assert.ok(fs.existsSync(j.filePath));
  assert.equal(j.fileSize, 'video-bytes'.length);
  assert.ok(seen.includes(100));
});

test('duplicate detection blocks the same video+quality, force overrides', async () => {
  const m = mk({ startDownload: fakeStart() });
  const a = m.add({ url: 'https://youtube.com/watch?v=d', provider, meta: meta('d') });
  await waitFor(() => m.jobs.get(a.id).status === 'completed');
  assert.throws(() => m.add({ url: 'https://youtube.com/watch?v=d', provider, meta: meta('d') }), { code: 'DUPLICATE' });
  assert.doesNotThrow(() => m.add({ url: 'https://youtube.com/watch?v=d', provider, meta: meta('d'), quality: '720' }));
  assert.doesNotThrow(() => m.add({ url: 'https://youtube.com/watch?v=d', provider, meta: meta('d'), force: true }));
});

test('transient errors are retried automatically', async () => {
  const start = fakeStart({ failTimes: 1 });
  const m = mk({ startDownload: start, maxRetries: 2 });
  const job = m.add({ url: 'https://youtube.com/watch?v=r', provider, meta: meta('r') });
  await waitFor(() => m.jobs.get(job.id).status === 'completed', 6000);
  assert.equal(start.calls(), 2);
});

test('permanent errors fail with a readable message, retry() re-runs', async () => {
  const m = mk({ startDownload: fakeStart({ failTimes: 1, transient: false }) });
  const job = m.add({ url: 'https://youtube.com/watch?v=f', provider, meta: meta('f') });
  await waitFor(() => m.jobs.get(job.id).status === 'failed');
  assert.equal(m.jobs.get(job.id).errorCode, 'NETWORK');
  m.retry(job.id);
  await waitFor(() => m.jobs.get(job.id).status === 'completed');
});

test('pause, resume and cancel', async () => {
  const m = mk({ startDownload: fakeStart({ slow: true }) });
  const job = m.add({ url: 'https://youtube.com/watch?v=p', provider, meta: meta('p') });
  await waitFor(() => m.jobs.get(job.id).status === 'downloading');
  m.pause(job.id);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(m.jobs.get(job.id).status, 'paused');
  m.resume(job.id);
  await waitFor(() => m.jobs.get(job.id).status === 'downloading');
  m.cancel(job.id);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(m.jobs.get(job.id).status, 'canceled');
  assert.throws(() => m.pause(job.id), { code: 'BAD_STATE' });
});

test('concurrency limit is respected', async () => {
  const m = mk({ startDownload: fakeStart({ slow: true }), maxConcurrent: 2 });
  const ids = ['c1', 'c2', 'c3'].map((id) => m.add({ url: `https://youtube.com/watch?v=${id}`, provider, meta: meta(id) }).id);
  await waitFor(() => m.running === 2);
  assert.equal(m.jobs.get(ids[2]).status, 'queued');
  ids.forEach((id) => m.cancel(id));
});

// ---------- HTTP API ----------
async function withServer(fn, { token = 'secret', getInfo } = {}) {
  const m = mk({ startDownload: fakeStart() });
  const app = createApp({
    manager: m, token, webDir: path.join(tmp, 'noweb'),
    // Offline-safe DNS for tests: real hostnames resolve to a public documentation-free IP.
    lookup: async (host) => [{ address: host === 'evil-rebind.example' ? '10.0.0.5' : '93.184.216.34' }],
    getInfo: getInfo || (async (url) => ({ ...meta(new URL(url).searchParams.get('v') || 'x'), qualities: [{ value: 'best', label: 'Original' }] })),
  });
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = (p, opts = {}) => fetch(base + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Access-Token': token } : {}), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  try { await fn({ call, base, m }); } finally { srv.close(); }
}

test('API: health is public, everything else needs the token', () => withServer(async ({ base }) => {
  assert.equal((await fetch(base + '/api/health')).status, 200);
  const r = await fetch(base + '/api/history');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, 'UNAUTHORIZED');
  assert.equal((await fetch(base + '/api/history?token=secret')).status, 200);
}));

test('API: analyze validates, blocks SSRF and returns preview data', () => withServer(async ({ call }) => {
  let r = await call('/api/analyze', { method: 'POST', body: { url: 'http://169.254.169.254/latest/meta-data' } });
  assert.equal(r.status, 403);
  r = await call('/api/analyze', { method: 'POST', body: { url: 'http://localhost/api/history' } });
  assert.equal(r.status, 403);
  r = await call('/api/analyze', { method: 'POST', body: { url: 'http://localhost:8787/api/history' } });
  assert.equal((await r.json()).error.code, 'INVALID_PORT');
  r = await call('/api/analyze', { method: 'POST', body: { url: 'https://evil-rebind.example/video' } });
  assert.equal((await r.json()).error.code, 'BLOCKED_HOST');
  r = await call('/api/analyze', { method: 'POST', body: { url: 'hello' } });
  assert.equal((await r.json()).error.code, 'INVALID_URL');
  r = await call('/api/analyze', { method: 'POST', body: { url: 'https://youtu.be/abc12345' } });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.platform.id, 'youtube');
  assert.equal(j.url, 'https://www.youtube.com/watch?v=abc12345');
  assert.equal(j.info.title, 'Video abc12345');
}));

test('API: platform errors come back as clear messages', () => withServer(async ({ call }) => {
  const r = await call('/api/analyze', { method: 'POST', body: { url: 'https://youtu.be/gone1234' } });
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error.code, 'PRIVATE');
}, { getInfo: async () => { throw new AppError('PRIVATE', 'This video is private.', 422); } }));

test('API: download, duplicate 409, batch, history, file streaming with Range', () => withServer(async ({ call, base, m }) => {
  let r = await call('/api/analyze', { method: 'POST', body: { url: 'https://youtu.be/api11111' } });
  assert.equal(r.status, 200);
  r = await call('/api/downloads', { method: 'POST', body: { url: 'https://youtu.be/api11111', quality: 'best', container: 'mp4' } });
  assert.equal(r.status, 201);
  const { job } = await r.json();
  await waitFor(() => m.jobs.get(job.id)?.status === 'completed');

  r = await call('/api/downloads', { method: 'POST', body: { url: 'https://youtu.be/api11111', quality: 'best', container: 'mp4' } });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error.code, 'DUPLICATE');

  r = await call('/api/downloads/batch', { method: 'POST', body: { urls: 'https://youtu.be/bat11111\nnot-a-link\nhttps://x.com/a/status/5', quality: '720' } });
  const batch = await r.json();
  assert.equal(batch.results.length, 2);
  assert.ok(batch.results.every((x) => x.job));

  r = await call('/api/history');
  const { items } = await r.json();
  assert.ok(items.some((i) => i.id === job.id && i.file_exists));

  r = await fetch(`${base}/api/files/${job.id}?token=secret`, { headers: { Range: 'bytes=0-4' } });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), 'video');
  r = await fetch(`${base}/api/files/${job.id}?token=secret&download=1`);
  assert.match(r.headers.get('content-disposition'), /^attachment/);
}));

test('API: unknown routes and bad JSON', () => withServer(async ({ call, base }) => {
  assert.equal((await call('/api/nope')).status, 404);
  const r = await fetch(base + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Access-Token': 'secret' }, body: '{bad' });
  assert.equal(r.status, 400);
}));
