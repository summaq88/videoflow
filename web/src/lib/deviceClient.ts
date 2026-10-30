// On-device client for the Android app: same interface as the server client,
// but downloads run inside the phone through the VideoFlowNative plugin (yt-dlp + ffmpeg).
import { CapacitorHttp, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { ApiError, findUrls, type AnalyzeResult, type Health, type HistoryItem, type Job, type VideoInfo } from './api';
import { EngineError, PLATFORMS, GENERIC, buildFormat, detectPlatform, friendlyError, normalize, parseUrl, summarize, type Platform } from './engine';

interface NativeResult { name: string; size: number; mime: string; uri: string; path: string }
interface NativePlugin {
  status(): Promise<{ ready: boolean; version: string; jsRuntime?: boolean; updating?: boolean }>;
  info(o: { url: string; mode: InfoMode; timeout: number }): Promise<{ json: string; infoPath?: string; mode?: InfoMode }>;
  download(o: { id: string; url: string; format: string; kind: string; container: string; tag: string; attempt: number; infoPath?: string; mode?: InfoMode }): Promise<NativeResult>;
  getShared(): Promise<{ text: string | null }>;
  stop(o: { id: string; keep: boolean }): Promise<void>;
  update(): Promise<{ status: string; version: string }>;
  open(o: { uri: string; mime: string }): Promise<void>;
  share(o: { uri: string; mime: string }): Promise<void>;
  remove(o: { uri: string }): Promise<void>;
  accounts(): Promise<Record<string, boolean>>;
  login(o: { site: string }): Promise<Record<string, boolean> & { signedIn: boolean }>;
  logout(o: { site: string }): Promise<Record<string, boolean>>;
  addListener(ev: 'progress', cb: (e: { id: string; progress: number; eta: number; processing: boolean; line: string }) => void): Promise<PluginListenerHandle>;
  addListener(ev: 'shared', cb: (e: { text: string }) => void): Promise<PluginListenerHandle>;
}

type InfoMode = 'fast' | 'full';

export interface PlatformCheck { platform: string; url: string; state: 'running' | 'ok' | 'fail'; seconds?: number; detail?: string }
// Public test videos (from yt-dlp's own test suite), one per supported platform.
export const PLATFORM_CHECKS: PlatformCheck[] = [
  { platform: 'YouTube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', state: 'running' },
  { platform: 'Instagram', url: 'https://www.instagram.com/reel/Chunk8-jurw/', state: 'running' },
  { platform: 'TikTok', url: 'https://www.tiktok.com/@leenabhushan/video/6748451240264420610', state: 'running' },
  { platform: 'Facebook', url: 'https://www.facebook.com/radiokicksfm/videos/3676516585958356/', state: 'running' },
  { platform: 'X / Twitter', url: 'https://x.com/captainamerica/status/719944021058060289', state: 'running' },
  { platform: 'Pinterest', url: 'https://www.pinterest.com/pin/664281013778109217/', state: 'running' },
  { platform: 'Snapchat', url: 'https://www.snapchat.com/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYYWtidGhudGZpAX1TKn0JAX1TKnXJAAAAAA', state: 'running' },
];
// Fast lookup (no JavaScript solving) normally answers in a few seconds; the full one can take minutes on a phone.
const FAST_TIMEOUT_S = 45;
const FULL_TIMEOUT_S = 240;
const SLOW_MSG = 'Reading this video took too long. Check your internet connection and tap Retry.';
const withTimeout = <T,>(p: Promise<T>, ms: number, msg: string) => new Promise<T>((res, rej) => {
  const t = setTimeout(() => rej(new ApiError('TIMEOUT', msg, 504)), ms);
  p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});
// `web` is only used for automated UI tests (window.__vfMock); the real engine is the Android plugin.
const Native = registerPlugin<NativePlugin>('VideoFlowNative', {
  web: () => (window as unknown as { __vfMock?: NativePlugin }).__vfMock as NativePlugin,
});

type Stored = HistoryItem & { uri?: string; mime?: string; path?: string; video_key?: string | null };
const HKEY = 'videoflow.device.history.v1';
const ACTIVE = ['queued', 'analyzing', 'downloading', 'processing'];
const MAX_CONCURRENT = 2;

const loadHistory = (): Stored[] => { try { return JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch { return []; } };
const saveHistory = (h: Stored[]) => { try { localStorage.setItem(HKEY, JSON.stringify(h.slice(0, 500))); } catch { /* full */ } };

const UNITS: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, KB: 1e3, MB: 1e6, GB: 1e9 };
const toBytes = (n: string, u: string) => Number(n) * (UNITS[u] || 1);

type Live = Job & { videoKey: string | null; platformObj: Platform; info: VideoInfo | null; attempts: number; force: boolean; strategy: number };

function wrap(e: unknown, platformId = ''): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof EngineError) return new ApiError(e.code, e.message, 422);
  const msg = (e as { message?: string })?.message || String(e);
  const fe = friendlyError(msg, platformId);
  return new ApiError(fe.code, fe.message, 422);
}

class DeviceClient {
  readonly mode = 'device' as const;
  private jobMap = new Map<string, Live>();
  private queue: string[] = [];
  private running = 0;
  private listeners = new Set<(j: Job) => void>();
  private infoCache = new Map<string, { info: VideoInfo; platform: Platform; at: number; infoPath?: string; mode: InfoMode }>();
  private inflight = new Map<string, Promise<VideoInfo>>(); // one info lookup per link at a time
  private permAsked = false;

  constructor() {
    void Native.addListener('progress', (e) => {
      const j = this.jobMap.get(e.id);
      if (!j || !ACTIVE.includes(j.status)) return;
      if (e.processing) return this.update(j, { status: 'processing', progress: 100, speed: null, eta: null });
      const line = e.line || '';
      const tot = line.match(/of\s+~?\s*([\d.]+)\s*([KMG]i?B|B)\b/);
      const spd = line.match(/at\s+([\d.]+)\s*([KMG]i?B|B)\/s/);
      const total = tot ? toBytes(tot[1], tot[2]) : j.total;
      const progress = Number.isFinite(e.progress) && e.progress >= 0 ? Math.min(100, Math.round(e.progress * 10) / 10) : j.progress;
      this.update(j, {
        status: 'downloading', progress, total,
        downloaded: total && progress != null ? Math.round((total * progress) / 100) : j.downloaded,
        speed: spd ? toBytes(spd[1], spd[2]) : j.speed,
        eta: e.eta >= 0 ? e.eta : null,
      });
    });
  }

  subscribe(cb: (j: Job) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private view(j: Live): Job {
    const { platformObj, info, attempts, force, strategy, ...rest } = j; // eslint-disable-line @typescript-eslint/no-unused-vars
    return rest;
  }

  private update(j: Live, patch: Partial<Live>) {
    Object.assign(j, patch);
    const v = this.view(j);
    this.listeners.forEach((cb) => cb(v));
  }

  async health(): Promise<Health> {
    const s = await Native.status();
    return {
      ok: true, version: '2.0', ytdlp: s.version || 'built-in', ffmpeg: true, tokenRequired: false,
      platforms: [...PLATFORMS, GENERIC].map(({ id, name, notes }) => ({ id, name, notes })),
    };
  }

  async updateEngine() {
    try { return await Native.update(); } catch (e) { throw wrap(e); }
  }

  // ---- Accounts: sign in to a site so videos it shows only to signed-in users work ----
  async accounts(): Promise<Record<string, boolean>> {
    try { return await Native.accounts(); } catch { return {}; }
  }

  async login(site: string): Promise<boolean> {
    const r = await Native.login({ site });
    this.infoCache.clear(); // links that failed before may work now
    return !!r.signedIn;
  }

  async logout(site: string): Promise<Record<string, boolean>> {
    const r = await Native.logout({ site });
    this.infoCache.clear();
    return r;
  }

  /** Reads one public test video per platform on this phone and reports the result of each. */
  async checkPlatforms(onResult: (r: PlatformCheck) => void): Promise<PlatformCheck[]> {
    const out: PlatformCheck[] = [];
    for (const c of PLATFORM_CHECKS) {
      onResult({ ...c, state: 'running' });
      const t0 = Date.now();
      let r: PlatformCheck;
      try {
        this.infoCache.delete(c.url);
        const { url, platform } = await this.resolve(c.url);
        this.infoCache.delete(url);
        const info = await this.getInfo(url, platform);
        r = { ...c, state: 'ok', seconds: (Date.now() - t0) / 1000, detail: info.maxHeight ? `${info.maxHeight}p` : 'OK' };
      } catch (e) {
        r = { ...c, state: 'fail', seconds: (Date.now() - t0) / 1000, detail: wrap(e).message };
      }
      out.push(r);
      onResult(r);
    }
    return out;
  }

  private async resolve(input: string) {
    const u = parseUrl(input);
    const platform = detectPlatform(u);
    return { url: normalize(u, platform), platform };
  }

  private async readInfo(url: string, platform: Platform, mode: InfoMode) {
    const timeout = mode === 'fast' ? FAST_TIMEOUT_S : FULL_TIMEOUT_S;
    let r: { json: string; infoPath?: string };
    try {
      // The native side stops yt-dlp itself at `timeout`; the extra margin here is only a safety net.
      // (+60 s covers waiting for a background engine update, which is not part of the native timeout.)
      r = await withTimeout(Native.info({ url, mode, timeout }), (timeout + 60) * 1000, SLOW_MSG);
    } catch (e) {
      if ((e as { code?: string })?.code === 'TIMEOUT') throw new ApiError('TIMEOUT', SLOW_MSG, 504);
      throw wrap(e, platform.id);
    }
    let raw: unknown;
    try { raw = JSON.parse(r.json); } catch { throw new ApiError('FAILED', 'The website returned data we could not read.', 502); }
    return { info: summarize(raw, platform), infoPath: r.infoPath, mode };
  }

  private getInfo(url: string, platform: Platform): Promise<VideoInfo> {
    const hit = this.infoCache.get(url);
    if (hit && Date.now() - hit.at < 10 * 60_000) return Promise.resolve(hit.info);
    const running = this.inflight.get(url);
    if (running) return running;
    const p = (async () => {
      let got: { info: VideoInfo; infoPath?: string; mode: InfoMode } | null = null;
      let firstErr: ApiError | null = null;
      const isWeak = (g: typeof got) => !g || !(g.info.maxHeight && g.info.maxHeight > 360);
      try { got = await this.readInfo(url, platform, 'fast'); } catch (e) { firstErr = wrap(e); }
      const final = firstErr && (['PRIVATE', 'UNAVAILABLE', 'UNSUPPORTED', 'DRM'].includes(firstErr.code) || firstErr.code.startsWith('SIGN_IN'));
      // YouTube sometimes answers the fast method with 360p only; asking again usually gives the full list.
      if (platform.id === 'youtube' && got && isWeak(got)) {
        try { const again = await this.readInfo(url, platform, 'fast'); if (!isWeak(again)) got = again; } catch { /* keep first */ }
      }
      // Only when the fast method failed completely, use the full (slow, JavaScript) method.
      if (platform.id === 'youtube' && !got && !final) {
        try { got = await this.readInfo(url, platform, 'full'); } catch (e) {
          if (!got) throw firstErr && firstErr.code !== 'TIMEOUT' ? firstErr : wrap(e);
        }
      }
      if (!got) throw wrap(firstErr);
      this.infoCache.set(url, { info: got.info, platform, at: Date.now(), infoPath: got.infoPath, mode: got.mode });
      return got.info;
    })();
    this.inflight.set(url, p);
    p.finally(() => this.inflight.delete(url)).catch(() => {});
    return p;
  }

  /**
   * Instant preview (title + thumbnail in about a second) from the site's public oEmbed endpoint,
   * shown while the full video info is still loading. Returns null when the site has no oEmbed.
   */
  async preview(input: string): Promise<AnalyzeResult | null> {
    let url: string; let platform: Platform;
    try { ({ url, platform } = await this.resolve(input)); } catch (e) { throw wrap(e); }
    const hit = this.infoCache.get(url);
    if (hit) return this.result(url, platform, hit.info);
    const endpoint = platform.id === 'youtube' ? 'https://www.youtube.com/oembed?format=json&url='
      : platform.id === 'tiktok' ? 'https://www.tiktok.com/oembed?url=' : null;
    if (!endpoint) return null;
    try {
      const r = await withTimeout(CapacitorHttp.get({ url: endpoint + encodeURIComponent(url), connectTimeout: 8000, readTimeout: 8000 }), 9000, 'timeout');
      if (r.status !== 200) return null;
      const d = (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as { title?: string; author_name?: string; thumbnail_url?: string };
      if (!d?.title) return null;
      const id = platform.id === 'youtube' ? new URL(url).searchParams.get('v') : (url.match(/\/video\/(\d+)/) || [])[1];
      const extractor = platform.id === 'youtube' ? 'Youtube' : 'TikTok';
      const std = ['1080', '720', '480', '360'];
      const info: VideoInfo = {
        id: id || '', extractor, videoKey: id ? `${extractor.toLowerCase()}:${id}` : '', title: d.title, uploader: d.author_name || null,
        duration: null, thumbnail: d.thumbnail_url || null, webpageUrl: url, isLive: false, maxHeight: null,
        qualities: [{ value: 'best', label: 'Best available' }, ...std.map((q) => ({ value: q, label: q === '1080' ? '1080p Full HD' : q === '720' ? '720p HD' : `${q}p` }))],
        containers: ['mp4', 'webm'], audio: true, watermarkFreeAvailable: null, hasWatermarkedVariant: false,
      };
      return { ...this.result(url, platform, info), partial: true } as AnalyzeResult;
    } catch {
      return null;
    }
  }

  private result(url: string, platform: Platform, info: VideoInfo): AnalyzeResult {
    const dup = info.videoKey ? loadHistory().find((h) => h.video_key === info.videoKey && h.status === 'completed') : null;
    return {
      url, platform: { id: platform.id, name: platform.name, notes: platform.notes }, info,
      alreadyDownloaded: dup ? { id: dup.id, fileName: dup.file_name || '' } : null,
    };
  }

  /** Link shared to VideoFlow from another app (Android share sheet). */
  async takeShared(): Promise<string | null> {
    try { return (await Native.getShared()).text || null; } catch { return null; }
  }

  onShared(cb: (text: string) => void) {
    void Native.addListener('shared', (e) => e?.text && cb(e.text));
  }

  private findDuplicate(key: string | null | undefined, kind: string, quality: string, container: string, exceptId?: string) {
    if (!key) return null;
    for (const j of this.jobMap.values()) {
      if (j.id !== exceptId && j.videoKey === key && j.kind === kind && j.quality === quality && j.container === container && ACTIVE.includes(j.status)) return j;
    }
    return loadHistory().find((h) => h.video_key === key && h.kind === kind && h.quality === quality && h.container === container && h.status === 'completed') || null;
  }

  async analyze(input: string): Promise<AnalyzeResult> {
    try {
      const { url, platform } = await this.resolve(input);
      const info = await this.getInfo(url, platform);
      return this.result(url, platform, info);
    } catch (e) { throw wrap(e); }
  }

  private add(url: string, platform: Platform, b: { kind: string; quality: string; container: string; force?: boolean }): Job {
    const kind = b.kind === 'audio' ? 'audio' : 'video';
    const container = kind === 'audio' ? 'mp3' : (b.container === 'webm' ? 'webm' : 'mp4');
    const quality = kind === 'audio' ? 'audio' : (/^(best|\d{3,4})$/.test(b.quality) ? b.quality : 'best');
    const info = this.infoCache.get(url)?.info || null;
    if (info && !b.force && this.findDuplicate(info.videoKey, kind, quality, container)) {
      throw new ApiError('DUPLICATE', 'You already downloaded this video in the same quality.', 409);
    }
    const j: Live = {
      id: (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^\w-]/g, ''),
      url, platform: platform.id, platformObj: platform, info,
      videoKey: info?.videoKey || null, title: info?.title || null, uploader: info?.uploader || null,
      thumbnail: info?.thumbnail || null, duration: info?.duration ?? null,
      kind, quality, container, status: 'queued', progress: null, downloaded: 0, total: null, speed: null, eta: null,
      fileName: null, fileSize: null, error: null, errorCode: null, createdAt: Date.now(), attempts: 0, force: Boolean(b.force), strategy: 0,
    } as Live;
    this.jobMap.set(j.id, j);
    this.queue.push(j.id);
    this.update(j, {});
    this.pump();
    return this.view(j);
  }

  async download(b: { url: string; kind: string; quality: string; container: string; force?: boolean }) {
    try {
      const { url, platform } = await this.resolve(b.url);
      await this.askStorage();
      return { job: this.add(url, platform, b) };
    } catch (e) { throw wrap(e); }
  }

  async batch(b: { urls: string[]; kind: string; quality: string; container: string }) {
    await this.askStorage();
    const results: { url: string; job?: Job; error?: { code: string; message: string } }[] = [];
    for (const raw of findUrls(b.urls.join('\n')).slice(0, 50)) {
      try {
        const { url, platform } = await this.resolve(raw);
        results.push({ url: raw, job: this.add(url, platform, b) });
      } catch (e) {
        const w = wrap(e);
        results.push({ url: raw, error: { code: w.code, message: w.message } });
      }
    }
    return { results };
  }

  /** Android 9 and older need storage permission to save into Download/. */
  private async askStorage() {
    if (this.permAsked) return;
    this.permAsked = true;
    try {
      const { Filesystem } = await import('@capacitor/filesystem');
      const p = await Filesystem.checkPermissions();
      if (p.publicStorage !== 'granted') await Filesystem.requestPermissions();
    } catch { /* not needed on newer Android */ }
  }

  private pump() {
    while (this.running < MAX_CONCURRENT && this.queue.length) {
      const j = this.jobMap.get(this.queue.shift()!);
      if (!j || j.status !== 'queued') continue;
      this.running++;
      void this.run(j).finally(() => { this.running--; this.pump(); });
    }
  }

  private async run(j: Live) {
    try {
      if (!j.info) {
        this.update(j, { status: 'analyzing' });
        const info = await this.getInfo(j.url, j.platformObj);
        Object.assign(j, { info, videoKey: info.videoKey, title: info.title, uploader: info.uploader, thumbnail: info.thumbnail, duration: info.duration });
        if (j.status !== 'analyzing') return;
        if (!j.force && this.findDuplicate(info.videoKey, j.kind, j.quality, j.container, j.id)) {
          this.update(j, { status: 'skipped', error: 'Already downloaded in this quality (duplicate skipped).', errorCode: 'DUPLICATE' });
          return;
        }
      }
      if (j.info?.isLive) throw new ApiError('LIVE', 'Live streams cannot be downloaded while they are live.', 422);
      this.update(j, { status: 'downloading', error: null, errorCode: null });
      const tag = j.kind === 'audio' ? 'audio' : (j.quality === 'best' ? 'best' : `${j.quality}p`);
      const r = await Native.download({
        id: j.id, url: j.url, kind: j.kind, container: j.container, tag, attempt: j.strategy,
        infoPath: j.strategy === 0 ? this.infoCache.get(j.url)?.infoPath : undefined,
        mode: this.infoCache.get(j.url)?.mode || 'fast',
        format: buildFormat({ quality: j.quality, container: j.container, kind: j.kind, clean: j.platformObj.clean }),
      });
      this.update(j, { status: 'completed', progress: 100, speed: null, eta: null, fileName: r.name, fileSize: r.size });
      this.record(j, { uri: r.uri, mime: r.mime, path: r.path });
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (j.status === 'paused' || j.status === 'canceled' || code === 'CANCELED') return;
      const raw = (e as { message?: string })?.message || '';
      // YouTube "403 Forbidden": try other ways of fetching the video before giving up.
      if (/\b403\b|forbidden/i.test(raw) && j.strategy < 2) {
        j.strategy++;
        this.update(j, { status: 'queued', error: `Trying another method (${j.strategy}/2)…`, progress: null });
        if (j.status === 'queued') this.queue.push(j.id);
        return;
      }
      const w = wrap(e);
      if (w.code === 'NETWORK' && j.attempts < 2) {
        j.attempts++;
        this.update(j, { status: 'queued', error: `Retrying (${j.attempts}/2)…` });
        await new Promise((res) => setTimeout(res, 1500 * j.attempts));
        if (j.status === 'queued') this.queue.push(j.id);
        return;
      }
      this.update(j, { status: 'failed', error: w.message, errorCode: w.code, speed: null, eta: null });
      this.record(j);
    }
  }

  private record(j: Live, extra: { uri?: string; mime?: string; path?: string } = {}) {
    const h = loadHistory().filter((x) => x.id !== j.id);
    h.unshift({
      id: j.id, url: j.url, platform: j.platform, title: j.title, uploader: j.uploader, thumbnail: j.thumbnail,
      duration: j.duration, kind: j.kind, quality: j.quality, container: j.container, status: j.status,
      file_name: j.fileName, file_size: j.fileSize, error: j.error, created_at: j.createdAt,
      completed_at: Date.now(), file_exists: j.status === 'completed', video_key: j.videoKey, ...extra,
    });
    saveHistory(h);
  }

  async jobs() {
    return { jobs: [...this.jobMap.values()].map((j) => this.view(j)) };
  }

  async action(id: string, a: 'pause' | 'resume' | 'cancel' | 'retry') {
    let j = this.jobMap.get(id);
    if (!j && a === 'retry') {
      const h = loadHistory().find((x) => x.id === id);
      if (!h) throw new ApiError('NOT_FOUND', 'Download not found.', 404);
      const u = parseUrl(h.url);
      j = { ...(h as unknown as Live), platformObj: detectPlatform(u), info: null, attempts: 0, force: true, fileName: null, fileSize: null,
        createdAt: h.created_at, strategy: 0, progress: null, downloaded: 0, total: null, speed: null, eta: null, errorCode: null, videoKey: h.video_key || null } as Live;
      this.jobMap.set(id, j);
    }
    if (!j) throw new ApiError('NOT_FOUND', 'Download not found.', 404);
    if (a === 'pause') {
      if (!ACTIVE.includes(j.status)) throw new ApiError('BAD_STATE', 'Only active downloads can be paused.', 409);
      this.update(j, { status: 'paused', speed: null, eta: null });
      this.queue = this.queue.filter((q) => q !== id);
      await Native.stop({ id, keep: true });
    } else if (a === 'resume') {
      if (j.status !== 'paused') throw new ApiError('BAD_STATE', 'Only paused downloads can be resumed.', 409);
      this.update(j, { status: 'queued', error: null });
      this.queue.push(id);
      this.pump();
    } else if (a === 'cancel') {
      this.update(j, { status: 'canceled', speed: null, eta: null });
      this.queue = this.queue.filter((q) => q !== id);
      await Native.stop({ id, keep: false });
      this.record(j);
    } else {
      this.update(j, { status: 'queued', error: null, errorCode: null, attempts: 0, strategy: 0, progress: null, force: true });
      this.queue.push(id);
      this.pump();
    }
    return { job: this.view(j) };
  }

  async history(search = '') {
    const q = search.trim().toLowerCase();
    const items = loadHistory().filter((h) => !q || [h.title, h.url, h.platform].some((x) => (x || '').toLowerCase().includes(q)));
    return { items: items as HistoryItem[] };
  }

  async remove(id: string, deleteFile: boolean) {
    const h = loadHistory();
    const item = h.find((x) => x.id === id);
    if (deleteFile && item?.uri) await Native.remove({ uri: item.uri }).catch(() => {});
    saveHistory(h.filter((x) => x.id !== id));
    this.jobMap.delete(id);
    return { ok: true };
  }

  async clearHistory() {
    saveHistory(loadHistory().filter((x) => ACTIVE.includes(x.status)));
    return { ok: true };
  }

  private item(id: string) {
    const it = loadHistory().find((x) => x.id === id);
    if (!it?.uri) throw new ApiError('NOT_FOUND', 'File not found.', 404);
    return it;
  }

  async open(id: string) { const it = this.item(id); await Native.open({ uri: it.uri!, mime: it.mime || 'video/*' }); }
  async share(id: string) { const it = this.item(id); await Native.share({ uri: it.uri!, mime: it.mime || 'video/*' }); }
  fileUrl() { return ''; }
  eventsUrl() { return ''; }
}

let instance: DeviceClient | null = null;
export const deviceClient = () => (instance ||= new DeviceClient());
export type { DeviceClient };
