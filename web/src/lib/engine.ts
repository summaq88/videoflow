// Shared download logic used by the on-device engine (Android app).
// Mirrors server/src/providers + server/src/ytdlp.js so both behave the same.
import type { Quality, VideoInfo } from './api';

export interface Platform { id: string; name: string; hosts: string[]; notes: string; clean?: string }

export const PLATFORMS: Platform[] = [
  { id: 'youtube', name: 'YouTube', hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'], notes: 'Public videos and Shorts. Private, members-only and paid (DRM) videos cannot be downloaded.' },
  { id: 'instagram', name: 'Instagram', hosts: ['instagram.com', 'instagr.am'], notes: 'Public Reels, videos and posts. Age-restricted reels: sign in to Instagram in Settings → Accounts. Private accounts are not supported.' },
  { id: 'tiktok', name: 'TikTok', hosts: ['tiktok.com'], notes: 'Public videos. The platform’s own clean playback file is used when TikTok provides it.', clean: '[format_note!*=watermark]' },
  { id: 'snapchat', name: 'Snapchat', hosts: ['snapchat.com'], notes: 'Public Spotlight videos and public Stories only.' },
  { id: 'facebook', name: 'Facebook', hosts: ['facebook.com', 'fb.watch', 'fb.com'], notes: 'Videos, Reels, Watch, posts and group videos (incl. share links). Private or group videos: sign in to Facebook in Settings → Accounts; you can download what your account can watch.' },
  { id: 'x', name: 'X / Twitter', hosts: ['x.com', 'twitter.com'], notes: 'Public posts with video.' },
  { id: 'pinterest', name: 'Pinterest', hosts: ['pinterest.com', 'pin.it'], notes: 'Video Pins.' },
];
export const GENERIC: Platform = { id: 'generic', name: 'Other website', hosts: [], notes: 'Works on many sites with public video. Not every site is supported.' };

export class EngineError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function parseUrl(input: string): URL {
  const raw = (input || '').trim();
  if (!raw) throw new EngineError('EMPTY_URL', 'Paste a video link first.');
  const m = raw.match(/https?:\/\/[^\s<>"'`]+/i);
  let u: URL;
  try { u = new URL((m ? m[0] : raw).replace(/[),.;!?\]]+$/, '')); } catch { throw new EngineError('INVALID_URL', 'That does not look like a valid link.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new EngineError('INVALID_SCHEME', 'Only http and https links are supported.');
  u.hash = '';
  return u;
}

export function detectPlatform(u: URL): Platform {
  const h = u.hostname.toLowerCase().replace(/^www\./, '');
  return PLATFORMS.find((p) => p.hosts.some((d) => h === d || h.endsWith('.' + d))) || GENERIC;
}

/** Short share links that redirect to the real post (resolved on the phone before reading the video). */
export function isShortLink(u: URL): boolean {
  const h = u.hostname.toLowerCase();
  return h === 'fb.watch' || h.endsWith('.fb.watch') || ((h.endsWith('facebook.com') || h.endsWith('fb.com')) && u.pathname.startsWith('/share/'));
}

export function normalize(u: URL, p: Platform): string {
  const out = new URL(u.href);
  for (const k of [...out.searchParams.keys()]) {
    if (p.id === 'youtube' && ['v', 't', 'list'].includes(k)) continue;
    if (p.id === 'facebook' && ['v', 'story_fbid', 'id', 'fbid', 'set'].includes(k)) continue;
    if (/^(utm_|fbclid|gclid|igsh|igshid|si$|feature$|_r$|_t$|is_from_webapp|sender_device|share_|ref|mibextid|rdid|__cft__|__tn__|paipv|eav|_rdr|comment_id|notif_)/i.test(k)) out.searchParams.delete(k);
  }
  if (p.id === 'youtube') {
    const s = out.pathname.match(/^\/shorts\/([\w-]{6,})/);
    if (s) return `https://www.youtube.com/watch?v=${s[1]}`;
    if (out.hostname.endsWith('youtu.be')) {
      const id = out.pathname.slice(1).split('/')[0];
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
  }
  return out.href;
}

const STANDARD = [360, 480, 720, 1080, 1440, 2160, 4320];
const LABEL: Record<number, string> = { 360: '360p', 480: '480p', 720: '720p HD', 1080: '1080p Full HD', 1440: '2K', 2160: '4K', 4320: '8K' };
const qLabel = (h: number) => LABEL[h] || `${h}p`;

interface Fmt { vcodec?: string; acodec?: string; height?: number; ext?: string; format_note?: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function summarize(raw: any, p: Platform): VideoInfo {
  let info = raw;
  if (info?._type === 'playlist') {
    info = (info.entries || []).find(Boolean);
    if (!info) throw new EngineError('NO_VIDEO', 'No video was found at this link.');
  }
  const formats: Fmt[] = Array.isArray(info.formats) && info.formats.length ? info.formats : [info];
  const video = formats.filter((f) => (f.vcodec && f.vcodec !== 'none') || (f.height && f.vcodec !== 'none'));
  const heights = [...new Set(video.map((f) => f.height).filter((h): h is number => Number.isFinite(h) && (h as number) > 0))].sort((a, b) => a - b);
  const maxH = heights.at(-1) || null;
  const steps = heights.map((x) => STANDARD.find((h) => Math.abs(x - h) <= h * 0.1) || x);
  const qualities: Quality[] = [...new Set(steps)].sort((a, b) => b - a).map((h) => ({ value: String(h), label: qLabel(h) }));
  const extractor = String(info.extractor_key || info.extractor || p.name);
  return {
    id: String(info.id ?? ''),
    extractor,
    videoKey: `${extractor.toLowerCase()}:${info.id}`,
    title: info.title || info.fulltitle || 'Untitled video',
    uploader: info.uploader || info.channel || info.creator || null,
    duration: Number.isFinite(info.duration) ? Math.round(info.duration) : null,
    thumbnail: info.thumbnail || (info.thumbnails || []).at(-1)?.url || null,
    webpageUrl: info.webpage_url || null,
    isLive: Boolean(info.is_live),
    maxHeight: maxH,
    qualities: [{ value: 'best', label: maxH ? `Original (${qLabel(maxH)})` : 'Original' }, ...qualities],
    containers: ['mp4', 'webm'],
    audio: formats.some((f) => f.acodec && f.acodec !== 'none'),
    watermarkFreeAvailable: p.clean ? formats.some((f) => f.vcodec !== 'none' && !/watermark/i.test(f.format_note || '')) : null,
    hasWatermarkedVariant: formats.some((f) => /watermark/i.test(f.format_note || '')),
  };
}

export function buildFormat({ quality = 'best', container = 'mp4', kind = 'video', clean = '' }: { quality?: string; container?: string; kind?: string; clean?: string }) {
  if (kind === 'audio') return 'ba/b';
  const h = quality !== 'best' && /^\d{3,4}$/.test(quality) ? `[height<=${quality}]` : '';
  const parts = [
    container === 'webm' ? `bv*${h}${clean}[ext=webm]+ba[ext=webm]` : `bv*${h}${clean}[ext=mp4]+ba[ext=m4a]`,
    `bv*${h}${clean}+ba`, `b${h}${clean}[ext=${container}]`, `b${h}${clean}`,
  ];
  if (clean) parts.push(`b${h}`);
  parts.push('b');
  return [...new Set(parts)].join('/');
}

/** Sites where VideoFlow can sign in (Settings → Accounts) to open videos shown only to signed-in users. */
export const SIGN_IN_SITES: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', x: 'X / Twitter' };

export function friendlyError(msg = '', platformId = '', signedIn = false): EngineError {
  const s = msg.toLowerCase();
  const site = SIGN_IN_SITES[platformId];
  // Facebook hides private and group videos behind its login page; yt-dlp then reports "cannot parse data" / "no video formats".
  const fbHidden = platformId === 'facebook' && /cannot parse data|no video formats found|unsupported url|unable to extract|registered users|log in|login/.test(s);
  if (fbHidden && signedIn) {
    return new EngineError('NO_ACCESS', 'Your Facebook account cannot open this video. It may be shared only with people you are not connected to, from a group you are not in, deleted, or the link is not a video. Open it in the Facebook app to check, then copy the link again.');
  }
  if (fbHidden) {
    return new EngineError('SIGN_IN:facebook', 'Facebook did not show this video publicly. If it is a private or group video that you can watch, sign in to Facebook in VideoFlow, then try again.');
  }
  if (site && /isn't available to everyone|can't be seen by certain audiences|age.?restrict|only available for registered users|login required|log in|sign in|restricted|rate-limit reached|requested content is not available|nsfw|sensitive/.test(s)) {
    return new EngineError(`SIGN_IN:${platformId}`, `${site} only shows this video to signed-in users (age-restricted or limited audience). Sign in to ${site} in VideoFlow, then try again.`);
  }
  if (/drm|widevine/.test(s)) return new EngineError('DRM', 'This video is DRM-protected. Protected content cannot be downloaded.');
  if (/private video|this account is private|is private|protected tweet/.test(s)) return new EngineError('PRIVATE', 'This video is private. Only public videos can be downloaded.');
  if (/sign in|log ?in|login required|cookies|not a bot|rate-limit/.test(s)) return new EngineError('LOGIN_REQUIRED', 'The platform asked for a login or bot check for this video. Try again later, or try Settings → Update engine.');
  if (/\b403\b|forbidden/.test(s)) return new EngineError('FORBIDDEN', 'The site refused this download (403). Open Settings → Update engine, then tap Retry.');
  if (/unsupported url/.test(s)) return new EngineError('UNSUPPORTED', 'This website or link type is not supported.');
  if (/no video formats|no video could be found|there is no video|requested format is not available/.test(s)) return new EngineError('NO_VIDEO', 'No downloadable video was found at this link (or not in the chosen quality).');
  if (/video unavailable|has been removed|not available|404|does not exist|deleted/.test(s)) return new EngineError('UNAVAILABLE', 'This video is unavailable – it may have been deleted or blocked in your region.');
  if (/timed out|timeout|connection|network|temporary failure|unable to resolve|ssl/.test(s)) return new EngineError('NETWORK', 'Network problem. Check your internet and try again.');
  const last = msg.trim().split('\n').filter((l) => /error/i.test(l)).pop() || msg.split('\n')[0] || '';
  return new EngineError('FAILED', `Could not process this video. ${last.replace(/^ERROR:\s*/i, '').slice(0, 200)}`.trim());
}
