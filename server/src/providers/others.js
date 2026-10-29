import { defineProvider, stripTracking } from './base.js';

export const instagram = defineProvider({
  id: 'instagram',
  name: 'Instagram',
  hosts: ['instagram.com', 'instagr.am'],
  normalize: (u) => stripTracking(u),
  notes: 'Public Reels, videos and posts. Private accounts and Stories that need a login are not supported.',
  errorHints: {
    LOGIN_REQUIRED: 'Instagram requires a login for this post (private, age-restricted, or temporarily rate-limited).',
  },
});

export const facebook = defineProvider({
  id: 'facebook',
  name: 'Facebook',
  hosts: ['facebook.com', 'fb.watch', 'fb.com'],
  normalize: (u) => stripTracking(u, ['v', 'story_fbid', 'id']),
  notes: 'Public videos and Reels. Videos in private groups or friends-only posts are not supported.',
});

export const x = defineProvider({
  id: 'x',
  name: 'X / Twitter',
  hosts: ['x.com', 'twitter.com', 'mobile.twitter.com'],
  normalize: (u) => stripTracking(u),
  notes: 'Public posts with video. Protected accounts are not supported.',
});

export const pinterest = defineProvider({
  id: 'pinterest',
  name: 'Pinterest',
  hosts: ['pinterest.com', 'pin.it', 'pinterest.co.uk', 'pinterest.ca', 'pinterest.fr', 'pinterest.de'],
  normalize: (u) => stripTracking(u),
  notes: 'Video Pins. Image-only Pins have nothing to download.',
});

export const snapchat = defineProvider({
  id: 'snapchat',
  name: 'Snapchat',
  hosts: ['snapchat.com'],
  normalize: (u) => stripTracking(u),
  notes: 'Public Spotlight videos and public Stories only. Private Snaps cannot be accessed.',
});
