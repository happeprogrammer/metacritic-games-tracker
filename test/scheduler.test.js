import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from '../src/scheduler.js';
import { createEvents } from '../src/events.js';
import { createClient } from '../src/mc/client.js';
import { createMockFetch, loadFixtures } from '../src/mc/mock.js';
import { loadSettings, setSettings } from '../src/settings.js';
import { getState, setState } from '../src/state.js';
import { pickBatch, dayOf } from '../src/selection.js';
import { freshDb, addRun, addRunItem } from './helpers.js';

/** Fake batch collector: drives the same hooks the real one does. */
function fakeCollect({ slugs = ['a', 'b', 'c'], failing = [], warn = false, beforeEach = null, boom = null } = {}) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    if (boom) throw boom;
    const { hooks, n, dryRun } = args;
    const picked = slugs.slice(0, n).map((slug) => ({ slug, source: 'finder' }));
    hooks.onPicked(picked);
    if (warn) hooks.onWarn('часть источника недоступна');
    if (dryRun) return { picked, results: [] };
    const results = [];
    for (const it of picked) {
      if (hooks.shouldStop()) break;
      hooks.onStart(it);
      await beforeEach?.(it);
      if (failing.includes(it.slug)) {
        const err = Object.assign(new Error('boom'), { kind: 'http' });
        hooks.onFail(it, err);
        results.push({ slug: it.slug, ok: false });
      } else {
        hooks.onDone(it, {});
        results.push({ slug: it.slug, ok: true });
      }
    }
    return { picked, results };
  };
  fn.calls = calls;
  return fn;
}

function harness(opts = {}) {
  const db = freshDb();
  let t = new Date(opts.start ?? '2026-10-15T10:00:00Z');
  const events = createEvents({ db, now: () => new Date(t) });
  const timers = { setInterval: () => ({ unref() {} }), clearInterval() {} };
  const collect = opts.collect ?? fakeCollect();
  const checkCalls = [];
  const checkSource = opts.checkSource ?? (async () => { checkCalls.push(1); });
  const scheduler = createScheduler({ db, client: {}, events, now: () => new Date(t), collect, checkSource, timers });
  return {
    db, events, scheduler, collect, checkCalls,
    advance: (ms) => { t = new Date(t.getTime() + ms); },
    run: (id) => db.prepare('SELECT * FROM runs WHERE id = ?').get(id),
    items: (id) => db.prepare('SELECT slug, status FROM run_items WHERE run_id = ? ORDER BY id').all(id).map((r) => ({ ...r })),
  };
}

test('a manual admin run records the run, its items and events, and keeps the schedule untouched', async () => {
  const h = harness();
  const r = h.scheduler.runNow({ role: 'admin' });
  assert.equal(r.ok, true);
  await r.promise;
  const run = h.run(r.runId);
  assert.equal(run.status, 'done');
  assert.equal(run.trigger, 'manual');
  assert.deepEqual([run.picked, run.ok, run.failed], [3, 3, 0]);
  assert.deepEqual(h.items(r.runId).map((i) => i.status), ['done', 'done', 'done']);
  assert.ok(h.events.recent().some((e) => /начат/.test(e.message)));
  assert.equal(getState(h.db, 'next_run_at'), null);
  assert.equal(h.scheduler.isRunning(), false);
});

test('tick starts a due run, keeps the hourly grid and does nothing when not due', async () => {
  const h = harness();
  const first = await h.scheduler.tick();
  assert.equal(first.started, true);
  await first.promise;
  assert.equal(getState(h.db, 'next_run_at'), '2026-10-15T11:00:00.000Z');

  h.advance(30 * 60_000);
  assert.equal((await h.scheduler.tick()).started, false);

  h.advance(30 * 60_000 + 20_000); // 11:00:20, a little late
  const second = await h.scheduler.tick();
  assert.equal(second.started, true);
  await second.promise;
  assert.equal(getState(h.db, 'next_run_at'), '2026-10-15T12:00:00.000Z', 'grid stays on the hour');
  assert.equal(h.db.prepare("SELECT COUNT(*) AS c FROM runs WHERE trigger = 'schedule'").get().c, 2);
});

test('after downtime there is exactly one catch-up run and the grid restarts from now', async () => {
  const h = harness();
  setState(h.db, 'next_run_at', '2026-10-15T06:00:00.000Z');
  const boot = await h.scheduler.start();
  assert.equal(boot.started, true);
  await boot.promise;
  assert.equal(h.db.prepare("SELECT COUNT(*) AS c FROM runs WHERE trigger = 'startup'").get().c, 1);
  assert.equal(getState(h.db, 'next_run_at'), '2026-10-15T11:00:00.000Z');
  assert.equal((await h.scheduler.tick()).started, false, 'no series of catch-up runs');
});

test('pause and a disabled scheduler stop scheduled runs; resume brings them back', async () => {
  const h = harness();
  h.scheduler.pause('admin');
  assert.equal((await h.scheduler.tick()).started, false);
  h.scheduler.resume('admin');
  setSettings(h.db, { scheduler_enabled: false });
  assert.equal((await h.scheduler.tick()).started, false);
  setSettings(h.db, { scheduler_enabled: true });
  const t = await h.scheduler.tick();
  assert.equal(t.started, true);
  await t.promise;
});

test('only one run at a time', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ collect: fakeCollect({ beforeEach: () => gate }) });
  const first = h.scheduler.runNow({ role: 'admin' });
  assert.equal(h.scheduler.isRunning(), true);
  assert.deepEqual(h.scheduler.runNow({ role: 'admin' }), { ok: false, reason: 'busy' });
  assert.equal((await h.scheduler.tick()).started, false);
  assert.equal(h.scheduler.snapshot().scheduler.state, 'running');
  release();
  await first.promise;
  assert.equal(h.scheduler.snapshot().scheduler.state, 'idle');
});

test('cancel ends the run as cancelled after the current game', async () => {
  let h;
  const collect = fakeCollect({ beforeEach: () => { h.scheduler.cancel('admin'); } });
  h = harness({ collect });
  const r = h.scheduler.runNow({ role: 'admin' });
  await r.promise;
  const run = h.run(r.runId);
  assert.equal(run.status, 'cancelled');
  assert.equal(run.ok, 1);
  assert.equal(h.scheduler.cancel(), false, 'nothing to cancel any more');
});

test('viewer runs are limited by cooldown, daily cap, pause and the public switch; admin is not', async () => {
  const h = harness();
  setSettings(h.db, { public_run_daily_cap: 2 });
  const a = h.scheduler.runNow({ role: 'viewer' });
  assert.equal(a.ok, true);
  await a.promise;

  const cool = h.scheduler.runNow({ role: 'viewer' });
  assert.equal(cool.reason, 'cooldown');
  assert.ok(cool.retry_in_s > 55 && cool.retry_in_s <= 60);

  h.advance(61_000);
  await h.scheduler.runNow({ role: 'viewer' }).promise;
  h.advance(61_000);
  assert.equal(h.scheduler.runNow({ role: 'viewer' }).reason, 'daily_cap');
  await h.scheduler.runNow({ role: 'admin' }).promise; // admin bypasses the cap

  setSettings(h.db, { public_run_daily_cap: 50 });
  h.scheduler.pause();
  assert.equal(h.scheduler.runNow({ role: 'viewer' }).reason, 'paused');
  h.scheduler.resume();
  setSettings(h.db, { public_run_enabled: false });
  assert.equal(h.scheduler.runNow({ role: 'viewer' }).reason, 'disabled');
  assert.equal(h.scheduler.manualGate().allowed, false);
});

test('viewers cannot steer a run; admin parameters are validated', async () => {
  const h = harness();
  const v = h.scheduler.runNow({ role: 'viewer', params: { dryRun: true, limit: 1, source: 'finder' } });
  await v.promise;
  assert.equal(h.collect.calls[0].dryRun, false);
  assert.equal(h.collect.calls[0].n, 20);

  assert.equal(h.scheduler.runNow({ role: 'admin', params: { source: 'x' } }).reason, 'bad_params');
  assert.equal(h.scheduler.runNow({ role: 'admin', params: { limit: 0 } }).reason, 'bad_params');
  assert.equal(h.scheduler.runNow({ role: 'admin', params: { offset: -1 } }).reason, 'bad_params');
});

test('an admin dry run only reports what would be taken', async () => {
  const h = harness();
  const r = h.scheduler.runNow({ role: 'admin', params: { dryRun: true, limit: 2, source: 'finder', offset: 40 } });
  await r.promise;
  const run = h.run(r.runId);
  assert.equal(run.status, 'done');
  assert.equal(run.picked, 2);
  assert.match(run.note, /^пробный запуск, взяли бы 2: a, b/);
  assert.equal(h.items(r.runId).length, 0);
  assert.equal(h.checkCalls.length, 0, 'no source probe for a dry run');
  assert.deepEqual([h.collect.calls[0].only, h.collect.calls[0].startOffset], ['finder', 40]);
});

test('a failing source check fails the run and turns the source red', async () => {
  const h = harness({ checkSource: async () => { throw new Error('нет связи'); } });
  const r = h.scheduler.runNow({ role: 'admin' });
  await r.promise;
  assert.equal(h.run(r.runId).status, 'failed');
  assert.match(h.run(r.runId).note, /нет связи/);
  assert.equal(getState(h.db, 'source').status, 'red');
  assert.equal(h.collect.calls.length, 0);
});

test('a crash inside collection fails the run and the scheduler stays usable', async () => {
  const h = harness({ collect: fakeCollect({ boom: new Error('сломалось') }) });
  const r = h.scheduler.runNow({ role: 'admin' });
  await r.promise;
  assert.equal(h.run(r.runId).status, 'failed');
  assert.equal(h.scheduler.isRunning(), false);
  assert.equal(h.scheduler.runNow({ role: 'admin' }).ok, true);
});

test('no successes means failed; warnings mean degraded; schema errors mean degraded', async () => {
  const allBad = harness({ collect: fakeCollect({ failing: ['a', 'b', 'c'] }) });
  const r1 = allBad.scheduler.runNow({ role: 'admin' });
  await r1.promise;
  assert.equal(allBad.run(r1.runId).status, 'failed');
  assert.equal(getState(allBad.db, 'source').status, 'red');

  const warned = harness({ collect: fakeCollect({ warn: true }) });
  const r2 = warned.scheduler.runNow({ role: 'admin' });
  await r2.promise;
  assert.equal(warned.run(r2.runId).status, 'degraded');
  assert.equal(getState(warned.db, 'source').status, 'yellow');

  const partly = harness({ collect: fakeCollect({ failing: ['b'] }) });
  const r3 = partly.scheduler.runNow({ role: 'admin' });
  await r3.promise;
  assert.equal(partly.run(r3.runId).status, 'done', 'one failed game of three is normal');
  assert.equal(partly.run(r3.runId).failed, 1);
  assert.equal(getState(partly.db, 'source').status, 'green');
});

test('recovery marks interrupted runs and puts their games back into the retry queue', async () => {
  const h = harness();
  const day = dayOf(new Date('2026-10-15T10:00:00Z'), loadSettings(h.db).tz);
  const run = addRun(h.db, day, 'running');
  addRunItem(h.db, run, 'cut-mid-fetch', 'running');
  addRunItem(h.db, run, 'never-started', 'pending');
  addRunItem(h.db, run, 'already-done', 'done');

  assert.equal(h.scheduler.recover(), 1);
  assert.equal(h.run(run).status, 'interrupted');
  assert.deepEqual(h.items(run).map((i) => i.status), ['pending', 'pending', 'done']);
  assert.equal(h.scheduler.recover(), 0, 'idempotent');

  const batch = await pickBatch({ db: h.db, day, n: 5, newReleases: async () => [], finderPage: async () => [] });
  assert.deepEqual(batch.map((b) => b.slug), ['cut-mid-fetch', 'never-started']);
});

test('stop finishes the current game and marks the run interrupted', async () => {
  let h;
  let stopped;
  const collect = fakeCollect({ beforeEach: () => { stopped = h.scheduler.stop(1000); } });
  h = harness({ collect });
  const r = h.scheduler.runNow({ role: 'admin' });
  await r.promise;
  await stopped;
  const run = h.run(r.runId);
  assert.equal(run.status, 'interrupted');
  assert.equal(run.ok, 1, 'the game in progress was finished');
});

test('end to end on recorded data: scheduler + real collection + default source probe', async () => {
  const db = freshDb();
  const events = createEvents({ db });
  const settings = () => loadSettings(db);
  const client = createClient({ apiKey: 't', settings, fetchImpl: createMockFetch(loadFixtures()), sleep: async () => {} });
  const scheduler = createScheduler({ db, client, events, settings, timers: { setInterval: () => ({ unref() {} }), clearInterval() {} } });

  const r = scheduler.runNow({ role: 'admin', params: { limit: 2 } });
  await r.promise;
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(r.runId);
  assert.equal(run.status, 'done', run.note);
  assert.deepEqual([run.picked, run.ok, run.failed], [2, 2, 0]);
  assert.deepEqual(db.prepare('SELECT status FROM run_items').all().map((i) => i.status), ['done', 'done']);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM games').get().c, 2);
  const snap = scheduler.snapshot();
  assert.equal(snap.workers.find((w) => w.id === 'fetcher').processed_today, 2);
  assert.equal(snap.source.status, 'green');

  // the same games are not taken again today: the next two New Releases are picked instead. They are not in the
  // fixtures, so each fails on its own (404) and, with nothing succeeding, the run is honestly marked failed.
  const again = scheduler.runNow({ role: 'admin', params: { limit: 2, source: 'new_releases' } });
  await again.promise;
  const second = db.prepare('SELECT * FROM runs WHERE id = ?').get(again.runId);
  assert.equal(second.status, 'failed');
  assert.deepEqual([second.picked, second.ok, second.failed], [2, 0, 2]);
  assert.notDeepEqual(
    db.prepare('SELECT slug FROM run_items WHERE run_id = ? ORDER BY id').all(r.runId).map((i) => i.slug),
    db.prepare('SELECT slug FROM run_items WHERE run_id = ? ORDER BY id').all(again.runId).map((i) => i.slug),
  );
});

test('snapshot shows scheduler, workers, manual-run gate and source status', async () => {
  const h = harness();
  const s0 = h.scheduler.snapshot();
  assert.equal(s0.scheduler.state, 'idle');
  assert.equal(s0.workers.length, 2);
  assert.equal(s0.manual_run.allowed, true);
  assert.equal(s0.source.status, 'unknown');
  await h.scheduler.runNow({ role: 'admin' }).promise;
  const s1 = h.scheduler.snapshot();
  assert.equal(s1.scheduler.last_run.status, 'done');
  assert.equal(s1.source.status, 'green');
});
