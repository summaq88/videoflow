import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dict } from './lib/i18n';
import { SettingsContext, loadSettings, saveSettings, type Settings } from './lib/settings';
import { api, findUrls, type Health, type Job } from './lib/api';
import { readClipboard, saveToDevice } from './lib/device';
import { Icon, Logo, Modal } from './components/ui';
import Home from './pages/Home';
import Downloads from './pages/Downloads';
import History from './pages/History';
import SettingsPage from './pages/Settings';

type Tab = 'home' | 'downloads' | 'history' | 'settings';
const ACTIVE = ['queued', 'analyzing', 'downloading', 'processing'];

export default function App() {
  const [s, setS] = useState<Settings>(loadSettings);
  const [tab, setTab] = useState<Tab>('home');
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: 'ok' | 'err' }[]>([]);
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  const [health, setHealth] = useState<Health | null>(null);
  const [player, setPlayer] = useState<{ id: string; title: string; kind: string } | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [prefill, setPrefill] = useState<string | null>(null);
  const [clipOffer, setClipOffer] = useState<string | null>(null);
  const lastClip = useRef('');
  const mine = useRef<string[]>([]); // downloads started in this visit
  const saved = useRef(new Set<string>());
  const autoSaveRef = useRef(s.autoSave);
  autoSaveRef.current = s.autoSave;
  const saveRef = useRef<(id: string, name: string) => void>(() => {});

  const t = dict[s.lang];
  const client = useMemo(() => api(s), [s.serverUrl, s.token]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = useCallback((patch: Partial<Settings>) => {
    setS((prev) => { const next = { ...prev, ...patch }; saveSettings(next); return next; });
  }, []);

  const toast = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((x) => [...x.slice(-2), { id, msg, kind }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), kind === 'err' ? 6000 : 3000);
  }, []);

  // Theme + language direction
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', s.theme === 'dark' || (s.theme === 'system' && mq.matches));
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [s.theme]);
  useEffect(() => {
    document.documentElement.lang = s.lang;
    document.documentElement.dir = s.lang === 'ar' ? 'rtl' : 'ltr';
  }, [s.lang]);

  // Server health
  useEffect(() => {
    let alive = true;
    client.health().then((h) => alive && setHealth(h)).catch(() => alive && setHealth(null));
    return () => { alive = false; };
  }, [client]);

  // Live job updates: Server-Sent Events from the server, or events from the built-in engine (Android app)
  useEffect(() => {
    if (!health) return;
    client.jobs().then((r) => setJobs(Object.fromEntries(r.jobs.map((j) => [j.id, j])))).catch(() => {});
    const onJob = (j: Job) => {
      if (client.mode === 'server' && j.status === 'completed' && mine.current.includes(j.id) && !saved.current.has(j.id) && autoSaveRef.current) {
        saved.current.add(j.id);
        saveRef.current(j.id, j.fileName || 'video');
      }
      setJobs((prev) => {
        const before = prev[j.id];
        if (before && before.status !== j.status && ['completed', 'failed', 'skipped', 'canceled'].includes(j.status)) {
          setHistoryKey((k) => k + 1);
        }
        return { ...prev, [j.id]: j };
      });
    };
    if (client.mode === 'device') {
      const off = client.subscribe(onJob);
      return () => { off(); };
    }
    const es = new EventSource(client.eventsUrl());
    es.addEventListener('snapshot', (e) => {
      const list = JSON.parse((e as MessageEvent).data) as Job[];
      setJobs((prev) => ({ ...prev, ...Object.fromEntries(list.map((j) => [j.id, j])) }));
    });
    es.addEventListener('job', (e) => onJob(JSON.parse((e as MessageEvent).data) as Job));
    return () => es.close();
  }, [client, health]);

  // Clipboard detection (opt-in): offer a copied link when the user returns to the app
  useEffect(() => {
    if (!s.clipboardWatch) return;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const txt = (await readClipboard()).trim();
        const u = findUrls(txt)[0];
        if (u && u !== lastClip.current) { lastClip.current = u; setClipOffer(u); }
      } catch { /* permission not granted */ }
    };
    void check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => { window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, [s.clipboardWatch]);

  // Android "Share → VideoFlow" support: ?url=... or ?text=...
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const shared = p.get('url') || p.get('text');
    if (shared && findUrls(shared).length) setPrefill(shared);
  }, []);

  const jobList = Object.values(jobs);
  const activeCount = jobList.filter((j) => ACTIVE.includes(j.status)).length;

  const save = useCallback(async (id: string, name: string) => {
    try {
      if (client.mode === 'device') { await client.share(id); return; } // already saved in Download/VideoFlow → share it
      const where = await saveToDevice(client.fileUrl(id, true), name);
      toast(where ? t.savedTo(where) : t.saving);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }, [client, t, toast]);

  saveRef.current = save;

  const play = useCallback((id: string, title: string, kind: string) => {
    if (client.mode === 'device') { client.open(id).catch((e) => toast(e instanceof Error ? e.message : String(e), 'err')); return; }
    setPlayer({ id, title, kind });
  }, [client, toast]);

  const tabs: { id: Tab; icon: string; label: string; badge?: number }[] = [
    { id: 'home', icon: 'home', label: t.home },
    { id: 'downloads', icon: 'download', label: t.downloads, badge: activeCount },
    { id: 'history', icon: 'history', label: t.history },
    { id: 'settings', icon: 'settings', label: t.settings },
  ];

  return (
    <SettingsContext.Provider value={{ s, set, t, toast }}>
      <div className="flex min-h-full flex-col">
        <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-slate-50/80 backdrop-blur-lg dark:border-white/[.06] dark:bg-[#0b0d12]/80">
          <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
            <Logo className="h-8 w-8" />
            <span className="font-bold tracking-tight">VideoFlow</span>
            <nav className="ms-auto hidden gap-1 md:flex">
              {tabs.map((x) => (
                <button key={x.id} onClick={() => setTab(x.id)}
                  className={`relative flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition ${tab === x.id ? 'bg-white text-slate-900 shadow-sm dark:bg-white/10 dark:text-white' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}`}>
                  <Icon name={x.icon} className="h-4 w-4" />{x.label}
                  {!!x.badge && <span className="rounded-full bg-brand-500 px-1.5 text-[10px] font-bold text-white">{x.badge}</span>}
                </button>
              ))}
            </nav>
            {!health && client.mode === 'device' && (
              <span className="ms-auto flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />{t.preparing}
              </span>
            )}
            {!health && client.mode === 'server' && (
              <button onClick={() => setTab('settings')} className="ms-auto flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-600 md:ms-2 dark:bg-red-500/10 dark:text-red-400">
                <span className="h-1.5 w-1.5 rounded-full bg-red-500" />{t.notConnected}
              </button>
            )}
          </div>
        </header>

        <main className="flex-1 px-4 pb-28 pt-4 md:pb-10">
          {clipOffer && tab === 'home' && (
            <div className="mx-auto mb-3 flex max-w-2xl animate-rise items-center gap-3 rounded-2xl bg-brand-500 p-3 text-white shadow-card">
              <Icon name="paste" className="h-5 w-5 shrink-0" />
              <div className="min-w-0 flex-1"><p className="text-xs font-semibold">{t.useCopied}</p><p className="truncate text-xs opacity-90" dir="ltr">{clipOffer}</p></div>
              <button className="rounded-lg bg-white/20 px-3 py-1.5 text-xs font-semibold" onClick={() => { setPrefill(clipOffer); setClipOffer(null); }}>{t.use}</button>
              <button onClick={() => setClipOffer(null)} aria-label={t.cancel}><Icon name="x" className="h-4 w-4" /></button>
            </div>
          )}
          {tab === 'home' && <Home client={client} health={health} prefill={prefill} onPrefillUsed={() => setPrefill(null)}
            onQueued={(ids) => { mine.current = [...ids, ...mine.current].slice(0, 20); setJobs((p) => ({ ...p })); }}
            myJobs={mine.current.map((id) => jobs[id]).filter(Boolean).slice(0, 6)} onSave={save} />}
          {tab === 'downloads' && <Downloads jobs={jobList} client={client} onPlay={play} onSave={save} />}
          {tab === 'history' && <History client={client} refreshKey={historyKey} onPlay={play} onSave={save} onOpenLink={(u) => { setPrefill(u); setTab('home'); }} />}
          {tab === 'settings' && <SettingsPage health={health} onHealth={setHealth} />}
        </main>

        <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-slate-200/70 bg-white/90 backdrop-blur-lg md:hidden dark:border-white/[.06] dark:bg-[#0f1218]/90">
          <div className="grid grid-cols-4">
            {tabs.map((x) => (
              <button key={x.id} onClick={() => setTab(x.id)}
                className={`relative flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium ${tab === x.id ? 'text-brand-500' : 'text-slate-500'}`}>
                <Icon name={x.icon} className="h-5 w-5" />{x.label}
                {!!x.badge && <span className="absolute top-1.5 ms-6 rounded-full bg-brand-500 px-1.5 text-[10px] font-bold text-white">{x.badge}</span>}
              </button>
            ))}
          </div>
        </nav>

        <Modal open={!!player} onClose={() => setPlayer(null)} wide>
          {player && (
            <div>
              <div className="mb-3 flex items-center gap-2">
                <p className="me-auto line-clamp-1 text-sm font-semibold" dir="auto">{player.title}</p>
                <button className="btn-ghost p-1.5" onClick={() => setPlayer(null)}><Icon name="x" /></button>
              </div>
              {player.kind === 'audio' ? (
                <audio src={client.fileUrl(player.id)} controls autoPlay className="w-full" />
              ) : (
                <video src={client.fileUrl(player.id)} controls autoPlay playsInline className="max-h-[70vh] w-full rounded-xl bg-black" />
              )}
            </div>
          )}
        </Modal>

        <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 md:bottom-6">
          {toasts.map((x) => (
            <div key={x.id} className={`pointer-events-auto max-w-md animate-rise rounded-xl px-4 py-2.5 text-sm font-medium text-white shadow-lg ${x.kind === 'err' ? 'bg-red-600' : 'bg-slate-900 dark:bg-slate-700'}`}>{x.msg}</div>
          ))}
        </div>
      </div>
    </SettingsContext.Provider>
  );
}
