import { defineProvider, stripTracking } from './base.js';
import youtube from './youtube.js';
import tiktok from './tiktok.js';
import { instagram, facebook, x, pinterest, snapchat } from './others.js';

export const generic = defineProvider({
  id: 'generic',
  name: 'Other website',
  hosts: [],
  normalize: (u) => stripTracking(u),
  notes: 'Works on many sites with directly downloadable video. Not every site is supported.',
});

export const providers = [youtube, instagram, tiktok, snapchat, facebook, x, pinterest];

/** Find the adapter for a URL (falls back to the generic adapter). */
export function detectProvider(url) {
  return providers.find((p) => p.matches(url)) || generic;
}

export function listProviders() {
  return [...providers, generic].map(({ id, name, hosts, notes }) => ({ id, name, hosts, notes }));
}
