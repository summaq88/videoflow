import { useEffect, type ReactNode } from 'react';
import { LOGO_URI } from '../lib/logo';

const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const paths: Record<string, ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  download: <><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5" /><path d="M5 20h14" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  paste: <><rect x="8" y="3" width="8" height="4" rx="1" /><path d="M8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  play: <path d="M7 4.5v15a.5.5 0 0 0 .8.4l11.5-7.5a.5.5 0 0 0 0-.8L7.8 4.1a.5.5 0 0 0-.8.4z" />,
  pause: <><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></>,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  retry: <><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" /><path d="M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.3L3 16" /><path d="M3 21v-5h5" /></>,
  trash: <><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4h6v3" /></>,
  save: <><path d="M12 3v12m0 0-4-4m4 4 4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></>,
  check: <path d="m5 12 5 5 9-10" />,
  share: <><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16.5v.5" /></>,
  sparkle: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />,
  music: <><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></>,
  film: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></>,
};

export function Icon({ name, className = 'h-5 w-5' }: { name: keyof typeof paths | string; className?: string }) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden {...P}>{paths[name]}</svg>;
}

export function Logo({ className = 'h-9 w-9' }: { className?: string }) {
  return <img src={LOGO_URI} alt="" aria-hidden className={`${className} rounded-[22%] object-cover`} draggable={false} />;
}

export function Modal({ open, onClose, children, wide = false }: { open: boolean; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div className={`card w-full animate-rise rounded-b-none p-5 sm:rounded-2xl ${wide ? 'max-w-3xl' : 'max-w-md'}`} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function Progress({ value, active }: { value: number | null; active?: boolean }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-white/[.06]">
      {value == null ? (
        <div className={`h-full w-1/3 rounded-full bg-brand-500/70 ${active ? 'animate-pulse' : ''}`} />
      ) : (
        <div className="h-full rounded-full bg-brand-500 transition-[width] duration-300 ease-out" style={{ width: `${Math.max(2, value)}%` }} />
      )}
    </div>
  );
}

export function Thumb({ src, kind, className = '' }: { src: string | null; kind?: string; className?: string }) {
  return (
    <div className={`relative shrink-0 overflow-hidden rounded-xl bg-slate-100 dark:bg-white/[.05] ${className}`}>
      {src ? (
        <img src={src} alt="" referrerPolicy="no-referrer" loading="lazy" className="h-full w-full object-cover"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
      ) : null}
      <div className="absolute inset-0 -z-0 flex items-center justify-center text-slate-400">
        {!src && <Icon name={kind === 'audio' ? 'music' : 'film'} className="h-6 w-6" />}
      </div>
    </div>
  );
}

export function Empty({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center text-slate-500 dark:text-slate-400">
      <div className="rounded-2xl bg-slate-100 p-4 dark:bg-white/[.05]"><Icon name={icon} className="h-7 w-7" /></div>
      <p className="max-w-xs text-sm">{text}</p>
    </div>
  );
}
