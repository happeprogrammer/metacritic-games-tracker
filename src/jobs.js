// Durable job queue (table jobs): survives restarts, retries with backoff, never double-queues a game.
const BACKOFF_MIN = [5, 15, 60, 240];
const iso = (d) => d.toISOString();

export function enqueue(db, { type, gameId, force = false, now = () => new Date(), delayMs = 0 }) {
  const t = now();
  db.prepare(`INSERT INTO jobs(type, game_id, status, attempts, next_at, force, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?, ?, ?)
    ON CONFLICT(type, game_id) DO UPDATE SET
      status = CASE WHEN jobs.status = 'running' THEN 'running' ELSE 'pending' END,
      attempts = CASE WHEN jobs.status = 'running' THEN jobs.attempts ELSE 0 END,
      next_at = excluded.next_at, force = MAX(jobs.force, excluded.force), error = NULL, updated_at = excluded.updated_at`)
    .run(type, gameId, iso(new Date(t.getTime() + delayMs)), force ? 1 : 0, iso(t), iso(t));
}

/** Next due job of a type. Games with the most reviews go first: they are the ones worth a scarce AI call. */
export function claimNext(db, { type, now = () => new Date() }) {
  const row = db.prepare(`SELECT j.id FROM jobs j JOIN games g ON g.id = j.game_id
    WHERE j.type = ? AND j.status = 'pending' AND j.next_at <= ? AND g.blacklisted = 0
    ORDER BY COALESCE((SELECT SUM(total) FROM review_samples rs WHERE rs.game_id = j.game_id), 0) DESC, j.next_at, j.id LIMIT 1`)
    .get(type, iso(now()));
  if (!row) return null;
  db.prepare("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ?").run(iso(now()), row.id);
  return { ...db.prepare('SELECT * FROM jobs WHERE id = ?').get(row.id) };
}

export const complete = (db, id, now = () => new Date()) =>
  db.prepare("UPDATE jobs SET status = 'done', error = NULL, updated_at = ? WHERE id = ?").run(iso(now()), id);

/** Count the attempt, back off, and give up (status failed) after maxAttempts. */
export function fail(db, id, error, { maxAttempts = 4, now = () => new Date() } = {}) {
  const job = db.prepare('SELECT attempts FROM jobs WHERE id = ?').get(id);
  const attempts = job.attempts + 1;
  const t = now();
  if (attempts >= maxAttempts) {
    db.prepare("UPDATE jobs SET status = 'failed', attempts = ?, error = ?, updated_at = ? WHERE id = ?").run(attempts, String(error).slice(0, 500), iso(t), id);
    return 'failed';
  }
  const wait = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60_000;
  db.prepare("UPDATE jobs SET status = 'pending', attempts = ?, next_at = ?, error = ?, updated_at = ? WHERE id = ?")
    .run(attempts, iso(new Date(t.getTime() + wait)), String(error).slice(0, 500), iso(t), id);
  return 'retry';
}

/** Put a job back without counting an attempt (the provider was down, the job itself is fine). */
export function defer(db, id, delayMs, note, now = () => new Date()) {
  const t = now();
  db.prepare("UPDATE jobs SET status = 'pending', next_at = ?, error = ?, updated_at = ? WHERE id = ?")
    .run(iso(new Date(t.getTime() + delayMs)), note ?? null, iso(t), id);
}

/** After a crash: whatever was running goes back to pending. */
export const recover = (db) => db.prepare("UPDATE jobs SET status = 'pending' WHERE status = 'running'").run().changes;

export function stats(db) {
  const out = { pending: 0, running: 0, failed: 0, done: 0, skipped: 0, by_type: {} };
  for (const r of db.prepare('SELECT type, status, COUNT(*) AS c FROM jobs GROUP BY type, status').all()) {
    out[r.status] += r.c;
    (out.by_type[r.type] ??= {})[r.status] = r.c;
  }
  return out;
}

export function list(db, { status = null, limit = 100 } = {}) {
  const rows = db.prepare(`SELECT j.id, j.type, j.status, j.attempts, j.next_at, j.error, j.updated_at, g.slug, g.title
    FROM jobs j JOIN games g ON g.id = j.game_id ${status ? 'WHERE j.status = ?' : ''} ORDER BY j.updated_at DESC LIMIT ?`)
    .all(...(status ? [status, limit] : [limit]));
  return rows.map((r) => ({ ...r }));
}

export const retry = (db, id, now = () => new Date()) =>
  db.prepare("UPDATE jobs SET status = 'pending', attempts = 0, next_at = ?, error = NULL, updated_at = ? WHERE id = ? AND status != 'running'").run(iso(now()), iso(now()), id).changes;
export const retryFailed = (db, now = () => new Date()) =>
  db.prepare("UPDATE jobs SET status = 'pending', attempts = 0, next_at = ?, error = NULL, updated_at = ? WHERE status = 'failed'").run(iso(now()), iso(now())).changes;
export const skip = (db, id, now = () => new Date()) =>
  db.prepare("UPDATE jobs SET status = 'skipped', updated_at = ? WHERE id = ? AND status != 'running'").run(iso(now()), id).changes;
