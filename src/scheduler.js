// Hourly runs, manual runs, pause/cancel, crash recovery. One run at a time; run bookkeeping lives in runs/run_items.
import { dayOf, slotOf } from './selection.js';
import { collectBatch } from './collect.js';
import { getState, setState } from './state.js';
import { loadSettings } from './settings.js';

const TICK_MS = 30_000;
const HEARTBEAT_MS = 10_000;
const PROBE_SLUG = 'elden-ring';
const SOURCES = ['auto', 'new_releases', 'finder'];

/** Cheap health probe of the source: one known game must parse with at least one platform. */
async function defaultCheckSource(client) {
  const p = await client.product(PROBE_SLUG);
  if (!p.game.title || p.platforms.length === 0) throw new Error('карточка контрольной игры пришла пустой');
}

export function createScheduler({
  db, client, events, now = () => new Date(), settings = () => loadSettings(db),
  collect = collectBatch, checkSource = defaultCheckSource, timers = { setInterval, clearInterval },
}) {
  let active = null; // the run in progress
  let timer = null;
  let stopping = false;
  let bootCatchup = false;
  let lastRun = null;

  const paused = () => getState(db, 'paused', false) === true;
  const nextRunAt = () => { const v = getState(db, 'next_run_at'); return v ? new Date(v) : null; };
  const iso = (d = now()) => d.toISOString();

  /** Mark runs left "running" by a crash as interrupted; their items become retry candidates. */
  function recover() {
    const stuck = db.prepare("SELECT COUNT(*) AS c FROM runs WHERE status = 'running'").get().c;
    if (!stuck) return 0;
    db.prepare("UPDATE runs SET status = 'interrupted', finished_at = ?, note = 'прерван перезапуском сервиса' WHERE status = 'running'").run(iso());
    db.prepare("UPDATE run_items SET status = 'pending' WHERE status = 'running'").run();
    events.warn('scheduler', `Найдено прерванных прогонов: ${stuck}. Их игры вернутся в очередь.`);
    return stuck;
  }

  function setSourceStatus(status, error = null) {
    setState(db, 'source', { status, at: iso(), error });
  }

  async function execute(run, params, s) {
    const items = new Map(); // slug -> run_items.id
    let warned = false;
    let schemaErrors = 0;
    const beat = timers.setInterval(() => db.prepare('UPDATE runs SET heartbeat_at = ? WHERE id = ?').run(iso(), run.id), HEARTBEAT_MS);
    beat.unref?.();
    const finish = (status, note = null) => {
      db.prepare('UPDATE runs SET status = ?, finished_at = ?, picked = ?, ok = ?, failed = ?, skipped = ?, note = ? WHERE id = ?')
        .run(status, iso(), run.picked, run.done, run.failed, run.skipped, note, run.id);
      lastRun = { id: run.id, trigger: run.trigger, status, started_at: run.started_at, finished_at: iso(), picked: run.picked, ok: run.done, failed: run.failed };
      events.log(status === 'done' ? 'info' : 'warn', 'run', `Прогон ${run.id} завершён: ${status}, взято ${run.picked}, готово ${run.done}, ошибок ${run.failed}`);
    };

    try {
      if (!params.dryRun) {
        try { await checkSource(client); } catch (e) {
          setSourceStatus('red', e.message);
          events.error('source', `Проверка источника не прошла: ${e.message}`);
          finish('failed', `источник недоступен: ${e.message}`);
          return;
        }
      }
      const n = params.limit ?? s.batch_size;
      const { picked, results } = await collect({
        db, client, settings: s, day: run.day, n, now, dryRun: Boolean(params.dryRun),
        only: params.source === 'new_releases' || params.source === 'finder' ? params.source : null,
        startOffset: Number.isInteger(params.offset) ? params.offset : null,
        hooks: {
          onPicked: (batch) => {
            run.picked = batch.length;
            if (params.dryRun) return;
            const add = db.prepare("INSERT INTO run_items(run_id, slug, source, status) VALUES (?, ?, ?, 'pending')");
            for (const it of batch) items.set(it.slug, Number(add.run(run.id, it.slug, it.source).lastInsertRowid));
            events.info('run', `Прогон ${run.id}: взято игр ${batch.length}`, { sources: [...new Set(batch.map((b) => b.source))] });
          },
          onStart: (it) => {
            run.current = it.slug;
            db.prepare("UPDATE run_items SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ?").run(iso(), items.get(it.slug));
          },
          onDone: (it) => {
            run.done++;
            run.current = null;
            const started = db.prepare('SELECT started_at FROM run_items WHERE id = ?').get(items.get(it.slug)).started_at;
            db.prepare("UPDATE run_items SET status = 'done', finished_at = ?, duration_ms = ? WHERE id = ?")
              .run(iso(), now().getTime() - new Date(started).getTime(), items.get(it.slug));
          },
          onFail: (it, err) => {
            run.failed++;
            run.current = null;
            if (err.kind === 'schema') schemaErrors++;
            db.prepare("UPDATE run_items SET status = 'failed', finished_at = ?, error = ? WHERE id = ?")
              .run(iso(), `${err.kind ?? 'error'}: ${err.message}`.slice(0, 500), items.get(it.slug));
            events.warn('run', `Игра ${it.slug}: ошибка`, { error: err.message, kind: err.kind });
          },
          onWarn: (msg) => { warned = true; events.warn('run', msg); },
          shouldStop: () => run.cancel || stopping,
        },
      });
      if (params.dryRun) {
        finish('done', `пробный запуск, взяли бы ${picked.length}: ${picked.map((p) => p.slug).join(', ')}`.slice(0, 500));
      } else if (stopping) {
        finish('interrupted', 'остановка сервиса');
      } else if (run.cancel) {
        finish('cancelled', 'отменён вручную');
      } else if (picked.length > 0 && run.done === 0) {
        setSourceStatus('red', 'ни одна игра не обработана');
        finish('failed', 'ни одна игра не обработана');
      } else if (warned || schemaErrors >= 3) {
        setSourceStatus('yellow', warned ? 'часть источника недоступна' : 'формат ответа изменился');
        finish('degraded', warned ? 'часть источника недоступна' : 'формат ответа изменился');
      } else {
        setSourceStatus('green');
        finish('done', picked.length === 0 ? 'нечего брать' : null);
      }
    } catch (err) {
      events.error('run', `Прогон ${run.id} упал: ${err.message}`);
      finish('failed', err.message.slice(0, 300));
    } finally {
      timers.clearInterval(beat);
      active = null;
    }
  }

  function startRun(trigger, params = {}) {
    if (active) return { ok: false, reason: 'busy' };
    const s = settings();
    const t = now();
    const day = dayOf(t, s.tz);
    const id = Number(db.prepare("INSERT INTO runs(trigger, slot, day, status, params, started_at, heartbeat_at) VALUES (?, ?, ?, 'running', ?, ?, ?)")
      .run(trigger, slotOf(t, s.tz), day, JSON.stringify(params), iso(t), iso(t)).lastInsertRowid);
    const run = { id, trigger, day, started_at: iso(t), cancel: false, picked: 0, done: 0, failed: 0, skipped: 0, current: null };
    active = run;
    events.info('run', `Прогон ${id} начат (${trigger})${params.dryRun ? ', пробный' : ''}`);
    run.promise = execute(run, params, s);
    return { ok: true, runId: id, promise: run.promise };
  }

  /** Called every 30 s: start the scheduled run when it is due. */
  async function tick() {
    if (stopping || active) return { started: false };
    const s = settings();
    if (!s.scheduler_enabled || paused()) return { started: false };
    const t = now();
    const due = nextRunAt();
    if (due && t < due) return { started: false };
    const trigger = bootCatchup ? 'startup' : 'schedule';
    bootCatchup = false;
    // On time: keep the grid (due + interval). Late (service was down): restart the grid from now, no catch-up series.
    const base = due && t.getTime() - due.getTime() < s.interval_min * 60_000 ? due : t;
    setState(db, 'next_run_at', iso(new Date(base.getTime() + s.interval_min * 60_000)));
    const r = startRun(trigger);
    return { started: r.ok, promise: r.promise };
  }

  /** Manual run. Viewers are limited (switch, pause, cooldown, daily cap) and cannot steer; admins can. */
  function runNow({ role = 'viewer', params = {} } = {}) {
    const s = settings();
    const t = now();
    const day = dayOf(t, s.tz);
    if (active) return { ok: false, reason: 'busy' };
    let clean = {};
    if (role === 'admin') {
      if (params.source !== undefined && !SOURCES.includes(params.source)) return { ok: false, reason: 'bad_params', detail: 'source' };
      if (params.offset !== undefined && !(Number.isInteger(params.offset) && params.offset >= 0)) return { ok: false, reason: 'bad_params', detail: 'offset' };
      if (params.limit !== undefined && !(Number.isInteger(params.limit) && params.limit >= 1 && params.limit <= 100)) return { ok: false, reason: 'bad_params', detail: 'limit' };
      clean = { source: params.source, offset: params.offset, limit: params.limit, dryRun: params.dryRun === true };
    } else {
      const gate = manualGate();
      if (!gate.allowed) return { ok: false, reason: gate.reason, retry_in_s: gate.cooldown_left_s };
      setState(db, 'last_manual_at', iso(t));
      setState(db, `manual:${day}`, gate.used_today + 1);
    }
    return startRun('manual', clean);
  }

  /** What a viewer may do right now (also shown on the monitor). */
  function manualGate() {
    const s = settings();
    const t = now();
    const used = getState(db, `manual:${dayOf(t, s.tz)}`, 0);
    const last = getState(db, 'last_manual_at');
    const left = last ? Math.max(0, Math.ceil((new Date(last).getTime() + s.public_run_cooldown_s * 1000 - t.getTime()) / 1000)) : 0;
    let reason = null;
    if (active) reason = 'busy';
    else if (!s.public_run_enabled) reason = 'disabled';
    else if (paused() || !s.scheduler_enabled) reason = 'paused';
    else if (left > 0) reason = 'cooldown';
    else if (used >= s.public_run_daily_cap) reason = 'daily_cap';
    return { allowed: reason === null, reason, cooldown_left_s: left, used_today: used, cap: s.public_run_daily_cap };
  }

  function pause(actor = 'system') { setState(db, 'paused', true); events.info('scheduler', `Планировщик поставлен на паузу (${actor})`); }
  function resume(actor = 'system') { setState(db, 'paused', false); events.info('scheduler', `Планировщик продолжил работу (${actor})`); }
  function cancel(actor = 'system') {
    if (!active) return false;
    active.cancel = true;
    events.info('run', `Прогон ${active.id}: отмена запрошена (${actor}), текущая игра дорабатывается`);
    return true;
  }

  function snapshot() {
    const s = settings();
    const day = dayOf(now(), s.tz);
    const processedToday = db.prepare('SELECT COUNT(*) AS c FROM games WHERE processed_day = ?').get(day).c;
    const errorsToday = db.prepare("SELECT COUNT(*) AS c FROM run_items ri JOIN runs r ON r.id = ri.run_id WHERE r.day = ? AND ri.status = 'failed'").get(day).c;
    const lastItem = db.prepare('SELECT finished_at, error, status FROM run_items WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get();
    const lastError = db.prepare("SELECT error FROM run_items WHERE status = 'failed' ORDER BY id DESC LIMIT 1").get();
    const items = active ? db.prepare('SELECT slug, status FROM run_items WHERE run_id = ? ORDER BY id LIMIT 100').all(active.id).map((r) => ({ ...r })) : [];
    return {
      scheduler: {
        enabled: s.scheduler_enabled, paused: paused(), state: active ? 'running' : 'idle',
        next_run_at: getState(db, 'next_run_at'), last_run: lastRun ?? db.prepare('SELECT id, trigger, status, started_at, finished_at, picked, ok, failed FROM runs ORDER BY id DESC LIMIT 1').get() ?? null,
      },
      run: active ? { id: active.id, trigger: active.trigger, day: active.day, picked: active.picked, done: active.done, failed: active.failed, skipped: active.skipped, current: active.current, items } : null,
      workers: [
        { id: 'scheduler', state: !s.scheduler_enabled || paused() ? 'paused' : active ? 'running' : 'waiting', current: null, processed_today: null, errors_today: null, last_activity_at: lastRun?.finished_at ?? null, last_error: null },
        { id: 'fetcher', state: active ? 'running' : 'idle', current: active?.current ?? null, processed_today: processedToday, errors_today: errorsToday, last_activity_at: lastItem?.finished_at ?? null, last_error: lastError?.error ?? null },
      ],
      manual_run: manualGate(),
      source: getState(db, 'source', { status: 'unknown', at: null, error: null }),
    };
  }

  function start() {
    recover();
    const due = nextRunAt();
    bootCatchup = !due || due <= now();
    timer = timers.setInterval(() => { tick().catch((e) => events.error('scheduler', `tick: ${e.message}`)); }, TICK_MS);
    timer.unref?.();
    return tick();
  }

  /** Graceful stop: no new games, wait for the current one (up to timeoutMs), then mark the run interrupted. */
  async function stop(timeoutMs = 20_000) {
    stopping = true;
    if (timer) timers.clearInterval(timer);
    if (!active) return;
    const run = active;
    await Promise.race([run.promise, new Promise((r) => setTimeout(r, timeoutMs).unref?.())]);
    if (active === run) {
      db.prepare("UPDATE runs SET status = 'interrupted', finished_at = ?, note = 'остановка сервиса' WHERE id = ? AND status = 'running'").run(iso(), run.id);
    }
  }

  return { start, tick, recover, runNow, manualGate, pause, resume, cancel, snapshot, stop, isRunning: () => active !== null };
}
