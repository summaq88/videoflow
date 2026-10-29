import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider } from '../src/providers/index.js';
import { buildFormat, mapYtdlpError, summarizeInfo } from '../src/ytdlp.js';

const p = (u) => detectProvider(new URL(u));

test('platform detection', () => {
  const cases = {
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ': 'youtube',
    'https://youtu.be/dQw4w9WgXcQ': 'youtube',
    'https://m.youtube.com/shorts/abcdef123': 'youtube',
    'https://www.instagram.com/reel/Cxyz/': 'instagram',
    'https://www.tiktok.com/@user/video/123': 'tiktok',
    'https://vm.tiktok.com/ZM123/': 'tiktok',
    'https://www.snapchat.com/spotlight/abc': 'snapchat',
    'https://www.facebook.com/watch/?v=1': 'facebook',
    'https://fb.watch/abc/': 'facebook',
    'https://x.com/a/status/1': 'x',
    'https://twitter.com/a/status/1': 'x',
    'https://pin.it/abc': 'pinterest',
    'https://vimeo.com/123': 'generic',
    'https://notyoutube.com/watch?v=1': 'generic', // look-alike domain is NOT YouTube
  };
  for (const [u, id] of Object.entries(cases)) assert.equal(p(u).id, id, u);
});

test('URL normalization', () => {
  const yt = p('https://youtube.com/shorts/abcdef123?feature=share');
  assert.equal(yt.normalize(new URL('https://youtube.com/shorts/abcdef123?feature=share')).href, 'https://www.youtube.com/watch?v=abcdef123');
  assert.equal(yt.normalize(new URL('https://youtu.be/abcdef123?si=xyz&t=5')).href, 'https://www.youtube.com/watch?v=abcdef123');
  const ig = p('https://instagram.com/reel/A/');
  assert.equal(ig.normalize(new URL('https://www.instagram.com/reel/A/?igsh=zzz&utm_source=ig')).href, 'https://www.instagram.com/reel/A/');
});

test('format selector: quality, container, clean rendition, ffmpeg fallback', () => {
  assert.equal(buildFormat({ kind: 'audio' }), 'ba/b');
  const f = buildFormat({ quality: '720', container: 'mp4' });
  assert.ok(f.startsWith('bv*[height<=720][ext=mp4]+ba[ext=m4a]/'));
  assert.ok(f.endsWith('/b'));
  assert.ok(buildFormat({ quality: 'best', container: 'webm' }).startsWith('bv*[ext=webm]+ba[ext=webm]'));
  const noff = buildFormat({ quality: '1080', ffmpeg: false });
  assert.ok(!noff.includes('+'), 'without ffmpeg only single-file formats are used');
  const tk = buildFormat({ quality: 'best', clean: '[format_note!*=watermark]' });
  assert.ok(tk.startsWith('bv*[format_note!*=watermark][ext=mp4]'));
  assert.equal(buildFormat({ quality: '1080; rm -rf /' }).includes('rm'), false, 'quality is never injected unchecked');
});

test('friendly error mapping', () => {
  const code = (s) => mapYtdlpError(s).code;
  assert.equal(code('ERROR: [youtube] x: Private video. Sign in if you have access'), 'PRIVATE');
  assert.equal(code('ERROR: [youtube] x: Video unavailable'), 'UNAVAILABLE');
  assert.equal(code('ERROR: Unsupported URL: https://example.com'), 'UNSUPPORTED');
  assert.equal(code('ERROR: This video is DRM protected'), 'DRM');
  assert.equal(code('ERROR: [Instagram] x: Requested content is not available, rate-limit reached or login required'), 'LOGIN_REQUIRED');
  assert.equal(code('ERROR: Unable to download webpage: <urlopen error timed out>'), 'NETWORK');
  assert.equal(mapYtdlpError('timed out').transient, true);
  assert.equal(code('spawn yt-dlp ENOENT'), 'YTDLP_MISSING');
});

test('summarizeInfo only reports qualities the source really has', () => {
  const info = summarizeInfo({
    id: 'abc', extractor_key: 'Youtube', title: 'T', duration: 61.4, thumbnail: 'https://i/x.jpg',
    formats: [
      { format_id: '1', vcodec: 'avc1', acodec: 'none', height: 360, ext: 'mp4' },
      { format_id: '2', vcodec: 'avc1', acodec: 'none', height: 720, ext: 'mp4' },
      { format_id: '3', vcodec: 'vp9', acodec: 'none', height: 1080, ext: 'webm' },
      { format_id: '4', vcodec: 'none', acodec: 'mp4a', ext: 'm4a' },
    ],
  }, p('https://youtube.com'));
  assert.deepEqual(info.qualities.map((q) => q.value), ['best', '1080', '720', '360']);
  assert.equal(info.duration, 61);
  assert.equal(info.videoKey, 'youtube:abc');
  assert.equal(info.audio, true);
  assert.equal(info.watermarkFreeAvailable, null);

  const tk = summarizeInfo({
    id: '1', extractor_key: 'TikTok', title: 't',
    formats: [
      { vcodec: 'h264', acodec: 'aac', height: 1024, format_note: 'watermarked' },
      { vcodec: 'h264', acodec: 'aac', height: 1024, format_note: 'Direct video' },
    ],
  }, p('https://tiktok.com'));
  assert.equal(tk.watermarkFreeAvailable, true);
  assert.equal(tk.hasWatermarkedVariant, true);
});
