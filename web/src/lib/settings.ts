import { createContext, useContext } from 'react';
import type { Lang, Dict } from './i18n';

export type Theme = 'system' | 'light' | 'dark';
export interface Settings {
  serverUrl: string;
  token: string;
  theme: Theme;
  lang: Lang;
  defaultQuality: string; // 'best' | '1080' | '720' | '480' | '360' | 'audio'
  defaultContainer: 'mp4' | 'webm';
  clipboardWatch: boolean;
  autoSave: boolean;
  engine: 'device' | 'server'; // Android app only
}

const KEY = 'videoflow.settings.v1';

/** When the page is served by the VideoFlow server, it carries the token in a meta tag. */
export const sameOrigin = !!document.querySelector('meta[name="vf-same-origin"]');
export const injectedToken = document.querySelector<HTMLMetaElement>('meta[name="vf-token"]')?.content || '';

export const defaultSettings: Settings = {
  serverUrl: 'http://127.0.0.1:8787',
  token: '',
  theme: 'system',
  lang: (navigator.language || '').toLowerCase().startsWith('ar') ? 'ar' : 'en',
  defaultQuality: 'best',
  defaultContainer: 'mp4',
  clipboardWatch: false,
  autoSave: true,
  engine: 'device',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaultSettings, ...JSON.parse(raw) };
  } catch { /* storage unavailable */ }
  return { ...defaultSettings };
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export interface Ctx {
  s: Settings;
  set: (patch: Partial<Settings>) => void;
  t: Dict;
  toast: (msg: string, kind?: 'ok' | 'err') => void;
}
export const SettingsContext = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(SettingsContext);
