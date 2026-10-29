import { defineProvider, stripTracking } from './base.js';

export default defineProvider({
  id: 'youtube',
  name: 'YouTube',
  hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
  normalize(u) {
    const url = stripTracking(u, ['v', 't', 'list']);
    // Shorts and youtu.be → canonical watch URL (keeps one video, not a playlist)
    const short = url.pathname.match(/^\/shorts\/([\w-]{6,})/);
    if (short) return new URL(`https://www.youtube.com/watch?v=${short[1]}`);
    if (url.hostname.endsWith('youtu.be')) {
      const id = url.pathname.slice(1).split('/')[0];
      if (id) return new URL(`https://www.youtube.com/watch?v=${id}`);
    }
    return url;
  },
  notes: 'Public videos and Shorts. Private, members-only and paid (DRM) videos cannot be downloaded.',
  errorHints: {
    LOGIN_REQUIRED: 'YouTube asked for a sign-in or bot check for this video. Try again later or another video.',
  },
});
