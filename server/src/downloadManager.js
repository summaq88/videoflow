import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as store from './db.js';
import { AppError } from './security.js';
import { buildFormat, getInfo as realGetInfo, hasFfmpeg, startDownload as realStart } from './ytdlp.js';

const ACTIVE = new Set(['queued', 'analyzing', 'downloading', 'processing']);

export class DownloadManager extends EventEmitter {
  constructor({ getInfo = realGetInfo, startDownload = realStart, maxConcurrent = config.maxConcurrent,
    maxRetries = config.maxRetries, downloadDir = config.downloadDir, tempRoot = path.join(config.dataDir, 'tmp') } = {}) {
    super();
    this.getInfo = getInfo;
    this.startDownload = startDownload;
    this.maxConcurrent = maxConcurrent;
    this.maxRetries = maxRetries;
    this.downloadDir = downloadDir;
    this.tempRoot = tempRoot;
    this.jobs = new Map(); // id -> live job (in memory while active/paused)
    this.queue = [];
    this.running = 0;
  }

  /** Public view of a job (no internal handles). */
  view(job) {
    const { child, provider, meta, ...rest } = job;
    return rest;
  }

  list() {
    return [...this.jobs.values()].map((j) => this.view(j));
  }

  persist(job) {
    store.upsertDownload({
      id: job.id, url: job.url, video_key: job.videoKey, platform: job.platform, title: job.title,
      uploader: job.uploader, thumbnail: job.thumbnail, duration: job.duration, kind: job.kind,
      quality: job.quality, container: job.container, status: job.status, file_path: job.filePath,
      file_name: job.fileName, file_size: job.fileSize, error: job.error, error_code: job.errorCode,
      created_at: job.createdAt, completed_at: job.completedAt,
    });
  }

  update(job, patch) {
    Object.assign(job, patch);
    this.emit('job', this.view(job));
  }

  /** Duplicate check: an identical finished download whose file still exists, or the same job already active. */
  findDuplicate({ videoKey, kind, quality, container }) {
    if (!videoKey) return null;
    for (const j of this.jobs.values()) {
      if (j.videoKey === videoKey && j.kind === kind && j.quality === quality && j.container === container && ACTIVE.has(j.status)) {
        return { type: 'active', job: this.view(j) };
      }
    }
    const done = store.findCompletedDuplicate({ videoKey, kind, quality, container });
    if (done && done.file_path && fs.existsSync(done.file_path)) return { type: 'completed', job: done };
    return null;
  }

  /**
   * Queue a download.
   * opts: { url, provider, meta?, kind, quality, container, force }
   */
  add({ url, provider, meta = null, kind = 'video', quality = 'best', container = 'mp4', force = false }) {
    kind = kind === 'audio' ? 'audio' : 'video';
    container = kind === 'audio' ? 'mp3' : (container === 'webm' ? 'webm' : 'mp4');
    quality = kind === 'audio' ? 'audio' : (/^(best|\d{3,4})$/.test(String(quality)) ? String(quality) : 'best');

    if (meta && !force) {
      const dup = this.findDuplicate({ videoKey: meta.videoKey, kind, quality, container });
      if (dup) throw new AppError('DUPLICATE', 'You already downloaded this video in the same quality.', 409, { duplicate: dup });
    }

    const job = {
      id: crypto.randomUUID(),
      url,
      provider,
      platform: provider.id,
      meta,
      videoKey: meta?.videoKey || null,
      title: meta?.title || null,
      uploader: meta?.uploader || null,
      thumbnail: meta?.thumbnail || null,
      duration: meta?.duration ?? null,
      kind, quality, container, force,
      status: 'queued',
      progress: null, downloaded: 0, total: null, speed: null, eta: null,
      attempts: 0,
      filePath: null, fileName: null, fileSize: null,
      error: null, errorCode: null,
      createdAt: Date.now(), completedAt: null,
    };
    this.jobs.set(job.id, job);
    this.persist(job);
    this.queue.push(job.id);
    this.emit('job', this.view(job));
    this.pump();
    return this.view(job);
  }

  pump() {
    while (this.running < this.maxConcurrent && this.queue.length) {
      const id = this.queue.shift();
      const job = this.jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      this.running++;
      this.run(job).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  tempDirFor(job) {
    return path.join(this.tempRoot, job.id);
  }

  async run(job) {
    try {
      // 1) Metadata (batch downloads arrive without it)
      if (!job.meta) {
        this.update(job, { status: 'analyzing' });
        job.meta = await this.getInfo(job.url, job.provider);
        Object.assign(job, {
          videoKey: job.meta.videoKey, title: job.meta.title, uploader: job.meta.uploader,
          thumbnail: job.meta.thumbnail, duration: job.meta.duration,
        });
        if (!job.force) {
          const dup = this.findDuplicate({ videoKey: job.videoKey, kind: job.kind, quality: job.quality, container: job.container });
          if (dup && dup.job.id !== job.id) {
            this.update(job, { status: 'skipped', error: 'Already downloaded in this quality (duplicate skipped).', errorCode: 'DUPLICATE' });
            this.finish(job);
            return;
          }
        }
        if (job.status !== 'analyzing') return; // paused/canceled meanwhile
      }
      if (job.meta?.isLive) throw new AppError('LIVE', 'Live streams cannot be downloaded while they are live.', 422);

      // 2) Download
      const tempDir = this.tempDirFor(job);
      fs.mkdirSync(tempDir, { recursive: true });
      fs.mkdirSync(this.downloadDir, { recursive: true });
      const tag = job.kind === 'audio' ? 'audio' : (job.quality === 'best' ? 'best' : `${job.quality}p`);
      const format = buildFormat({
        quality: job.quality, container: job.container, kind: job.kind,
        clean: job.provider.cleanFilter, ffmpeg: hasFfmpeg(),
      });
      this.update(job, { status: 'downloading', error: null, errorCode: null });
      this.persist(job);

      const { child, done } = this.startDownload({
        url: job.url, format, container: job.container, kind: job.kind, provider: job.provider,
        homeDir: this.downloadDir, tempDir,
        outTemplate: `%(extractor_key)s_%(title).80B_%(id)s_${tag}.%(ext)s`,
        onProgress: (p) => {
          if (p.processing) return this.update(job, { status: 'processing', progress: 100 });
          this.update(job, { progress: p.percent, downloaded: p.downloaded, total: p.total, speed: p.speed, eta: p.eta });
        },
      });
      job.child = child;
      const { filepath } = await done;
      job.child = null;

      const stat = fs.statSync(filepath);
      this.update(job, {
        status: 'completed', progress: 100, speed: null, eta: null,
        filePath: filepath, fileName: path.basename(filepath), fileSize: stat.size, completedAt: Date.now(),
      });
      fs.rmSync(tempDir, { recursive: true, force: true });
      this.finish(job);
    } catch (e) {
      job.child = null;
      if (job.status === 'paused' || job.status === 'canceled') return; // user action, not an error
      if (e.transient && job.attempts < this.maxRetries) {
        job.attempts++;
        this.update(job, { status: 'queued', error: `Retrying (${job.attempts}/${this.maxRetries})…` });
        await new Promise((r) => setTimeout(r, 1500 * job.attempts));
        if (job.status === 'queued') this.queue.push(job.id);
        return;
      }
      this.update(job, { status: 'failed', error: e.message, errorCode: e.code || 'FAILED', speed: null, eta: null });
      this.finish(job);
    }
  }

  finish(job) {
    this.persist(job);
    // Keep finished jobs visible briefly in the live list, then rely on history.
    setTimeout(() => {
      const j = this.jobs.get(job.id);
      if (j && !ACTIVE.has(j.status) && j.status !== 'paused') this.jobs.delete(job.id);
    }, 60_000).unref?.();
  }

  get(id) {
    const j = this.jobs.get(id);
    if (!j) throw new AppError('NOT_FOUND', 'Download not found.', 404);
    return j;
  }

  pause(id) {
    const job = this.get(id);
    if (!ACTIVE.has(job.status)) throw new AppError('BAD_STATE', 'Only active downloads can be paused.', 409);
    this.update(job, { status: 'paused', speed: null, eta: null });
    this.queue = this.queue.filter((q) => q !== id);
    job.child?.kill('SIGTERM'); // partial file is kept; resume continues it
    this.persist(job);
    return this.view(job);
  }

  resume(id) {
    let job = this.jobs.get(id);
    if (!job) job = this.restoreFromDb(id);
    if (job.status !== 'paused') throw new AppError('BAD_STATE', 'Only paused downloads can be resumed.', 409);
    this.update(job, { status: 'queued', error: null });
    this.queue.push(id);
    this.persist(job);
    this.pump();
    return this.view(job);
  }

  retry(id) {
    let job = this.jobs.get(id) || this.restoreFromDb(id);
    if (!['failed', 'canceled', 'skipped'].includes(job.status)) throw new AppError('BAD_STATE', 'Only failed downloads can be retried.', 409);
    this.update(job, { status: 'queued', error: null, errorCode: null, attempts: 0, progress: null, force: true });
    this.queue.push(id);
    this.persist(job);
    this.pump();
    return this.view(job);
  }

  cancel(id) {
    let job = this.jobs.get(id);
    if (!job) job = this.restoreFromDb(id);
    if (!ACTIVE.has(job.status) && job.status !== 'paused') throw new AppError('BAD_STATE', 'This download is not active.', 409);
    this.update(job, { status: 'canceled', speed: null, eta: null });
    this.queue = this.queue.filter((q) => q !== id);
    job.child?.kill('SIGTERM');
    const dir = this.tempDirFor(job);
    setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 1500).unref?.();
    this.finish(job);
    return this.view(job);
  }

  restoreFromDb(id, providerLookup = this.providerLookup) {
    const row = store.getDownload(id);
    if (!row) throw new AppError('NOT_FOUND', 'Download not found.', 404);
    const provider = providerLookup(row.url);
    const job = {
      id: row.id, url: row.url, provider, platform: row.platform,
      meta: row.video_key ? { videoKey: row.video_key, title: row.title, uploader: row.uploader, thumbnail: row.thumbnail, duration: row.duration } : null,
      videoKey: row.video_key, title: row.title, uploader: row.uploader, thumbnail: row.thumbnail, duration: row.duration,
      kind: row.kind, quality: row.quality, container: row.container, force: true,
      status: row.status, progress: null, downloaded: 0, total: null, speed: null, eta: null, attempts: 0,
      filePath: row.file_path, fileName: row.file_name, fileSize: row.file_size,
      error: row.error, errorCode: row.error_code, createdAt: row.created_at, completedAt: row.completed_at,
    };
    this.jobs.set(id, job);
    return job;
  }

  /** Remove temp folders that no active job owns and are older than the limit. */
  cleanupTemp(maxAgeMs = config.tempMaxAgeMs) {
    let removed = 0;
    let entries = [];
    try { entries = fs.readdirSync(this.tempRoot); } catch { return 0; }
    for (const name of entries) {
      const j = this.jobs.get(name);
      if (j && (ACTIVE.has(j.status) || j.status === 'paused')) continue;
      const p = path.join(this.tempRoot, name);
      try {
        const st = fs.statSync(p);
        if (Date.now() - st.mtimeMs > maxAgeMs) {
          fs.rmSync(p, { recursive: true, force: true });
          removed++;
        }
      } catch { /* ignore */ }
    }
    return removed;
  }
}
