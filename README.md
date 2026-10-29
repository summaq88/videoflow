# VideoFlow – Universal Video Downloader

Copy link → Paste → Preview → Download. Free, open-source, no ads, no account.

| Part | What it is |
|---|---|
| `server/` | Node.js + Express backend: platform adapters, download manager, SQLite history, security |
| `web/` | React + TypeScript + Tailwind interface (EN/AR, dark/light) |
| `html/videoflow.html` | The **HTML version** – the full interface in one file |
| `web/android/` | The **Android app** (Capacitor), built into an APK by GitHub for free |

---

## How it works (important)

Downloading is done by your **own free server** (the `server` folder) using the open-source engine
[yt-dlp](https://github.com/yt-dlp/yt-dlp). The HTML page and the Android app are the screens; they talk to that server.
You choose where the server runs – all options are free:

1. **Your Windows PC** – the PC downloads; your phone (same Wi-Fi) or browser controls it.
2. **Your Android phone itself** – the server runs inside the free app *Termux*, so everything stays on the phone.
3. **A VPS / cloud server** – see “Production deployment”.

---

## 1. Run on Windows

1. Install **Node.js 22.13+** – https://nodejs.org (LTS)
2. Install the engine and ffmpeg (PowerShell):
   ```powershell
   winget install yt-dlp.yt-dlp
   winget install Gyan.FFmpeg
   ```
   Close and reopen PowerShell afterwards.
3. Start the server:
   ```powershell
   cd videoflow\server
   npm install
   npm start
   ```
4. Open **http://127.0.0.1:8787** – done. Files are saved to `Downloads\VideoFlow`.

### Use it from your phone over Wi-Fi
Start the server so other devices can reach it:
```powershell
$env:HOST="0.0.0.0"; npm start
```
The window prints a **Phone (Wi-Fi)** address such as `http://192.168.1.20:8787` and an **Access token**.
Open that address in the phone's browser, or enter both in the Android app under **Settings → Server**.
(Allow Node.js through Windows Firewall on *Private networks* when asked.)

## 2. The HTML version
`html/videoflow.html` is the complete interface in one file. Double-click it on the computer that runs the server
(it connects to `http://127.0.0.1:8787` by default), or change the address and token in **Settings**.
The server also serves the same page at `http://<server>:8787`, already connected.

## 3. Android app (APK)

### Build the APK (free, ~10 minutes, no Android Studio needed)
1. Create a free account on https://github.com and click **New repository** (private is fine).
2. Upload this whole `videoflow` folder to it (**Add file → Upload files**, drag the folder contents; keep the `.github` folder).
3. Open the **Actions** tab → **Build Android APK** → **Run workflow** (it also runs on every upload).
4. When it turns green, open the run and download **VideoFlow-APK** → unzip → `VideoFlow.apk`.
5. Send it to your phone, open it, and allow “Install unknown apps” when Android asks.

(With Android Studio instead: `cd web && npm install && npm run android:sync`, then open `web/android` and press Run.)

### Run the server on the phone (Termux) – no PC needed
1. Install **Termux** from F-Droid (https://f-droid.org/packages/com.termux/) – the Play Store version is outdated.
2. Copy the `server` folder to the phone, then in Termux:
   ```bash
   cd /sdcard/Download/videoflow/server   # wherever you copied it
   bash termux-setup.sh
   ~/videoflow-start.sh
   ```
3. In the VideoFlow app → **Settings**: server `http://127.0.0.1:8787` + the token shown in Termux → **Test connection**.
   Videos are saved straight into the phone's **Download/VideoFlow** folder.
   (“Save to device” in the app also copies files to **Documents/VideoFlow**.)

---

## Features
- Platforms: YouTube (incl. Shorts), Instagram (public Reels/posts), TikTok, Snapchat (public Spotlight/Stories),
  Facebook (public videos/Reels), X/Twitter, Pinterest, and many other sites with public video.
- Automatic platform detection, URL cleanup (tracking parameters removed, Shorts/short links normalized).
- Real preview: thumbnail, title, uploader, duration and **only the qualities the video actually has** (360p → 4K/8K, original).
- MP4 or WebM; MP3 audio extraction.
- Watermark-free TikTok: when TikTok provides its own clean playback file, that file is chosen. Nothing is cropped,
  blurred or edited, and VideoFlow never adds its own watermark.
- Download manager: several downloads at once (default 3), live percentage/speed/time left, pause/resume
  (continues the partial file), cancel, automatic retry on network errors, manual retry.
- Batch: paste many links (one per line) → “Download all”.
- Duplicate detection (same video + same quality asks before downloading again).
- History with search, built-in video/audio player, save to device, delete.
- Clipboard detection (opt-in), English/Arabic (RTL), dark/light/system theme.

## Security
- Every URL is validated: http/https only, no credentials in URLs, no custom ports, max length.
- **SSRF protection**: hostnames are resolved and refused if any address is private, loopback, link-local,
  cloud-metadata (169.254.169.254), CGNAT, multicast or reserved (IPv4 + IPv6, incl. IPv4-mapped).
- Access token on every API call (printed when the server starts; saved in `server/data/token.txt`).
  Set `ACCESS_TOKEN=yourvalue` to choose your own.
- Rate limiting (general 600/min, analyze/download 40/min, batch 10/min).
- Files are only served from the download folder; temp files live in `server/data/tmp` and are cleaned automatically.
- No tracking, no analytics, no personal data collected.

## Configuration (environment variables)
| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 8787 | Server port |
| `HOST` | 127.0.0.1 | `0.0.0.0` to allow phones on your network |
| `DOWNLOAD_DIR` | `~/Downloads/VideoFlow` | Where finished files go |
| `DATA_DIR` | `server/data` | Database, token, temp files |
| `MAX_CONCURRENT` | 3 | Simultaneous downloads |
| `MAX_RETRIES` | 2 | Automatic retries for network errors |
| `ACCESS_TOKEN` | random | Your own token, or `none` to disable (trusted machine only) |
| `YTDLP_PATH`, `FFMPEG_PATH` | from PATH | Custom locations of the tools |

## Tests
```bash
cd server && npm test
```
22 tests: URL validation, SSRF (incl. DNS-rebinding style), platform detection, format selection, error messages,
download manager (progress, retry, pause/resume/cancel, duplicates, concurrency) and the HTTP API
(token, history, file streaming with Range).

## Keeping it working
Websites change often. When a platform stops working, update the engine – this fixes most problems:
```bash
yt-dlp -U            # or: pip install -U yt-dlp   /   winget upgrade yt-dlp.yt-dlp
```

## Production deployment (optional)
On a Linux VPS (Ubuntu): install Node 22, `pip install yt-dlp`, `apt install ffmpeg`, then
```bash
cd server && npm install --omit=dev
ACCESS_TOKEN=<long-random> HOST=127.0.0.1 npm start      # run with pm2 or systemd
```
Put it behind Caddy or Nginx with HTTPS (e.g. Caddy: `your.domain { reverse_proxy 127.0.0.1:8787 }`).
Then set the app's server address to `https://your.domain`.
**Costs & limits:** running at home or in Termux is free. A VPS costs money (≈ $4–6/month). YouTube and Instagram often
block or rate-limit data-center IP addresses, so a home PC or the phone usually works better than a cloud server.

## What it cannot do (by design)
- Private, friends-only, members-only, paid or login-only content, and DRM-protected video (e.g. movies, paid courses).
- Live streams while they are live.
- Removing watermarks or creator credits that are part of the video picture.
- Guarantee every site: support depends on what each platform makes publicly available.
Download only content you have the right to save.
