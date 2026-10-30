import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/settings';
import { ApiError, findUrls, type AnalyzeResult, type Api, type Health, type Job } from '../lib/api';
import { readClipboard } from '../lib/device';
import { SIGN_IN_SITES } from '../lib/engine';
import { bytes, duration, eta, speed } from '../lib/format';
import { Icon, Modal, Progress, Thumb } from '../components/ui';

const PLATFORMS = ['YouTube', 'Instagram', 'TikTok', 'Snapchat', 'Facebook', 'X', 'Pinterest'];
const BATCH_Q = ['best', '2160', '1440', '1080', '720', '480', '360'];

export default function Home({ client, health, prefill, onPrefillUsed, onQueued, myJobs, onSave }: {
  client: Api; health: Health | null; prefill: string | null; onPrefillUsed: () => void; onQueued: (ids: string[]) => void;
  myJobs: Job[]; onSave: (id: string, name: string) => void;
}) {
  const { s, t, toast } = useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<AnalyzeResult | null>(null);
  const [quality, setQuality] = useState(s.defaultQuality === 'audio' ? 'best' : s.defaultQuality);
  const [audio, setAudio] = useState(s.defaultQuality === 'audio');
  const [container, setContainer] = useState<'mp4' | 'webm'>(s.defaultContainer);
  const [sending, setSending] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [refining, setRefining] = useState(false);
  const [refineNote, setRefineNote] = useState<string | null>(null);
  const [signInSite, setSignInSite] = useState<string | null>(null); // site to sign in to after a SIGN_IN error
  const detectId = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const urls = useMemo(() => findUrls(text), [text]);
  const isBatch = urls.length > 1;

  useEffect(() => {
    if (prefill) { setText(prefill); setRes(null); setError(null); onPrefillUsed(); void detect(prefill); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  // When a preview loads, pick the default quality if the video has it, otherwise the best.
  useEffect(() => {
    if (!res) return;
    const vals = res.info.qualities.map((q) => q.value);
    setQuality(vals.includes(s.defaultQuality) ? s.defaultQuality : 'best');
  }, [res, s.defaultQuality]);

  async function paste() {
    try {
      const v = await readClipboard();
      if (!v) return;
      setText(v);
      setRes(null);
      setError(null);
      if (findUrls(v).length === 1) void detect(v);
    } catch {
      inputRef.current?.focus();
      toast('Clipboard permission denied – long-press the box and paste.', 'err');
    }
  }

  function noteSignIn(e: unknown) {
    if (e instanceof ApiError && e.code.startsWith('SIGN_IN:')) setSignInSite(e.code.slice(8));
  }

  async function signInAndRetry() {
    const site = signInSite;
    if (!site || client.mode !== 'device') return;
    try {
      const ok = await client.login(site);
      if (ok) { toast(t.signedIn); void detect(); }
      else toast(t.notSignedIn, 'err');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    }
  }

  const signInButton = signInSite && (
    <button className="btn-primary mt-3 w-full" onClick={signInAndRetry}>
      <Icon name="user" className="h-4 w-4" />{t.signInTo} {SIGN_IN_SITES[signInSite] || signInSite}
    </button>
  );

  async function detect(value = text) {
    const list = findUrls(value);
    if (!list.length) { setError(t.placeholder); return; }
    if (list.length > 1) return; // batch mode shows its own card
    const reqId = ++detectId.current;
    setBusy(true); setError(null); setRes(null); setRefining(false); setRefineNote(null); setSignInSite(null);
    try {
      // Android app: show title + thumbnail instantly, load exact qualities in the background.
      if (client.mode === 'device') {
        const quick = await client.preview(list[0]).catch(() => null);
        if (reqId !== detectId.current) return;
        if (quick) {
          setRes(quick);
          setBusy(false);
          if (quick.partial) {
            setRefining(true);
            client.analyze(list[0])
              .then((full) => { if (reqId === detectId.current) setRes(full); })
              .catch((e) => { if (reqId === detectId.current) { setRefineNote(e instanceof ApiError ? e.message : String(e)); noteSignIn(e); } })
              .finally(() => { if (reqId === detectId.current) setRefining(false); });
          }
          return;
        }
      }
      const full = await client.analyze(list[0]);
      if (reqId === detectId.current) setRes(full);
    } catch (e) {
      if (reqId === detectId.current) { setError(e instanceof ApiError ? e.message : String(e)); noteSignIn(e); }
    } finally {
      if (reqId === detectId.current) setBusy(false);
    }
  }

  async function startDownload(force = false) {
    if (!res) return;
    setSending(true);
    try {
      const r = await client.download({ url: res.url, kind: audio ? 'audio' : 'video', quality: audio ? 'audio' : quality, container, force });
      onQueued([r.job.id]);
      detectId.current++; // ignore late quality results for this link
      setRefining(false); setRefineNote(null);
      setRes(null);
      setText('');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE') setDupOpen(true);
      else toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setSending(false);
    }
  }

  async function startBatch() {
    setSending(true);
    try {
      const r = await client.batch({ urls, kind: audio ? 'audio' : 'video', quality: audio ? 'audio' : quality, container });
      const bad = r.results.filter((x) => x.error);
      toast(bad.length ? `${r.results.length - bad.length}/${r.results.length} – ${bad[0].error!.message}` : t.added, bad.length ? 'err' : 'ok');
      if (bad.length < r.results.length) { setText(''); onQueued(r.results.filter((x) => x.job).map((x) => x.job!.id)); }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'err');
    } finally {
      setSending(false);
    }
  }

  const info = res?.info;
  const qLabel = (v: string) => (v === 'best' ? t.best : res?.info.qualities.find((q) => q.value === v)?.label || `${v}p`);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <section className="pt-2 text-center sm:pt-6">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">VideoFlow</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t.appTagline}</p>
      </section>

      {!health && client.mode === 'server' && <SetupGuide />}

      <section className="card p-3 sm:p-4">
        <div className="relative">
          <span className="pointer-events-none absolute start-3.5 top-3.5 text-slate-400"><Icon name="link" /></span>
          <textarea
            ref={inputRef}
            value={text}
            rows={isBatch ? Math.min(6, urls.length + 1) : 1}
            onChange={(e) => { detectId.current++; setText(e.target.value); setRes(null); setError(null); setBusy(false); setRefining(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !isBatch) { e.preventDefault(); void detect(); } }}
            placeholder={t.placeholder}
            dir="ltr"
            className="input min-h-[52px] resize-none py-3.5 ps-11 pe-10 text-base"
            autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="url"
          />
          {text && (
            <button className="btn-ghost absolute end-1.5 top-2" onClick={() => { setText(''); setRes(null); setError(null); }} aria-label={t.clear}>
              <Icon name="x" className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button className="btn-soft" onClick={paste}><Icon name="paste" className="h-4 w-4" />{t.paste}</button>
          <button className="btn-primary" onClick={() => detect()} disabled={busy || !urls.length || isBatch}>
            {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="search" className="h-4 w-4" />}
            {busy ? t.detecting : t.detect}
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
          <span className="me-1 text-xs text-slate-400">{t.supported}:</span>
          {PLATFORMS.map((p) => (
            <span key={p} className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${res?.platform.name.startsWith(p) ? 'bg-brand-500 text-white' : 'bg-slate-100 text-slate-600 dark:bg-white/[.06] dark:text-slate-300'}`}>{p}</span>
          ))}
          <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500 dark:bg-white/[.06] dark:text-slate-400">+ more</span>
        </div>
      </section>

      {error && (
        <div className="card flex animate-rise items-start gap-3 border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
          <Icon name="alert" className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="min-w-0 flex-1"><p>{error}</p>{signInButton}<p className={signInSite ? 'mt-2 text-xs opacity-80' : 'hidden'}>{t.signInPrivacy}</p></div>
        </div>
      )}

      {busy && (
        <div className="card flex gap-4 p-4">
          <div className="skeleton h-24 w-36 shrink-0" />
          <div className="flex-1 space-y-2 py-1"><div className="skeleton h-4 w-4/5" /><div className="skeleton h-3 w-1/2" /><div className="skeleton h-3 w-1/3" /></div>
        </div>
      )}

      {isBatch && (
        <section className="card animate-rise space-y-4 p-4">
          <div className="flex items-center gap-2 text-sm font-medium"><Icon name="layers" className="h-5 w-5 text-brand-500" />{t.batchFound(urls.length)}</div>
          <Options
            qualities={BATCH_Q} qLabel={(v) => (v === 'best' ? t.best : v === '2160' ? '4K' : v === '1440' ? '2K' : `${v}p`)}
            {...{ quality, setQuality, audio, setAudio, container, setContainer }}
          />
          <button className="btn-primary w-full py-3.5 text-base" disabled={sending} onClick={startBatch}>
            <Icon name="download" />{sending ? t.starting : `${t.downloadAll} (${urls.length})`}
          </button>
        </section>
      )}

      {info && res && !busy && (
        <section className="card animate-rise overflow-hidden">
          <div className="flex flex-col gap-4 p-4 sm:flex-row">
            <div className="relative">
              <Thumb src={info.thumbnail} className="aspect-video w-full sm:w-56" />
              {info.duration != null && (
                <span className="absolute bottom-2 end-2 rounded-md bg-black/75 px-1.5 py-0.5 text-[11px] font-semibold text-white">{duration(info.duration)}</span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <span className="inline-block rounded-md bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-400">{res.platform.name}</span>
              <h2 className="mt-1.5 line-clamp-3 text-base font-semibold leading-snug" dir="auto">{info.title}</h2>
              {info.uploader && <p className="mt-1 truncate text-sm text-slate-500 dark:text-slate-400" dir="auto">{t.by} {info.uploader}</p>}
              {refining && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500"><span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-brand-500" />{t.checkingQualities}</p>
              )}
              {!refining && refineNote && <><p className="mt-2 text-xs text-amber-600">{refineNote}</p>{signInButton}</>}
              {res.alreadyDownloaded && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400"><Icon name="check" className="h-4 w-4" />{t.alreadyHave}</p>
              )}
            </div>
          </div>

          <div className="space-y-4 border-t border-slate-100 p-4 dark:border-white/[.06]">
            <Options qualities={info.qualities.map((q) => q.value)} qLabel={qLabel} hasAudio={info.audio}
              {...{ quality, setQuality, audio, setAudio, container, setContainer }} />

            {info.watermarkFreeAvailable != null && (
              <p className={`flex items-start gap-2 text-xs ${info.watermarkFreeAvailable ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500'}`}>
                <Icon name={info.watermarkFreeAvailable ? 'sparkle' : 'alert'} className="mt-px h-4 w-4 shrink-0" />
                {info.watermarkFreeAvailable ? t.cleanAvailable : t.cleanMissing}
              </p>
            )}
            {audio && <p className="text-xs text-slate-500">{t.audioNote}</p>}
            {health && !health.ffmpeg && <p className="text-xs text-amber-600">{t.ffmpegMissing}</p>}

            <button className="btn-primary w-full py-3.5 text-base" disabled={sending || info.isLive} onClick={() => startDownload()}>
              <Icon name="download" />{sending ? t.starting : `${t.download} · ${audio ? 'MP3' : `${qLabel(quality)} ${container.toUpperCase()}`}`}
            </button>
            <p className="text-center text-[11px] text-slate-400"><b>{t.limits}:</b> {res.platform.notes}</p>
          </div>
        </section>
      )}

      {!!myJobs.length && (
        <section className="space-y-2">
          {myJobs.map((j) => <MiniJob key={j.id} j={j} client={client} onSave={onSave} />)}
        </section>
      )}

      <Modal open={dupOpen} onClose={() => setDupOpen(false)}>
        <h3 className="text-lg font-semibold">{t.duplicateTitle}</h3>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t.duplicateBody}</p>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button className="btn-soft" onClick={() => setDupOpen(false)}>{t.cancel}</button>
          <button className="btn-primary" onClick={() => { setDupOpen(false); void startDownload(true); }}>{t.downloadAgain}</button>
        </div>
      </Modal>
    </div>
  );
}

function Options({ qualities, qLabel, quality, setQuality, audio, setAudio, container, setContainer, hasAudio = true }: {
  qualities: string[]; qLabel: (v: string) => string; quality: string; setQuality: (v: string) => void;
  audio: boolean; setAudio: (v: boolean) => void; container: 'mp4' | 'webm'; setContainer: (v: 'mp4' | 'webm') => void; hasAudio?: boolean;
}) {
  const { t } = useApp();
  return (
    <div className="space-y-3">
      <div>
        <span className="label">{t.quality}</span>
        <div className="flex flex-wrap gap-2">
          {qualities.map((v) => (
            <button key={v} className={!audio && quality === v ? 'chip-on' : 'chip-off'} onClick={() => { setAudio(false); setQuality(v); }}>{qLabel(v)}</button>
          ))}
          {hasAudio && (
            <button className={audio ? 'chip-on' : 'chip-off'} onClick={() => setAudio(true)}><Icon name="music" className="h-3.5 w-3.5" />{t.audioMp3}</button>
          )}
        </div>
      </div>
      {!audio && (
        <div>
          <span className="label">{t.format}</span>
          <div className="flex gap-2">
            {(['mp4', 'webm'] as const).map((c) => (
              <button key={c} className={container === c ? 'chip-on' : 'chip-off'} onClick={() => setContainer(c)}>{c.toUpperCase()}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const TERMUX_CMD = `pkg update -y && pkg install -y nodejs python ffmpeg unzip && pip install yt-dlp && termux-setup-storage
cd ~ && unzip -o ~/storage/downloads/VideoFlow.zip && cd videoflow/server && npm install
DOWNLOAD_DIR=~/storage/downloads/VideoFlow npm start`;

/** Shown when no VideoFlow server is reachable: the app cannot download without one. */
function SetupGuide() {
  const { s, toast } = useApp();
  const ar = s.lang === 'ar';
  const copy = async () => {
    try { await navigator.clipboard.writeText(TERMUX_CMD); toast(ar ? 'تم النسخ' : 'Copied'); }
    catch { toast(ar ? 'انسخ النص يدوياً' : 'Copy the text manually', 'err'); }
  };
  return (
    <section className="card animate-rise space-y-3 border-amber-200 p-4 dark:border-amber-500/20">
      <div className="flex items-center gap-2">
        <Icon name="alert" className="h-5 w-5 text-amber-500" />
        <h2 className="font-semibold">{ar ? 'شغّل خادم VideoFlow أولاً' : 'Start the VideoFlow server first'}</h2>
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {ar
          ? 'هذه الصفحة هي الواجهة فقط؛ التنزيل يتم عبر خادم VideoFlow المجاني. لتشغيله على هذا الهاتف بدون حاسوب:'
          : 'This page is the interface; the downloading is done by the free VideoFlow server. To run it on this phone, no laptop needed:'}
      </p>
      <ol className="list-decimal space-y-1.5 ps-5 text-sm text-slate-600 dark:text-slate-300">
        <li>{ar ? 'نزّل VideoFlow.zip إلى مجلد التنزيلات في الهاتف.' : 'Save VideoFlow.zip to the phone’s Download folder.'}</li>
        <li>{ar ? 'ثبّت تطبيق Termux من F-Droid (وليس من Play Store).' : 'Install the Termux app from F-Droid (not the Play Store).'}</li>
        <li>{ar ? 'افتح Termux والصق هذه الأوامر (مرة واحدة فقط، ~5 دقائق):' : 'Open Termux and paste these commands (one time, ~5 min):'}</li>
      </ol>
      <pre dir="ltr" className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">{TERMUX_CMD}</pre>
      <button className="btn-soft w-full" onClick={copy}><Icon name="paste" className="h-4 w-4" />{ar ? 'نسخ الأوامر' : 'Copy commands'}</button>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {ar
          ? '٤. افتح Chrome على الهاتف وادخل إلى العنوان التالي — سيعمل مباشرة بدون رمز:'
          : '4. Then open Chrome on the phone and go to this address – it connects automatically, no token needed:'}
      </p>
      <p dir="ltr" className="rounded-xl bg-brand-50 p-2.5 text-center font-mono text-sm font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-400">http://127.0.0.1:8787</p>
      <p className="text-xs text-slate-500">
        {ar
          ? 'لاحقاً: افتح Termux واكتب cd ~/videoflow/server && npm start ثم افتح العنوان نفسه. أو شغّل الخادم على حاسوبك (راجع README).'
          : 'Next time: open Termux, run  cd ~/videoflow/server && npm start  and open the same address. Or run the server on your PC instead (see README).'}
      </p>
    </section>
  );
}

const RUNNING = ['queued', 'analyzing', 'downloading', 'processing'];

/** Compact progress card shown on Home for downloads started in this visit. */
function MiniJob({ j, client, onSave }: { j: Job; client: Api; onSave: (id: string, name: string) => void }) {
  const { t, toast } = useApp();
  const running = RUNNING.includes(j.status);
  const act = async (a: 'cancel' | 'retry') => {
    try { await client.action(j.id, a); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'err'); }
  };
  return (
    <div className="card animate-rise p-3">
      <div className="flex items-center gap-3">
        <Thumb src={j.thumbnail} kind={j.kind} className="h-12 w-16" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold" dir="auto">{j.title || j.url}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400" dir="auto">
            {(t as Record<string, unknown>)[j.status] as string}
            {j.status === 'downloading' && j.progress != null ? ` · ${j.progress.toFixed(0)}%` : ''}
            {running && j.speed ? ` · ${speed(j.speed)}` : ''}
            {running && j.eta != null ? ` · ${eta(j.eta)} ${t.eta}` : ''}
            {j.status === 'completed' && j.fileSize ? ` · ${bytes(j.fileSize)} · ${client.mode === 'device' ? t.inDownloads : t.savedAuto}` : ''}
          </p>
        </div>
        {running && <button className="btn-ghost p-1.5" onClick={() => act('cancel')} aria-label={t.cancel}><Icon name="x" className="h-4 w-4" /></button>}
        {j.status === 'completed' && <button className="btn-soft px-3 py-1.5 text-xs" onClick={() => onSave(j.id, j.fileName || 'video')}><Icon name={client.mode === 'device' ? 'share' : 'save'} className="h-4 w-4" />{client.mode === 'device' ? t.share : t.saveAgain}</button>}
        {j.status === 'failed' && <button className="btn-soft px-3 py-1.5 text-xs" onClick={() => act('retry')}><Icon name="retry" className="h-4 w-4" />{t.retry}</button>}
      </div>
      {running && <div className="mt-2.5"><Progress value={j.status === 'processing' ? 100 : j.progress} active /></div>}
      {j.status === 'failed' && j.error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{j.error}</p>}
    </div>
  );
}
