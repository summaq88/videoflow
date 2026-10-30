"""Checks every platform with the same yt-dlp options the Android app uses (fast YouTube client first).

Usage: python platform_test.py platform-urls.json results.json
Reads each link's info (no download) and records OK / error, best height, audio, and time taken.
"""
import json, subprocess, sys, time

FAST = ['--extractor-args', 'youtube:player_client=visionos,android_vr']


def probe(url, extra):
    t = time.time()
    p = subprocess.run(['yt-dlp', '-J', '--no-playlist', '--no-warnings', '--socket-timeout', '15', *extra, url],
                       capture_output=True, text=True, timeout=180)
    dt = round(time.time() - t, 1)
    if p.returncode != 0:
        err = [l for l in p.stderr.splitlines() if 'ERROR' in l]
        return {'ok': False, 'seconds': dt, 'error': (err[-1] if err else p.stderr.strip()[-300:])[:300]}
    info = json.loads(p.stdout)
    fmts = info.get('formats') or [info]
    heights = [f.get('height') or 0 for f in fmts if f.get('vcodec') not in (None, 'none')]
    audio = any(f.get('acodec') not in (None, 'none') for f in fmts)
    return {'ok': True, 'seconds': dt, 'title': (info.get('title') or '')[:80], 'maxHeight': max(heights or [0]),
            'audio': audio, 'formats': len(fmts), 'duration': info.get('duration')}


def main():
    urls = json.load(open(sys.argv[1]))
    out = []
    ver = subprocess.run(['yt-dlp', '--version'], capture_output=True, text=True).stdout.strip()
    for item in urls:
        r = probe(item['url'], FAST)
        if not r['ok'] and 'youtu' in item['url']:  # the app's fallback: full method with a JavaScript runtime
            r2 = probe(item['url'], ['--remote-components', 'ejs:github'])
            r2['method'] = 'full'
            r = r2 if r2['ok'] else {**r, 'fullError': r2.get('error')}
        out.append({**item, **r})
        print(('OK  ' if r['ok'] else 'FAIL') + f" {item['platform']:<12} {r['seconds']:>5}s  " + (f"{r.get('maxHeight')}p audio={r.get('audio')} {r.get('title','')}" if r['ok'] else r['error']), flush=True)
    json.dump({'ytdlp': ver, 'when': time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime()), 'results': out}, open(sys.argv[2], 'w'), indent=1)


if __name__ == '__main__':
    main()
