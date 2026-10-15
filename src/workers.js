// Background workers that drain the job queue. Each exposes runOnce() (tests) and start()/stop() (service).
import { claimNext, complete, defer, fail, recover } from './jobs.js';
import { summarizeGame } from './ai/summarize.js';
import { AiUnavailable } from './ai/errors.js';
import { processLetsplay } from './yt/letsplay.js';
import { dayOf } from './selection.js';

const defaultSleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

function createWorker({ id, type, db, events, settings, now = () => new Date(), sleep = defaultSleep, paceMs, handle, enabled = () => true }) {
  let current = null;
  let lastError = null;
  let lastActivity = null;
  let stopped = false;
  let loop = null;

  async function runOnce() {
    if (!enabled(settings())) return 'disabled';
    const job = claimNext(db, { type, now });
    if (!job) return 'idle';
    const game = { ...db.prepare('SELECT * FROM games WHERE id = ?').get(job.game_id) };
    current = game.slug;
    try {
      const res = await handle({ job, game, settings: settings() });
      if (res?.retryAfterMs) { // finished for now, but worth another try later (not counted as a failure)
        defer(db, job.id, res.retryAfterMs, res.note, now);
        lastActivity = now().toISOString();
        events.info('ai', `${id}: ${game.slug}: ${res.note}`);
        return 'deferred';
      }
      complete(db, job.id, now);
      lastActivity = now().toISOString();
      events.info('ai', `${id}: готово ${game.slug}${res?.note ? ` (${res.note})` : ''}`);
      return 'done';
    } catch (e) {
      lastActivity = now().toISOString();
      if (e instanceof AiUnavailable) {
        defer(db, job.id, Math.max(e.retryAfterMs, 60_000), e.reason, now);
        lastError = e.message;
        events.warn('ai', `${id}: ${e.message}; ${game.slug} отложен`);
        return 'deferred';
      }
      lastError = e.message;
      const outcome = fail(db, job.id, e.message, { maxAttempts: settings().ai_job_max_attempts, now });
      events.error('ai', `${id}: ошибка ${game.slug}: ${e.message} (${outcome === 'failed' ? 'больше не повторяется' : 'повтор позже'})`);
      return 'failed';
    } finally {
      current = null;
    }
  }

  async function run() {
    while (!stopped) {
      let r = 'failed';
      try { r = await runOnce(); } catch (e) { lastError = e.message; events.error('ai', `${id}: ${e.message}`); }
      await sleep(r === 'done' ? paceMs : r === 'idle' || r === 'disabled' ? 5000 : 15000);
    }
  }

  return {
    id, runOnce,
    start() { stopped = false; loop = run(); return loop; },
    async stop() { stopped = true; },
    snapshot() {
      const s = settings();
      const day = dayOf(now(), s.tz);
      const counts = db.prepare("SELECT status, COUNT(*) AS c FROM jobs WHERE type = ? GROUP BY status").all(type);
      const queue = Object.fromEntries(counts.map((r) => [r.status, r.c]));
      const errorsToday = db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE type = ? AND status = 'failed' AND substr(updated_at, 1, 10) = ?").get(type, day).c;
      const doneToday = db.prepare("SELECT COUNT(*) AS c FROM jobs WHERE type = ? AND status = 'done' AND substr(updated_at, 1, 10) = ?").get(type, day).c;
      return {
        id, state: !enabled(s) ? 'paused' : current ? 'running' : (queue.pending ?? 0) > 0 ? 'waiting' : 'idle',
        current, processed_today: doneToday, errors_today: errorsToday, last_activity_at: lastActivity, last_error: lastError, queue,
      };
    },
  };
}

export function createSummarizer({ db, chain, events, settings, now, sleep, paceMs = 2000 }) {
  return createWorker({
    id: 'summarizer', type: 'summarize', db, events, settings, now, sleep, paceMs,
    enabled: (s) => s.ai_enabled,
    handle: async ({ game, settings: s }) => {
      const res = await summarizeGame({ db, chain, game, settings: s, now });
      return { note: res.provider ? `${res.provider}/${res.model}, отброшено пунктов ${res.dropped}${res.degraded ? ', ослабленный ответ' : ''}` : 'мало отзывов' };
    },
  });
}

export function createLetsplay({ db, chain, yt, captions, events, settings, now, sleep, paceMs = 5000 }) {
  return createWorker({
    id: 'letsplay', type: 'letsplay', db, events, settings, now, sleep, paceMs,
    // Let's plays are a bonus: they stop when under 30% of the day's AI budget is left, which stays reserved for review summaries.
    enabled: (s) => s.letsplay_enabled && s.ai_enabled && chain.headroom() > 0.3,
    handle: ({ game, settings: s }) => processLetsplay({ db, chain, yt, captions, game, settings: s, now }),
  });
}

export { recover as recoverJobs };
