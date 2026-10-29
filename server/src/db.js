import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let db;

export function openDb(dir) {
  db = new DatabaseSync(dir === ':memory:' ? ':memory:' : path.join(dir, 'videoflow.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS downloads (
      id           TEXT PRIMARY KEY,
      url          TEXT NOT NULL,
      video_key    TEXT,
      platform     TEXT,
      title        TEXT,
      uploader     TEXT,
      thumbnail    TEXT,
      duration     INTEGER,
      kind         TEXT,
      quality      TEXT,
      container    TEXT,
      status       TEXT NOT NULL,
      file_path    TEXT,
      file_name    TEXT,
      file_size    INTEGER,
      error        TEXT,
      error_code   TEXT,
      created_at   INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_downloads_key ON downloads(video_key, kind, quality, container);
    CREATE INDEX IF NOT EXISTS idx_downloads_created ON downloads(created_at DESC);
  `);
  return db;
}

const COLS = ['id', 'url', 'video_key', 'platform', 'title', 'uploader', 'thumbnail', 'duration', 'kind', 'quality',
  'container', 'status', 'file_path', 'file_name', 'file_size', 'error', 'error_code', 'created_at', 'completed_at'];

export function upsertDownload(row) {
  const vals = COLS.map((c) => (row[c] === undefined ? null : row[c]));
  db.prepare(`INSERT INTO downloads (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})
    ON CONFLICT(id) DO UPDATE SET ${COLS.filter((c) => c !== 'id').map((c) => `${c}=excluded.${c}`).join(',')}`).run(...vals);
}

export function getDownload(id) {
  return db.prepare('SELECT * FROM downloads WHERE id = ?').get(id) || null;
}

export function listHistory({ q = '', limit = 100, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  if (q) {
    const like = `%${String(q).slice(0, 100)}%`;
    return db.prepare(`SELECT * FROM downloads WHERE title LIKE ? OR url LIKE ? OR platform LIKE ?
      ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(like, like, like, lim, off);
  }
  return db.prepare('SELECT * FROM downloads ORDER BY created_at DESC LIMIT ? OFFSET ?').all(lim, off);
}

export function findCompletedDuplicate({ videoKey, kind, quality, container }) {
  return db.prepare(`SELECT * FROM downloads WHERE video_key = ? AND kind = ? AND quality = ? AND container = ?
    AND status = 'completed' ORDER BY completed_at DESC LIMIT 1`).get(videoKey, kind, quality, container) || null;
}

export function deleteDownload(id) {
  db.prepare('DELETE FROM downloads WHERE id = ?').run(id);
}

export function clearHistory() {
  db.prepare("DELETE FROM downloads WHERE status IN ('completed','failed','canceled')").run();
}

/** Jobs that were running when the server stopped become "paused" so they can be resumed. */
export function markInterrupted() {
  db.prepare("UPDATE downloads SET status = 'paused' WHERE status IN ('queued','analyzing','downloading','processing')").run();
}
