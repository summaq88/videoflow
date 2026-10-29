import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../lib/settings';
import type { Api, HistoryItem } from '../lib/api';
import { bytes, duration, when } from '../lib/format';
import { Empty, Icon, Modal, Thumb } from '../components/ui';

export default function History({ client, refreshKey, onPlay, onSave, onOpenLink }: {
  client: Api; refreshKey: number; onPlay: (id: string, title: string, kind: string) => void;
  onSave: (id: string, name: string) => void; onOpenLink: (url: string) => void;
}) {
  const { s, t, toast } = useApp();
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [q, setQ] = useState('');
  const [del, setDel] = useState<HistoryItem | null>(null);
  const [delFile, setDelFile] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);

  const load = useCallback(async () => {
    try { setItems((await client.history(q)).items); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'err'); setItems([]); }
  }, [client, q, toast]);

  useEffect(() => { const h = setTimeout(load, 200); return () => clearTimeout(h); }, [load, refreshKey]);

  const finished = (items || []).filter((i) => !['queued', 'analyzing', 'downloading', 'processing'].includes(i.status));

  return (
    <div className="mx-auto w-full max-w-2xl space-y-3">
      <div className="flex items-center gap-2 px-1">
        <h1 className="me-auto text-xl font-bold">{t.history}</h1>
        {!!finished.length && <button className="btn-ghost text-xs" onClick={() => setClearOpen(true)}><Icon name="trash" className="h-4 w-4" />{t.clearHistory}</button>}
      </div>
      <div className="relative">
        <span className="pointer-events-none absolute start-3 top-3 text-slate-400"><Icon name="search" className="h-4 w-4" /></span>
        <input className="input ps-9" placeholder={t.search} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {items === null ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-20" />)}</div>
      ) : !finished.length ? (
        <Empty icon="history" text={t.noHistory} />
      ) : (
        <ul className="space-y-2">
          {finished.map((i) => (
            <li key={i.id} className="card flex gap-3 p-3">
              <button className="relative" onClick={() => i.status === 'completed' && i.file_exists && onPlay(i.id, i.title || '', i.kind)} aria-label={t.play}>
                <Thumb src={i.thumbnail} kind={i.kind} className="h-16 w-24" />
                {i.status === 'completed' && i.file_exists && (
                  <span className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/25 text-white opacity-0 transition hover:opacity-100"><Icon name="play" /></span>
                )}
              </button>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-1 text-sm font-semibold" dir="auto">{i.title || i.url}</p>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  <span className="capitalize">{i.platform}</span> · {i.kind === 'audio' ? 'MP3' : `${i.quality === 'best' ? t.best : `${i.quality}p`} ${i.container?.toUpperCase()}`}
                  {i.duration ? ` · ${duration(i.duration)}` : ''}{i.file_size ? ` · ${bytes(i.file_size)}` : ''}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  {when(i.completed_at || i.created_at, s.lang)} ·{' '}
                  <span className={i.status === 'completed' ? (i.file_exists ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600') : 'text-red-500'}>
                    {i.status === 'completed' && !i.file_exists ? t.fileMissing : ((t as Record<string, unknown>)[i.status] as string)}
                  </span>
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end justify-between gap-1">
                <button className="btn-ghost p-1.5" onClick={() => { setDel(i); setDelFile(false); }} aria-label={t.remove}><Icon name="trash" className="h-4 w-4" /></button>
                {i.status === 'completed' && i.file_exists ? (
                  <button className="btn-soft px-2.5 py-1.5" onClick={() => onSave(i.id, i.file_name || 'video')} aria-label={t.save}><Icon name="save" className="h-4 w-4" /></button>
                ) : (
                  <button className="btn-soft px-2.5 py-1.5" onClick={() => onOpenLink(i.url)} aria-label={t.retry}><Icon name="retry" className="h-4 w-4" /></button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal open={!!del} onClose={() => setDel(null)}>
        <h3 className="text-lg font-semibold">{t.confirmRemove}</h3>
        <p className="mt-1 line-clamp-2 text-sm text-slate-500" dir="auto">{del?.title}</p>
        {del?.file_exists && (
          <label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={delFile} onChange={(e) => setDelFile(e.target.checked)} className="h-4 w-4 accent-brand-500" />{t.alsoDeleteFile}</label>
        )}
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button className="btn-soft" onClick={() => setDel(null)}>{t.cancel}</button>
          <button className="btn bg-red-500 text-white hover:bg-red-600" onClick={async () => {
            try { await client.remove(del!.id, delFile); setDel(null); void load(); } catch (e) { toast(e instanceof Error ? e.message : String(e), 'err'); }
          }}>{t.remove}</button>
        </div>
      </Modal>

      <Modal open={clearOpen} onClose={() => setClearOpen(false)}>
        <h3 className="text-lg font-semibold">{t.clearHistory}</h3>
        <p className="mt-1 text-sm text-slate-500">{t.confirmClear}</p>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button className="btn-soft" onClick={() => setClearOpen(false)}>{t.cancel}</button>
          <button className="btn bg-red-500 text-white hover:bg-red-600" onClick={async () => { await client.clearHistory().catch(() => {}); setClearOpen(false); void load(); }}>{t.clearHistory}</button>
        </div>
      </Modal>
    </div>
  );
}
