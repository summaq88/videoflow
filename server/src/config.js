import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

const int = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

export const config = {
  port: int(env.PORT, 8787),
  // 127.0.0.1 = this computer only. Use HOST=0.0.0.0 so your phone (same Wi-Fi) can connect.
  host: env.HOST || '127.0.0.1',
  downloadDir: path.resolve(env.DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'VideoFlow')),
  dataDir: path.resolve(env.DATA_DIR || path.join(here, '..', 'data')),
  webDir: path.resolve(env.WEB_DIR || path.join(here, '..', '..', 'web', 'dist')),
  ytdlpPath: env.YTDLP_PATH || 'yt-dlp',
  ffmpegPath: env.FFMPEG_PATH || '',
  maxConcurrent: Math.max(1, int(env.MAX_CONCURRENT, 3)),
  maxRetries: Math.max(0, int(env.MAX_RETRIES, 2)),
  infoTimeoutMs: int(env.INFO_TIMEOUT_MS, 90_000),
  tempMaxAgeMs: int(env.TEMP_MAX_AGE_HOURS, 6) * 3600_000,
  // Set ACCESS_TOKEN=none to disable the token (only do this on a trusted, private machine).
  accessToken: env.ACCESS_TOKEN || '',
  allowPrivateHosts: env.ALLOW_PRIVATE_HOSTS === '1', // tests only – never enable in production
};

export function ensureDirs() {
  for (const d of [config.downloadDir, config.dataDir, path.join(config.dataDir, 'tmp')]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/** Token: env value, else a persisted random token in data/token.txt. */
export function resolveAccessToken() {
  if (config.accessToken === 'none') return '';
  if (config.accessToken) return config.accessToken;
  const file = path.join(config.dataDir, 'token.txt');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t) return t;
  } catch { /* create below */ }
  const t = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}
