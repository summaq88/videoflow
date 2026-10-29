import { defineProvider, stripTracking } from './base.js';

export default defineProvider({
  id: 'tiktok',
  name: 'TikTok',
  hosts: ['tiktok.com'],
  normalize: (u) => stripTracking(u),
  // TikTok serves both a plain playback file and a separate "watermarked" share file.
  // We pick the plain playback rendition the platform provides; no pixels are altered.
  cleanFilter: '[format_note!*=watermark]',
  notes: 'Public videos. The platform’s own clean playback file is used when TikTok provides it.',
});
