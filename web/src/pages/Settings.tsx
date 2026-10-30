import { useEffect, useState } from 'react';
import { useApp, sameOrigin, type Theme } from '../lib/settings';
import { api, type Health } from '../lib/api';
import { Icon } from '../components/ui';
import { readClipboard, isNative } from '../lib/device';
import { SIGN_IN_SITES } from '../lib/engine';
import type { PlatformCheck } from '../lib/deviceClient';

export default function SettingsPage({ health, onHealth }: { health: Health | null; onHealth: (h: Health | null) => void }) {
  const { s, set, t, toast } = useApp();
  const [url, setUrl] = useState(s.serverUrl);
  const [token, setToken] = useState(s.token);
  const [testing, setTesting] = useState(false);
  const [updating, setUpdating] = useState(false);
  const deviceMode = isNative && s.engine !== 'server';
  const onDevice = api(s).mode === 'device'; // the on-phone engine is in use (also true in automated tests)
  const [accounts, setAccounts] = useState<Record<string, boolean>>({});
  const [checks, setChecks] = useState<PlatformCheck[]>([]);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const c = api(s);
    if (c.mode === 'device') void c.accounts().then(setAccounts);
  }, [onDevice]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleAccount(site: string) {
    const c = api(s);
    if (c.mode !== 'device') return;
    try {
      if (accounts[site]) setAccounts(await c.logout(site));
      else { const ok = await c.login(site); setAccounts(await c.accounts()); toast(ok ? t.signedInAs : t.notSignedIn, ok ? 'ok' : 'err'); }
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'err'); }
  }

  async function runChecks() {
    const c = api(s);
    if (c.mode !== 'device') return;
    setChecking(true); setChecks([]);
    try {
      await c.checkPlatforms((r) => setChecks((prev) => {
        const i = prev.findIndex((p) => p.url === r.url);
        if (i < 0) return [...prev, r];
        const n = prev.slice(); n[i] = r; return n;
      }));
    } finally { setChecking(false); }
  }

  async function updateEngine() {
    setUpdating(true);
    try {
      const c = api(s);
      if (c.mode !== 'device') return;
      const r = await c.updateEngine();
      toast(`${t.updated} · yt-dlp ${r.version}`);
      onHealth(await c.health());
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setUpdating(false);
    }
  }

  async function test() {
    setTesting(true);
    const next = { ...s, serverUrl: url.trim(), token: token.trim() };
    set({ serverUrl: next.serverUrl, token: next.token });
    try {
      const c = api(next);
      const h = await c.health();
      await c.jobs(); // verifies the token
      onHealth(h);
      toast(`${t.connected} · yt-dlp ${h.ytdlp || '?'}`);
    } catch (e) {
      onHealth(null);
      toast(`${t.notConnected}: ${e instanceof Error ? e.message : ''}`, 'err');
    } finally {
      setTesting(false);
    }
  }

  const Seg = <T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) => (
    <div className="inline-flex rounded-xl bg-slate-100 p-1 dark:bg-white/[.06]">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${value === v ? 'bg-white text-slate-900 shadow dark:bg-white/15 dark:text-white' : 'text-slate-500'}`}>{label}</button>
      ))}
    </div>
  );

  const Row = ({ title, children, help }: { title: string; children: React.ReactNode; help?: string }) => (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0"><p className="text-sm font-medium">{title}</p>{help && <p className="mt-0.5 max-w-sm text-xs text-slate-500">{help}</p>}</div>
      {children}
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <h1 className="px-1 text-xl font-bold">{t.settings}</h1>

      {isNative && (
        <section className="card space-y-3 p-4">
          <h2 className="font-semibold">{t.engineTitle}</h2>
          <Seg value={s.engine} onChange={(v) => { set({ engine: v }); onHealth(null); }} options={[['device', t.engineDevice], ['server', t.engineServer]]} />
          {deviceMode && (
            <>
              <p className="text-xs text-slate-500">{t.engineDeviceHelp}</p>
              {health && <p className="text-xs text-slate-500">yt-dlp {health.ytdlp} · ffmpeg ✓</p>}
              <button className="btn-soft w-full" onClick={updateEngine} disabled={updating}><Icon name="retry" className="h-4 w-4" />{updating ? t.updating : t.updateEngine}</button>
              <p className="text-xs text-slate-500">{t.updateHelp}</p>
            </>
          )}
        </section>
      )}

      {onDevice && (
        <section className="card divide-y divide-slate-100 px-4 dark:divide-white/[.06]">
          <div className="pt-4 pb-2"><h2 className="font-semibold">{t.accounts}</h2><p className="mt-0.5 text-xs text-slate-500">{t.accountsHelp}</p></div>
          {Object.entries(SIGN_IN_SITES).map(([id, name]) => (
            <Row key={id} title={name} help={accounts[id] ? t.signedInAs : undefined}>
              <button className={accounts[id] ? 'btn-soft' : 'btn-primary'} onClick={() => toggleAccount(id)}>
                <Icon name="user" className="h-4 w-4" />{accounts[id] ? t.signOut : t.signIn}
              </button>
            </Row>
          ))}
        </section>
      )}

      {onDevice && (
        <section className="card space-y-3 p-4">
          <h2 className="font-semibold">{t.platformTest}</h2>
          <p className="text-xs text-slate-500">{t.platformTestHelp}</p>
          <button className="btn-soft w-full" onClick={runChecks} disabled={checking}><Icon name="check" className="h-4 w-4" />{checking ? t.testRunning : t.platformTest}</button>
          {checks.length > 0 && (
            <ul className="space-y-2 text-sm">
              {checks.map((c) => (
                <li key={c.url} className="flex items-start gap-2">
                  <span className={`mt-0.5 h-4 w-4 shrink-0 rounded-full ${c.state === 'ok' ? 'bg-emerald-500' : c.state === 'fail' ? 'bg-red-500' : 'animate-pulse bg-slate-300'}`} />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{c.platform} {c.seconds != null && <span className="font-normal text-slate-500">· {c.seconds.toFixed(1)} s</span>}</p>
                    {c.detail && <p className={`text-xs ${c.state === 'fail' ? 'text-red-600 dark:text-red-400' : 'text-slate-500'}`}>{c.detail}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!deviceMode && <section className="card p-4">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="me-auto font-semibold">{t.server}</h2>
          <span className={`flex items-center gap-1.5 text-xs font-medium ${health ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
            <span className={`h-2 w-2 rounded-full ${health ? 'bg-emerald-500' : 'bg-red-500'}`} />{health ? t.connected : t.notConnected}
          </span>
        </div>
        {sameOrigin ? (
          <p className="text-sm text-slate-500">{t.sameOrigin}</p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">{t.serverHelp}</p>
            <div><label className="label">{t.serverUrl}</label><input className="input" dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.20:8787" inputMode="url" autoCapitalize="off" /></div>
            <div><label className="label">{t.token}</label><input className="input font-mono" dir="ltr" value={token} onChange={(e) => setToken(e.target.value)} placeholder="from the server window" autoCapitalize="off" autoCorrect="off" /></div>
            <button className="btn-primary w-full" onClick={test} disabled={testing}>{testing ? '…' : t.testConnection}</button>
          </div>
        )}
        {health && (
          <p className="mt-3 text-xs text-slate-500">{t.engine}: yt-dlp {health.ytdlp || '—'} · ffmpeg {health.ffmpeg ? '✓' : '✗'}</p>
        )}
      </section>}

      <section className="card divide-y divide-slate-100 px-4 dark:divide-white/[.06]">
        <h2 className="pt-4 pb-1 font-semibold">{t.appearance}</h2>
        <Row title={t.theme}>
          <Seg<Theme> value={s.theme} onChange={(v) => set({ theme: v })} options={[['system', t.system], ['light', t.light], ['dark', t.dark]]} />
        </Row>
        <Row title={t.language}>
          <Seg value={s.lang} onChange={(v) => set({ lang: v })} options={[['en', 'English'], ['ar', 'العربية']]} />
        </Row>
      </section>

      <section className="card divide-y divide-slate-100 px-4 dark:divide-white/[.06]">
        <h2 className="pt-4 pb-1 font-semibold">{t.defaults}</h2>
        <Row title={t.defaultQuality}>
          <select className="input w-auto" value={s.defaultQuality} onChange={(e) => set({ defaultQuality: e.target.value })}>
            <option value="best">{t.best}</option>
            {['2160', '1440', '1080', '720', '480', '360'].map((q) => <option key={q} value={q}>{q === '2160' ? '4K' : q === '1440' ? '2K' : `${q}p`}</option>)}
            <option value="audio">{t.audioMp3}</option>
          </select>
        </Row>
        <Row title={t.defaultFormat}>
          <Seg value={s.defaultContainer} onChange={(v) => set({ defaultContainer: v })} options={[['mp4', 'MP4'], ['webm', 'WebM']]} />
        </Row>
        <Row title={t.autoSave} help={t.autoSaveHelp}>
          <button role="switch" aria-checked={s.autoSave} onClick={() => set({ autoSave: !s.autoSave })}
            className={`relative h-7 w-12 shrink-0 rounded-full transition ${s.autoSave ? 'bg-brand-500' : 'bg-slate-300 dark:bg-white/15'}`}>
            <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${s.autoSave ? 'start-6' : 'start-1'}`} />
          </button>
        </Row>
        <Row title={t.clipboard} help={t.clipboardHelp}>
          <button role="switch" aria-checked={s.clipboardWatch}
            onClick={async () => {
              if (!s.clipboardWatch) { try { await readClipboard(); } catch { toast('Clipboard permission denied', 'err'); return; } }
              set({ clipboardWatch: !s.clipboardWatch });
            }}
            className={`relative h-7 w-12 shrink-0 rounded-full transition ${s.clipboardWatch ? 'bg-brand-500' : 'bg-slate-300 dark:bg-white/15'}`}>
            <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${s.clipboardWatch ? 'start-6' : 'start-1'}`} />
          </button>
        </Row>
      </section>

      <section className="card flex gap-3 p-4 text-xs text-slate-500">
        <Icon name="alert" className="h-5 w-5 shrink-0" /><p>VideoFlow 2.7 · {t.about}</p>
      </section>
    </div>
  );
}
