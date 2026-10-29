import os from 'node:os';
import { config, ensureDirs, resolveAccessToken } from './config.js';
import { openDb, markInterrupted } from './db.js';
import { DownloadManager } from './downloadManager.js';
import { createApp } from './app.js';
import { getInfo, hasFfmpeg, ytdlpVersion } from './ytdlp.js';
import { detectProvider } from './providers/index.js';

ensureDirs();
openDb(config.dataDir);
markInterrupted();

const ytdlp = ytdlpVersion();
const ffmpeg = hasFfmpeg();
const token = resolveAccessToken();

const manager = new DownloadManager();
manager.providerLookup = (url) => detectProvider(new URL(url));

const app = createApp({
  manager,
  getInfo,
  token,
  versions: { version: '1.0.0', ytdlp, ffmpeg },
});

manager.cleanupTemp();
setInterval(() => manager.cleanupTemp(), 3600_000).unref();

app.listen(config.port, config.host, () => {
  const lan = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('\n  VideoFlow is running');
  console.log(`  ▸ This device:   http://127.0.0.1:${config.port}`);
  if (config.host === '0.0.0.0') lan.forEach((ip) => console.log(`  ▸ Phone (Wi-Fi): http://${ip}:${config.port}`));
  console.log(`  ▸ Access token:  ${token || '(disabled)'}`);
  console.log(`  ▸ Saving to:     ${config.downloadDir}`);
  console.log(`  ▸ yt-dlp:        ${ytdlp || 'NOT FOUND – install it (see README)'}`);
  console.log(`  ▸ ffmpeg:        ${ffmpeg ? 'found' : 'not found – HD merging and MP3 need it'}\n`);
});
