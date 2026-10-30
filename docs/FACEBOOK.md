# Facebook downloads in VideoFlow

VideoFlow downloads Facebook videos that **you can already watch**: public videos, and private or group
videos visible to your own Facebook account. It never bypasses privacy settings, group membership, DRM or
any other access control. If your account can't open a video in the Facebook app, VideoFlow can't either.

## Supported links

| Link type | Example | How it's handled |
|---|---|---|
| Video / Watch | `facebook.com/watch/?v=…`, `…/videos/…`, `video.php?v=…` | read directly |
| Reels | `facebook.com/reel/…` | read directly |
| Posts | `…/posts/pfbid…`, `story.php?story_fbid=…` | read directly |
| **Group videos** | `facebook.com/groups/<group>/permalink/<post>/`, `…/groups/<group>/posts/<post>/` | read directly; private groups need sign-in |
| **Share links** (from the app's "Copy link") | `facebook.com/share/v/…`, `/share/r/…`, `/share/p/…`, `fb.watch/…` | followed to the real post on the phone first |
| m. / web. / mbasic. hosts | `m.facebook.com/…` | read directly |

Tracking parameters (`mibextid`, `fbclid`, `__cft__`, `rdid`, …) are removed so the same video is
recognised as a duplicate however it was shared.

## Architecture (Android app, everything runs on the phone)

```
Paste / Share → VideoFlow
   │
   ├─ engine.ts        parse link → detect platform → strip tracking → isShortLink?
   │                      └─ yes → VideoFlowNative.resolve()  (Java, HttpURLConnection, no auto-redirect,
   │                               the phone's own Facebook cookies, reads Location / canonical URL)
   ├─ deviceClient.ts  readInfo(fast) → yt-dlp -J  (+ --cookies when you are signed in)
   │                      └─ errors mapped by friendlyError(msg, platform, signedIn):
   │                           not signed in + hidden  → "Sign in to Facebook" button
   │                           signed in + hidden      → "Your account can't open this video"
   ├─ Home.tsx         thumbnail, title, real quality list (1080p / 720p / 540p … only what exists)
   └─ download()       yt-dlp downloads the DASH video + audio streams, ffmpeg remuxes them into one MP4
                       (no re-encoding: original quality, audio stays in sync, no watermark added)
                       progress via yt-dlp callback, 5 retries, fragment retries, resumable partial files
```

Sign-in (`LoginActivity.java`) opens **facebook.com's own login page** inside the app. The password is
typed into Facebook's page and is never seen, stored or sent anywhere by VideoFlow. Afterwards only the
session cookies of facebook.com (from Android's WebView cookie store) are written to a private file
(`no_backup/cookies.txt`, readable only by this app, excluded from backups) that yt-dlp uses. Sign out (Settings → Accounts) deletes
them. No VideoFlow server exists; nothing is sent to any third party.

## Security rules enforced in code

* No password storage: the login page is Facebook's; the app only reads the resulting session cookies of its own WebView.
* Cookies stay on the phone: app-private `no_backup` folder, so they are not copied into Android cloud backups.
* Short-link resolution talks only to facebook.com / fb.watch; redirects to login pages are not followed, only their `next=` target is read.
* DRM-protected media is refused (`DRM` error); no decryption is attempted.
* Downloads are written to an app work folder, then published to `Download/VideoFlow` through MediaStore; file names are sanitised (`--restrict-filenames`).

## Errors you may see

| Message | Meaning |
|---|---|
| "Facebook did not show this video publicly…" + **Sign in to Facebook** | Private / group video and you are not signed in. |
| "Your Facebook account cannot open this video…" | Signed in, but this account has no access (not in the group, removed, or not a video). |
| "This video is DRM-protected" | Paid / licensed content; cannot be downloaded. |
| "Network problem" | Connection dropped; tap Retry (partial download resumes). |

## Testing

* **On the phone:** Settings → *Test all platforms* reads one public video per platform and shows OK/fail, time and best quality.
* **Automated UI tests** (Playwright, simulated phone engine — `devtest3/4/5.py` during development):
  share link → resolved group permalink → not signed in → sign-in button → signed in → 1080p/540p offered;
  signed-in account without access → clear "cannot open" message; tracking parameters removed.
* **Cloud check:** `.github/workflows/platform-test.yml` runs the same yt-dlp options against public test
  videos every Monday and on changes; results are published to the `platform-test` release.
  (Cloud IPs are often blocked by Facebook, so a failure there must be confirmed on the phone.)
* Manual matrix to run on a device: public video, public reel, share link `/share/v/`, `fb.watch`,
  your own "Only me" video (signed in), a video in a private group you belong to (signed in),
  the same group video signed out (expects the sign-in prompt), a group you are not in (expects "cannot open").

## Build & deploy

The APK is built by `.github/workflows/build-apk.yml` on every push to `main` and published as the
`latest-apk` release (signed with the same key, so each version installs as an update).
