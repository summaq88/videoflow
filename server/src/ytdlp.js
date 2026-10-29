import { spawn, spawnSync } from 'node:child_process';
import { config } from './config.js';
import { AppError } from './security.js';

let ffmpegAvailable = null;
export function hasFfmpeg() {
  if (ffmpegAvailable === null) {
    const bin = config.ffmpegPath || 'ffmpeg';
    try {
      ffmpegAvailable = spawnSync(bin, ['-version'], { timeout: 10_000 }).status === 0;
    } catch {
      ffmpegAvailable = false;
    }
  }
  return ffmpegAvailable;
}

export function ytdlpVersion() {
  try {
    const r = spawnSync(config.ytdlpPath, ['--version'], { encoding: 'utf8', timeout: 15_000 });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** Map yt-dlp stderr into a friendly, actionable error. */
export function mapYtdlpError(stderr = '', provider) {
  const s = stderr.toLowerCase();
  const hint = (code, fallback) => provider?.errorHints?.[code] || fallback;
  if (/drm|widevine|protected by/.test(s)) {
    return new AppError('DRM', 'This video is DRM-protected. Protected content cannot be downloaded.', 422);
  }
  if (/private video|this account is private|is private|protected tweet/.test(s)) {
    return new AppError('PRIVATE', 'This video is private. Only public videos can be downloaded.', 422);
  }
  if (/sign in|log ?in|login required|cookies|confirm you.re not a bot|rate-limit reached|requested content is not available, rate-limit/.test(s)) {
    return new AppError('LOGIN_REQUIRED', hint('LOGIN_REQUIRED', 'The platform requires a login for this video, so it cannot be downloaded here.'), 422);
  }
  if (/unsupported url/.test(s)) {
    return new AppError('UNSUPPORTED', 'This website or link type is not supported.', 422);
  }
  if (/no video formats|no video could be found|there is no video|requested format is not available/.test(s)) {
    return new AppError('NO_VIDEO', 'No downloadable video was found at this link (or not in the chosen quality).', 422);
  }
  if (/video unavailable|has been removed|not available|404|does not exist|deleted/.test(s)) {
    return new AppError('UNAVAILABLE', 'This video is unavailable – it may have been deleted, expired, or blocked in your region.', 422);
  }
  if (/geo|country|region/.test(s)) {
    return new AppError('GEO_BLOCKED', 'This video is not available in your region.', 422);
  }
  if (/timed out|timeout|connection|network|temporary failure|errno|ssl/.test(s)) {
    return new AppError('NETWORK', 'Network problem while contacting the website. Please try again.', 503, { transient: true });
  }
  if (/enoent|not recognized|command not found/.test(s)) {
    return new AppError('YTDLP_MISSING', 'The download engine (yt-dlp) is not installed on the server. See the README.', 500);
  }
  const last = stderr.trim().split('\n').filter((l) => /error/i.test(l)).pop() || '';
  return new AppError('FAILED', `Could not process this video. ${last.replace(/^ERROR:\s*/i, '').slice(0, 200)}`.trim(), 422);
}

function run(args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(config.ytdlpPath, args, { windowsHide: true });
    } catch (e) {
      return reject(new AppError('YTDLP_MISSING', 'The download engine (yt-dlp) is not installed on the server.', 500));
    }
    let out = '';
    let err = '';
    const timer = timeoutMs ? setTimeout(() => { child.kill('SIGKILL'); err += '\nERROR: timed out'; }, timeoutMs) : null;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { if (timer) clearTimeout(timer); err += `\n${e.code || e.message}`; resolve({ code: -1, out, err }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, out, err }); });
  });
}

const baseArgs = () => {
  const a = ['--no-playlist', '--no-warnings', '--ignore-config', '--no-mtime'];
  if (config.ffmpegPath) a.push('--ffmpeg-location', config.ffmpegPath);
  return a;
};

/** Fetch metadata only (no download). */
export async function getInfo(url, provider) {
  const { code, out, err } = await run([...baseArgs(), '-J', '--skip-download', '--', url], { timeoutMs: config.infoTimeoutMs });
  if (code !== 0) throw mapYtdlpError(err, provider);
  let info;
  try {
    info = JSON.parse(out);
  } catch {
    throw new AppError('FAILED', 'The website returned data we could not read.', 502);
  }
  if (info._type === 'playlist') {
    const first = (info.entries || []).find(Boolean);
    if (!first) throw new AppError('NO_VIDEO', 'No video was found at this link.', 422);
    info = first;
  }
  return summarizeInfo(info, provider);
}

const STANDARD = [360, 480, 720, 1080, 1440, 2160, 4320];
const LABEL = { 360: '360p', 480: '480p', 720: '720p HD', 1080: '1080p Full HD', 1440: '2K', 2160: '4K', 4320: '8K' };

export function qualityLabel(h) {
  return LABEL[h] || `${h}p`;
}

/** Reduce the huge yt-dlp JSON to what the UI needs (real data only). */
export function summarizeInfo(info, provider) {
  const formats = Array.isArray(info.formats) && info.formats.length ? info.formats : [info];
  const video = formats.filter((f) => f.vcodec && f.vcodec !== 'none' || (f.height && f.vcodec !== 'none'));
  const heights = [...new Set(video.map((f) => f.height).filter((h) => Number.isFinite(h) && h > 0))].sort((a, b) => a - b);
  const maxH = heights.at(-1) || null;

  // Offer only resolutions the source really has (snapped to the standard name when close, e.g. 1072 → 1080).
  const steps = heights.map((x) => STANDARD.find((h) => Math.abs(x - h) <= h * 0.1) || x);
  const qualities = [...new Set(steps)].sort((a, b) => b - a).map((h) => ({ value: String(h), label: qualityLabel(h) }));

  const hasAudio = formats.some((f) => f.acodec && f.acodec !== 'none');
  const exts = [...new Set(video.map((f) => f.ext).filter(Boolean))];
  const watermarked = formats.filter((f) => /watermark/i.test(f.format_note || ''));
  const cleanAvailable = provider?.cleanFilter ? formats.some((f) => f.vcodec !== 'none' && !/watermark/i.test(f.format_note || '')) : null;

  return {
    id: String(info.id ?? ''),
    extractor: info.extractor_key || info.extractor || provider?.name,
    videoKey: `${(info.extractor_key || info.extractor || 'x').toLowerCase()}:${info.id}`,
    title: info.title || info.fulltitle || 'Untitled video',
    uploader: info.uploader || info.channel || info.creator || null,
    duration: Number.isFinite(info.duration) ? Math.round(info.duration) : null,
    thumbnail: info.thumbnail || (info.thumbnails || []).at(-1)?.url || null,
    webpageUrl: info.webpage_url || null,
    isLive: Boolean(info.is_live),
    maxHeight: maxH,
    qualities: [{ value: 'best', label: maxH ? `Original (${qualityLabel(maxH)})` : 'Original' }, ...qualities],
    containers: ['mp4', 'webm'],
    sourceExts: exts,
    audio: hasAudio,
    watermarkFreeAvailable: cleanAvailable,
    hasWatermarkedVariant: watermarked.length > 0,
  };
}

/**
 * Build the yt-dlp -f selector.
 * quality: 'best' | '1080' | ... ; container: 'mp4' | 'webm' ; kind: 'video' | 'audio'
 */
export function buildFormat({ quality = 'best', container = 'mp4', kind = 'video', clean = '', ffmpeg = true }) {
  if (kind === 'audio') return 'ba/b';
  const h = quality !== 'best' && /^\d{3,4}$/.test(quality) ? `[height<=${quality}]` : '';
  const c = clean || '';
  const parts = [];
  if (ffmpeg) {
    if (container === 'webm') parts.push(`bv*${h}${c}[ext=webm]+ba[ext=webm]`);
    else parts.push(`bv*${h}${c}[ext=mp4]+ba[ext=m4a]`);
    parts.push(`bv*${h}${c}+ba`);
  }
  parts.push(`b${h}${c}[ext=${container}]`, `b${h}${c}`);
  if (c) parts.push(`b${h}`, 'b'); // platform offers only one rendition → still give the user the video
  else parts.push('b');
  return [...new Set(parts)].join('/');
}

/**
 * Start a download. Returns { child, done: Promise<{filepath}> }.
 * onProgress({ downloaded, total, speed, eta, percent })
 */
export function startDownload({ url, format, container, kind, outTemplate, homeDir, tempDir, onProgress, provider }) {
  const args = [
    ...baseArgs(),
    '-f', format,
    '-P', `home:${homeDir}`,
    '-P', `temp:${tempDir}`,
    '-o', outTemplate,
    '--restrict-filenames', '--windows-filenames',
    '--continue', '--part',
    '--retries', '5', '--fragment-retries', '5',
    '--newline', '--progress',
    '--progress-template', 'download:VFPROG %(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    '--print', 'after_move:VFFILE %(filepath)s',
    '--no-simulate',
  ];
  if (kind === 'audio') {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '192K');
  } else if (hasFfmpeg()) {
    args.push('--merge-output-format', container === 'webm' ? 'webm' : 'mp4');
  }
  args.push('--', url);

  const child = spawn(config.ytdlpPath, args, { windowsHide: true });
  let stderr = '';
  let filepath = null;
  let buf = '';
  const num = (v) => (v && v !== 'NA' && v !== 'None' ? Number(v) : null);

  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith('VFPROG ')) {
        const [dl, tot, est, spd, eta] = line.slice(7).split('|').map(num);
        const total = tot || est || null;
        onProgress?.({
          downloaded: dl || 0,
          total,
          speed: spd,
          eta,
          percent: total && dl != null ? Math.min(100, Math.round((dl / total) * 1000) / 10) : null,
        });
      } else if (line.startsWith('VFFILE ')) {
        filepath = line.slice(7).trim();
      }
    }
  });
  child.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.length > 20_000) stderr = stderr.slice(-10_000);
    if (/\[(Merger|ExtractAudio|VideoConvertor|FixupM3u8)\]/.test(String(d))) onProgress?.({ processing: true });
  });

  const done = new Promise((resolve, reject) => {
    child.on('error', (e) => reject(mapYtdlpError(String(e.code || e.message), provider)));
    child.on('close', (code, signal) => {
      if (signal) return reject(new AppError('KILLED', 'stopped', 499));
      if (code === 0 && filepath) return resolve({ filepath });
      reject(mapYtdlpError(stderr || 'ERROR: download failed', provider));
    });
  });
  return { child, done };
}
