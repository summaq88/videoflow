import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { rateLimit } from 'express-rate-limit';
import { AppError, assertPublicHost, extractUrls, safeFileName, sanitizeUrl } from './security.js';
import { detectProvider, listProviders } from './providers/index.js';
import * as store from './db.js';
import { config } from './config.js';

/**
 * Build the Express app.
 * deps: { manager, getInfo, token, webDir, versions, allowPrivate }
 */
export function createApp({ manager, getInfo, token = '', webDir = config.webDir, versions = {}, allowPrivate = config.allowPrivateHosts, lookup }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '64kb' }));

  // CORS: the HTML file, the Android app and the browser UI may all live on other origins.
  // Access is protected by the token below instead of by origin.
  app.use('/api', (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-Access-Token');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  // Health is public so the app can say "server found, token needed".
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, name: 'VideoFlow', ...versions, tokenRequired: Boolean(token), platforms: listProviders() });
  });

  // Token check (header, or ?token= for <video> / EventSource / download links which cannot send headers)
  app.use('/api', (req, res, next) => {
    if (!token) return next();
    const given = req.get('X-Access-Token') || req.query.token;
    if (given === token) return next();
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Access token missing or wrong. Enter it in Settings.' } });
  });

  const limiter = (max) => rateLimit({
    windowMs: 60_000, limit: max, standardHeaders: 'draft-8', legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a minute.' } }),
  });
  app.use('/api', limiter(600));

  /** Validate URL → pick provider → normalize → SSRF check. */
  async function resolveUrl(input) {
    const u = sanitizeUrl(input);
    const provider = detectProvider(u);
    const normalized = provider.normalize(u);
    await assertPublicHost(normalized.hostname, { allowPrivate, ...(lookup ? { lookup } : {}) });
    return { url: normalized.href, provider };
  }

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  app.post('/api/analyze', limiter(40), wrap(async (req, res) => {
    const { url, provider } = await resolveUrl(req.body?.url);
    const info = await getInfo(url, provider);
    const dup = manager.findDuplicate({ videoKey: info.videoKey, kind: 'video', quality: 'best', container: 'mp4' });
    res.json({
      url,
      platform: { id: provider.id, name: provider.name, notes: provider.notes },
      info,
      alreadyDownloaded: dup?.type === 'completed' ? { id: dup.job.id, fileName: dup.job.file_name } : null,
    });
  }));

  const analyzeCache = new Map(); // url → { info, at } avoids re-fetching right after Analyze
  const origAnalyze = getInfo;
  getInfo = async (url, provider) => {
    const hit = analyzeCache.get(url);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.info;
    const info = await origAnalyze(url, provider);
    analyzeCache.set(url, { info, at: Date.now() });
    if (analyzeCache.size > 200) analyzeCache.delete(analyzeCache.keys().next().value);
    return info;
  };
  manager.getInfo = getInfo;

  app.post('/api/downloads', limiter(40), wrap(async (req, res) => {
    const { kind, quality, container, force } = req.body || {};
    const { url, provider } = await resolveUrl(req.body?.url);
    const cached = analyzeCache.get(url);
    const job = manager.add({ url, provider, meta: cached?.info || null, kind, quality, container, force: Boolean(force) });
    res.status(201).json({ job });
  }));

  app.post('/api/downloads/batch', limiter(10), wrap(async (req, res) => {
    const { kind, quality, container, force } = req.body || {};
    const text = Array.isArray(req.body?.urls) ? req.body.urls.join('\n') : String(req.body?.urls || '');
    const urls = extractUrls(text).slice(0, 50);
    if (!urls.length) throw new AppError('EMPTY_URL', 'No links found. Paste one link per line.');
    const results = [];
    for (const raw of urls) {
      try {
        const { url, provider } = await resolveUrl(raw);
        const cached = analyzeCache.get(url);
        results.push({ url: raw, job: manager.add({ url, provider, meta: cached?.info || null, kind, quality, container, force: Boolean(force) }) });
      } catch (e) {
        results.push({ url: raw, error: { code: e.code || 'FAILED', message: e.message } });
      }
    }
    res.status(201).json({ results });
  }));

  app.get('/api/downloads', (req, res) => {
    res.json({ jobs: manager.list() });
  });

  for (const action of ['pause', 'resume', 'cancel', 'retry']) {
    app.post(`/api/downloads/:id/${action}`, wrap(async (req, res) => {
      res.json({ job: manager[action](req.params.id) });
    }));
  }

  // Live updates (Server-Sent Events)
  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(`event: snapshot\ndata: ${JSON.stringify(manager.list())}\n\n`);
    let pending = new Map();
    let timer = null;
    const flush = () => {
      timer = null;
      for (const j of pending.values()) res.write(`event: job\ndata: ${JSON.stringify(j)}\n\n`);
      pending = new Map();
    };
    const onJob = (j) => {
      pending.set(j.id, j); // throttle: at most ~4 updates/sec per job
      if (!timer) timer = setTimeout(flush, 250);
    };
    manager.on('job', onJob);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      manager.off('job', onJob);
      clearInterval(ping);
      if (timer) clearTimeout(timer);
    });
  });

  app.get('/api/history', (req, res) => {
    const rows = store.listHistory({ q: req.query.q, limit: req.query.limit, offset: req.query.offset });
    res.json({
      items: rows.map((r) => ({ ...r, file_exists: Boolean(r.file_path && fs.existsSync(r.file_path)) })),
    });
  });

  app.delete('/api/history/:id', wrap(async (req, res) => {
    const row = store.getDownload(req.params.id);
    if (!row) throw new AppError('NOT_FOUND', 'Not found.', 404);
    if (['queued', 'analyzing', 'downloading', 'processing'].includes(row.status)) {
      throw new AppError('BAD_STATE', 'Cancel the download first.', 409);
    }
    if (req.query.deleteFile === '1' && row.file_path && isInside(row.file_path, config.downloadDir)) {
      fs.rmSync(row.file_path, { force: true });
    }
    store.deleteDownload(row.id);
    manager.jobs.delete(row.id);
    res.json({ ok: true });
  }));

  app.delete('/api/history', (req, res) => {
    store.clearHistory();
    res.json({ ok: true });
  });

  // Stream a finished file (supports Range for the video player); ?download=1 saves it.
  app.get('/api/files/:id', (req, res, next) => {
    const row = store.getDownload(req.params.id);
    if (!row || row.status !== 'completed' || !row.file_path) return next(new AppError('NOT_FOUND', 'File not found.', 404));
    if (!isInside(row.file_path, manager.downloadDir) || !fs.existsSync(row.file_path)) {
      return next(new AppError('FILE_MISSING', 'The file was moved or deleted from the downloads folder.', 410));
    }
    const name = safeFileName(row.file_name || path.basename(row.file_path));
    const disp = req.query.download === '1' ? 'attachment' : 'inline';
    res.set('Content-Disposition', `${disp}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.sendFile(path.resolve(row.file_path), { dotfiles: 'allow', acceptRanges: true }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint.' } }));

  // Web UI (built single-file React app). The token is injected so the same-origin UI just works.
  const indexFile = path.join(webDir, 'index.html');
  app.get(['/', '/index.html'], (req, res, next) => {
    fs.readFile(indexFile, 'utf8', (err, html) => {
      if (err) return res.type('text').send('VideoFlow API is running. Build the web app (cd web && npm run build) to get the interface.');
      const meta = `<meta name="vf-same-origin" content="1"><meta name="vf-token" content="${token}">`;
      res.type('html').set('Cache-Control', 'no-store').send(html.replace('<head>', `<head>${meta}`));
    });
  });

  // Errors → consistent JSON
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') err = new AppError('BAD_JSON', 'Invalid request body.');
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500 && err.code !== 'NETWORK') console.error(err);
    res.status(status).json({
      error: {
        code: err.code || 'INTERNAL',
        message: status === 500 && !err.code ? 'Something went wrong on the server.' : err.message,
        ...(err.duplicate ? { duplicate: err.duplicate } : {}),
      },
    });
  });

  return app;
}

export function isInside(file, dir) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
