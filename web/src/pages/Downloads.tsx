import { useApp } from '../lib/settings';
import type { Api, Job } from '../lib/api';
import { bytes, eta, speed } from '../lib/format';
import { Empty, Icon, Progress, Thumb } from '../components/ui';

const ACTIVE = ['queued', 'analyzing', 'downloading', 'processing'];

export default function Downloads({ jobs, client, onPlay, onSave }: {
  jobs: Job[]; client: Api; onPlay: (id: string, title: string, kind: string) => void; onSave: (id: string, name: string) => void;
}) {
  const { t, toast } = useApp();
  const sorted = [...jobs].sort((a, b) => Number(ACTIVE.includes(b.status)) - Number(ACTIVE.includes(a.status)) || b.createdAt - a.createdAt);

  const act = async (id: string, a: 'pause' | 'resume' | 'cancel' | 'retry') => {
    try { await client.action(id, a); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'err'); }
  };

  if (!sorted.length) return <div className="mx-auto max-w-2xl"><Empty icon="download" text={t.noDownloads} /></div>;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-3">
      <h1 className="px-1 text-xl font-bold">{t.downloads}</h1>
      {sorted.map((j) => {
        const active = ACTIVE.includes(j.status);
        const statusText = (t as Record<string, unknown>)[j.status] as string;
        return (
          <div key={j.id} className="card animate-rise p-3.5">
            <div className="flex gap-3">
              <Thumb src={j.thumbnail} kind={j.kind} className="h-16 w-24" />
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm font-semibold leading-snug" dir="auto">{j.title || j.url}</p>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  <span className="capitalize">{j.platform}</span> · {j.kind === 'audio' ? 'MP3' : `${j.quality === 'best' ? t.best : `${j.quality}p`} ${j.container.toUpperCase()}`}
                  {j.fileSize ? ` · ${bytes(j.fileSize)}` : ''}
                </p>
              </div>
            </div>

            {(active || j.status === 'paused') && (
              <div className="mt-3 space-y-1.5">
                <Progress value={j.status === 'processing' ? 100 : j.progress} active={active} />
                <div className="flex justify-between text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                  <span>{statusText}{j.progress != null && j.status === 'downloading' ? ` · ${j.progress.toFixed(1)}%` : ''}{j.error && j.status === 'queued' ? ` · ${j.error}` : ''}</span>
                  <span dir="ltr">{[j.total ? `${bytes(j.downloaded)} / ${bytes(j.total)}` : '', speed(j.speed), j.eta != null ? `${eta(j.eta)} ${t.eta}` : ''].filter(Boolean).join(' · ')}</span>
                </div>
              </div>
            )}

            {(j.status === 'failed' || j.status === 'skipped') && j.error && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400"><Icon name="alert" className="mt-px h-4 w-4 shrink-0" />{j.error}</p>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-end gap-1.5">
              {!active && j.status !== 'paused' && (
                <span className={`me-auto text-xs font-medium ${j.status === 'completed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-500'}`}>{statusText}</span>
              )}
              {['downloading', 'queued', 'analyzing'].includes(j.status) && <button className="btn-soft py-1.5" onClick={() => act(j.id, 'pause')}><Icon name="pause" className="h-4 w-4" />{t.pause}</button>}
              {j.status === 'paused' && <button className="btn-soft py-1.5" onClick={() => act(j.id, 'resume')}><Icon name="play" className="h-4 w-4" />{t.resume}</button>}
              {(active || j.status === 'paused') && <button className="btn-ghost py-1.5" onClick={() => act(j.id, 'cancel')}><Icon name="x" className="h-4 w-4" />{t.cancel}</button>}
              {(j.status === 'failed' || j.status === 'canceled') && <button className="btn-soft py-1.5" onClick={() => act(j.id, 'retry')}><Icon name="retry" className="h-4 w-4" />{t.retry}</button>}
              {j.status === 'completed' && (
                <>
                  <button className="btn-soft py-1.5" onClick={() => onPlay(j.id, j.title || '', j.kind)}><Icon name="play" className="h-4 w-4" />{t.play}</button>
                  <button className="btn-primary py-1.5" onClick={() => onSave(j.id, j.fileName || 'video')}><Icon name="save" className="h-4 w-4" />{t.save}</button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
