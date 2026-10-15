// Hourly upkeep: trim journals, drop stale review samples, daily database backup. Keeps the disk footprint flat.
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dayOf } from './selection.js';
import { getState, setState } from './state.js';

export function createHousekeeper({ db, events, settings, dataDir, now = () => new Date() }) {
  let lastRun = null;
  let lastError = null;

  /** VACUUM INTO a dated file (once per day) and keep only the newest `backup_keep` files. */
  function backup() {
    if (!dataDir || dataDir === ':memory:') return null;
    const s = settings();
    const day = dayOf(now(), s.tz);
    if (getState(db, 'last_backup_day') === day) return null;
    const dir = join(dataDir, 'backups');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `games-${day}.db`);
    rmSync(file, { force: true });
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    setState(db, 'last_backup_day', day);
    const files = readdirSync(dir).filter((f) => /^games-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - s.backup_keep))) rmSync(join(dir, f), { force: true });
    events.info('housekeeper', `Бэкап базы сохранён: ${file} (${Math.round(statSync(file).size / 1024)} КБ)`);
    return file;
  }

  function runOnce() {
    const s = settings();
    const cutoff = (days) => new Date(now().getTime() - days * 86_400_000).toISOString();
    try {
      events.prune();
      const calls = db.prepare('DELETE FROM ai_calls WHERE at < ?').run(cutoff(s.log_retention_days)).changes;
      db.prepare("DELETE FROM audit_log WHERE at < ?").run(cutoff(90));
      db.prepare("DELETE FROM runs WHERE started_at < ? AND status != 'running'").run(cutoff(s.log_retention_days));
      // Samples are only needed to (re)build a summary; once a game has its summaries, old samples just cost disk.
      const samples = db.prepare(`DELETE FROM review_samples WHERE fetched_at < ? AND game_id IN
        (SELECT game_id FROM summaries WHERE status = 'ok' GROUP BY game_id)`).run(cutoff(3)).changes;
      backup();
      lastRun = now().toISOString();
      lastError = null;
      return { calls, samples };
    } catch (e) {
      lastError = e.message;
      events.error('housekeeper', `Ошибка уборки: ${e.message}`);
      return null;
    }
  }

  let timer = null;
  return {
    runOnce, backup,
    start() { timer = setInterval(runOnce, 3600_000); timer.unref?.(); runOnce(); },
    stop() { if (timer) clearInterval(timer); },
    snapshot: () => ({ id: 'housekeeper', state: lastError ? 'error' : 'idle', current: null, processed_today: null, errors_today: null, last_activity_at: lastRun, last_error: lastError }),
  };
}
