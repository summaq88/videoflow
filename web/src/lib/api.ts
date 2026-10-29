import { sameOrigin, injectedToken, type Settings } from './settings';

export interface Quality { value: string; label: string }
export interface VideoInfo {
  id: string; extractor: string; videoKey: string; title: string; uploader: string | null;
  duration: number | null; thumbnail: string | null; webpageUrl: string | null; isLive: boolean;
  maxHeight: number | null; qualities: Quality[]; containers: string[]; audio: boolean;
  watermarkFreeAvailable: boolean | null; hasWatermarkedVariant: boolean;
}
export interface AnalyzeResult {
  url: string;
  platform: { id: string; name: string; notes: string };
  info: VideoInfo;
  alreadyDownloaded: { id: string; fileName: string } | null;
}
export type Status = 'queued' | 'analyzing' | 'downloading' | 'processing' | 'completed' | 'failed' | 'canceled' | 'paused' | 'skipped';
export interface Job {
  id: string; url: string; platform: string; title: string | null; uploader: string | null; thumbnail: string | null;
  duration: number | null; kind: 'video' | 'audio'; quality: string; container: string; status: Status;
  progress: number | null; downloaded: number; total: number | null; speed: number | null; eta: number | null;
  fileName: string | null; fileSize: number | null; error: string | null; errorCode: string | null; createdAt: number;
}
export interface HistoryItem {
  id: string; url: string; platform: string; title: string | null; uploader: string | null; thumbnail: string | null;
  duration: number | null; kind: string; quality: string; container: string; status: Status; file_name: string | null;
  file_size: number | null; error: string | null; created_at: number; completed_at: number | null; file_exists: boolean;
}
export interface Health {
  ok: boolean; version: string; ytdlp: string | null; ffmpeg: boolean; tokenRequired: boolean;
  platforms: { id: string; name: string; notes: string }[];
}

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number, public data?: unknown) { super(message); }
}

export function baseUrl(s: Settings) {
  return sameOrigin ? '' : s.serverUrl.replace(/\/+$/, '');
}
export function tokenOf(s: Settings) {
  return sameOrigin ? injectedToken : s.token.trim();
}

export function api(s: Settings) {
  const base = baseUrl(s);
  const token = tokenOf(s);
  async function req<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 120_000);
    let r: Response;
    try {
      r = await fetch(base + path, {
        method: init.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Access-Token': token } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new ApiError('OFFLINE', 'Cannot reach the VideoFlow server. Check Settings → Server.', 0);
    } finally {
      clearTimeout(timer);
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = (data as { error?: { code: string; message: string; duplicate?: unknown } }).error;
      throw new ApiError(err?.code || 'HTTP_' + r.status, err?.message || `Server error ${r.status}`, r.status, err?.duplicate);
    }
    return data as T;
  }
  const q = (extra = '') => `${token ? `token=${encodeURIComponent(token)}` : ''}${extra && token ? '&' : ''}${extra}`;
  return {
    health: () => req<Health>('/api/health', { timeoutMs: 8000 }),
    analyze: (url: string) => req<AnalyzeResult>('/api/analyze', { method: 'POST', body: { url } }),
    download: (b: { url: string; kind: string; quality: string; container: string; force?: boolean }) =>
      req<{ job: Job }>('/api/downloads', { method: 'POST', body: b }),
    batch: (b: { urls: string[]; kind: string; quality: string; container: string }) =>
      req<{ results: { url: string; job?: Job; error?: { code: string; message: string } }[] }>('/api/downloads/batch', { method: 'POST', body: b }),
    jobs: () => req<{ jobs: Job[] }>('/api/downloads'),
    action: (id: string, a: 'pause' | 'resume' | 'cancel' | 'retry') => req<{ job: Job }>(`/api/downloads/${id}/${a}`, { method: 'POST' }),
    history: (search = '') => req<{ items: HistoryItem[] }>(`/api/history?limit=200&q=${encodeURIComponent(search)}`),
    remove: (id: string, deleteFile: boolean) => req(`/api/history/${id}${deleteFile ? '?deleteFile=1' : ''}`, { method: 'DELETE' }),
    clearHistory: () => req('/api/history', { method: 'DELETE' }),
    fileUrl: (id: string, download = false) => `${base}/api/files/${id}?${q(download ? 'download=1' : '')}`,
    eventsUrl: () => `${base}/api/events?${q()}`,
  };
}
export type Api = ReturnType<typeof api>;

/** All http(s) links in pasted text. */
export function findUrls(text: string): string[] {
  const m = text.match(/https?:\/\/[^\s<>"'`]+/gi) || [];
  return [...new Set(m.map((u) => u.replace(/[),.;!?\]]+$/, '')))];
}
