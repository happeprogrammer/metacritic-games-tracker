import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/mc/client.js';
import { createMockFetch, loadFixtures } from '../src/mc/mock.js';
import { fetchGame, persistGame } from '../src/pipeline.js';
import { createChain } from '../src/ai/chain.js';
import { mockAdapter } from '../src/ai/providers.js';
import { AiError, AiUnavailable, AiValidationError } from '../src/ai/errors.js';
import { enabledGroups, inputHash, loadSamples, norm, planSummary, summarizeGame, validateSummary } from '../src/ai/summarize.js';
import { createSummarizer } from '../src/workers.js';
import { createEvents } from '../src/events.js';
import * as jobs from '../src/jobs.js';
import { defaults } from '../src/settings.js';
import { packJson } from '../src/db.js';
import { freshDb, addGame } from './helpers.js';

const settings = defaults();
const mockClient = () => createClient({ apiKey: 't', settings: () => settings, fetchImpl: createMockFetch(loadFixtures()), sleep: async () => {} });
const DAY = '2026-10-15';

async function dbWithElden() {
  const db = freshDb();
  persistGame(db, await fetchGame(mockClient(), 'elden-ring', settings), { day: DAY });
  return { db, game: { ...db.prepare("SELECT * FROM games WHERE slug = 'elden-ring'").get() } };
}
const chainFor = (db, adapters = { groq: mockAdapter('groq') }, overrides = {}) => createChain({
  db, adapters, settings: () => ({ ...settings, ai_providers: [{ id: 'groq', enabled: true, model: 'g', daily_cap: 100 }], ...overrides }), sleep: async () => {},
});
const putSample = (db, gameId, kind, items, total = items.length) =>
  db.prepare('INSERT OR REPLACE INTO review_samples(game_id, kind, items, total, fetched_at) VALUES (?,?,?,?,?)').run(gameId, kind, packJson(items), total, 'x');
const review = (i, quote, score = 9) => ({ id: `r${i}`, quote, score, date: '2026-10-01', who: 'p', spoiler: false });
const Q1 = 'The combat feels incredibly satisfying and every boss fight is memorable';
const Q2 = 'Performance on PC is terrible with constant stuttering and frame drops';
const QS = [review(1, Q1), review(2, Q2, 3), review(3, 'An enormous open world full of secrets to discover everywhere')];

test('norm compares texts ignoring case, punctuation and spacing', () => {
  assert.equal(norm('  "Great", game!!  — really… '), 'great game really');
  assert.equal(norm('ЧУДЕСНАЯ игра, правда?'), 'чудесная игра правда');
});

test('grounded points are kept, invented ones dropped, aspects default to none', () => {
  const samples = { critics: { items: QS, total: 3 }, users: { items: [], total: 0 } };
  const text = JSON.stringify({ critics: {
    likes: [{ text: 'Отличная боёвка', evidence: 'the combat feels incredibly satisfying, and every boss fight is memorable' }, { text: 'Выдуманное', evidence: 'the soundtrack was composed by a famous orchestra of angels' }],
    dislikes: [{ text: 'Производительность на ПК', evidence: Q2 }, { text: 'Короткая цитата', evidence: 'terrible' }],
    aspects: { gameplay: 'praise', performance: 'criticism', story: 'amazing' },
  } });
  const v = validateSummary(text, ['critics'], samples);
  assert.deepEqual(v.critics.likes.map((p) => p.text), ['Отличная боёвка']);
  assert.deepEqual(v.critics.dislikes.map((p) => p.text), ['Производительность на ПК']);
  assert.equal(v.dropped, 2);
  assert.equal(v.critics.aspects.gameplay, 'praise');
  assert.equal(v.critics.aspects.story, 'none', 'unknown value becomes none');
  assert.equal(v.critics.aspects.price, 'none');
});

test('evidence must come from the same group of reviews', () => {
  const samples = { critics: { items: [review(1, Q1)], total: 1 }, users: { items: [review(2, Q2, 2)], total: 1 } };
  const text = JSON.stringify({
    critics: { likes: [{ text: 'a', evidence: Q1 }], dislikes: [], aspects: {} },
    users: { likes: [{ text: 'b', evidence: Q1 }], dislikes: [{ text: 'c', evidence: Q2 }], aspects: {} },
  });
  const v = validateSummary(text, ['critics', 'users'], samples);
  assert.equal(v.critics.likes.length, 1);
  assert.equal(v.users.likes.length, 0, 'a critic quote cannot back a player point');
  assert.equal(v.users.dislikes.length, 1);
});

test('weak answers throw with a usable fallback, empty ones without; bad shape is rejected', () => {
  const samples = { critics: { items: QS, total: 3 }, users: { items: [], total: 0 } };
  const mostlyFake = JSON.stringify({ critics: { likes: [{ text: 'ok', evidence: Q1 }], dislikes: [{ text: 'x', evidence: 'completely made up sentence number one' }, { text: 'y', evidence: 'completely made up sentence number two' }], aspects: {} } });
  assert.throws(() => validateSummary(mostlyFake, ['critics'], samples), (e) => e instanceof AiValidationError && e.fallback?.critics.likes.length === 1 && e.score === 1);
  const nothing = JSON.stringify({ critics: { likes: [], dislikes: [], aspects: {} } });
  assert.throws(() => validateSummary(nothing, ['critics'], samples), (e) => e.fallback === null);
  assert.throws(() => validateSummary('hello', ['critics'], samples), /нет JSON/);
  assert.throws(() => validateSummary('{"users":{}}', ['critics'], samples), /нет блока critics/);
});

test('planSummary: too few reviews are recorded as insufficient and queue nothing', () => {
  const db = freshDb();
  addGame(db, 'tiny');
  const id = db.prepare("SELECT id FROM games WHERE slug = 'tiny'").get().id;
  putSample(db, id, 'critics', [review(1, Q1)], 1);
  putSample(db, id, 'users', [], 0);
  assert.equal(planSummary(db, id, settings), 'none');
  assert.deepEqual(db.prepare('SELECT kind, status FROM summaries ORDER BY kind').all().map((r) => `${r.kind}:${r.status}`), ['critics:insufficient', 'users:insufficient']);
  assert.equal(jobs.stats(db).pending, 0);
});

test('planSummary: queues once, stays fresh when nothing changed, re-queues on real change after the minimum age', async () => {
  const { db, game } = await dbWithElden();
  let t = new Date('2026-10-15T10:00:00Z');
  const now = () => new Date(t);
  assert.equal(planSummary(db, game.id, settings, now), 'queued');
  assert.equal(planSummary(db, game.id, settings, now), 'queued', 'idempotent: still one job');
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM jobs').get().c, 1);
  assert.equal(db.prepare("SELECT status FROM summaries WHERE kind = 'critics'").get().status, 'pending');

  await summarizeGame({ db, chain: chainFor(db), game, settings, now });
  db.prepare("UPDATE jobs SET status = 'done'").run();
  assert.equal(planSummary(db, game.id, settings, now), 'fresh');

  // reviews changed a lot, but too soon
  const samples = loadSamples(db, game.id);
  putSample(db, game.id, 'users', [...samples.users.items, review(99, 'Brand new review that changes the hash of the sample for sure')], samples.users.total * 2);
  t = new Date(t.getTime() + 3600_000);
  assert.equal(planSummary(db, game.id, settings, now), 'fresh', 'younger than resummarize_min_hours');
  t = new Date(t.getTime() + 13 * 3600_000);
  assert.equal(planSummary(db, game.id, settings, now), 'queued');
});

test('planSummary: a changed sample with a tiny count change is ignored until the summary is a week old', async () => {
  const { db, game } = await dbWithElden();
  let t = new Date('2026-10-15T10:00:00Z');
  const now = () => new Date(t);
  await summarizeGame({ db, chain: chainFor(db), game, settings, now });
  const samples = loadSamples(db, game.id);
  putSample(db, game.id, 'users', [...samples.users.items, review(98, 'Another fresh review text long enough to be a valid sample entry')], samples.users.total + 1);
  t = new Date(t.getTime() + 2 * 86_400_000);
  assert.equal(planSummary(db, game.id, settings, now), 'fresh');
  t = new Date(t.getTime() + 6 * 86_400_000);
  assert.equal(planSummary(db, game.id, settings, now), 'queued');
});

test('summarizeGame saves critics and players separately with provider, model, hash and dropped count', async () => {
  const { db, game } = await dbWithElden();
  const out = await summarizeGame({ db, chain: chainFor(db), game, settings });
  assert.deepEqual(out.groups, ['critics', 'users']);
  const rows = db.prepare('SELECT * FROM summaries ORDER BY kind').all();
  assert.deepEqual(rows.map((r) => [r.kind, r.status, r.provider, r.prompt_version]), [['critics', 'ok', 'groq', 'v1'], ['users', 'ok', 'groq', 'v1']]);
  const samples = loadSamples(db, game.id);
  assert.equal(rows[0].input_hash, inputHash(samples, ['critics', 'users']));
  assert.equal(rows[0].reviews_total, samples.critics.total);
  assert.ok(JSON.parse(rows[0].likes).length > 0);
  assert.ok(JSON.parse(rows[1].likes).every((p) => p.text && p.evidence));
  assert.deepEqual(Object.keys(JSON.parse(rows[0].aspects)).length, 7);
  const call = db.prepare('SELECT purpose, ok, game_id, prompt_version FROM ai_calls').get();
  assert.deepEqual({ ...call }, { purpose: 'summary', ok: 1, game_id: game.id, prompt_version: 'v1' });
});

test('with only one group big enough, only that group is summarised', async () => {
  const { db, game } = await dbWithElden();
  putSample(db, game.id, 'users', [review(1, Q2, 2)], 1);
  const out = await summarizeGame({ db, chain: chainFor(db), game, settings });
  assert.deepEqual(out.groups, ['critics']);
});

test('enabledGroups and inputHash behave', () => {
  const s = { critics: { items: QS, total: 3 }, users: { items: [], total: 0 } };
  assert.deepEqual(enabledGroups(s, 3), ['critics']);
  assert.deepEqual(enabledGroups(s, 4), []);
  assert.equal(inputHash(s, ['critics']), inputHash({ ...s, critics: { items: [...QS].reverse(), total: 3 } }, ['critics']), 'order does not matter');
  assert.notEqual(inputHash(s, ['critics']), inputHash({ ...s, critics: { items: QS.slice(1), total: 3 } }, ['critics']));
});

// ---------- jobs ----------
test('jobs: enqueue never duplicates and keeps a running job running', () => {
  const db = freshDb();
  addGame(db, 'a');
  jobs.enqueue(db, { type: 'summarize', gameId: 1 });
  jobs.enqueue(db, { type: 'summarize', gameId: 1, force: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM jobs').get().c, 1);
  assert.equal(db.prepare('SELECT force FROM jobs').get().force, 1);
  const job = jobs.claimNext(db, { type: 'summarize' });
  jobs.enqueue(db, { type: 'summarize', gameId: 1 });
  assert.equal(db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.id).status, 'running');
});

test('jobs: games with the most reviews go first; future, blacklisted and other types are skipped', () => {
  const db = freshDb();
  for (const s of ['few', 'many', 'mid', 'banned', 'later']) addGame(db, s, { blacklisted: s === 'banned' ? 1 : 0 });
  const id = (s) => db.prepare('SELECT id FROM games WHERE slug = ?').get(s).id;
  putSample(db, id('few'), 'users', [], 5); putSample(db, id('many'), 'users', [], 5000); putSample(db, id('mid'), 'users', [], 300);
  putSample(db, id('banned'), 'users', [], 9999); putSample(db, id('later'), 'users', [], 8000);
  for (const s of ['few', 'many', 'mid', 'banned']) jobs.enqueue(db, { type: 'summarize', gameId: id(s) });
  jobs.enqueue(db, { type: 'summarize', gameId: id('later'), delayMs: 3600_000 });
  jobs.enqueue(db, { type: 'letsplay', gameId: id('mid') });
  const order = [];
  for (let j = jobs.claimNext(db, { type: 'summarize' }); j; j = jobs.claimNext(db, { type: 'summarize' })) order.push(db.prepare('SELECT slug FROM games WHERE id = ?').get(j.game_id).slug);
  assert.deepEqual(order, ['many', 'mid', 'few']);
});

test('jobs: failures back off, give up after the limit, deferral costs no attempt, recovery and retry work', () => {
  const db = freshDb();
  addGame(db, 'a');
  let t = new Date('2026-10-15T10:00:00Z');
  const now = () => new Date(t);
  jobs.enqueue(db, { type: 'summarize', gameId: 1, now });
  const get = () => ({ ...db.prepare('SELECT * FROM jobs').get() });

  let job = jobs.claimNext(db, { type: 'summarize', now });
  assert.equal(jobs.fail(db, job.id, 'e1', { maxAttempts: 3, now }), 'retry');
  assert.equal(get().next_at, '2026-10-15T10:05:00.000Z');
  assert.equal(jobs.claimNext(db, { type: 'summarize', now }), null, 'not due yet');
  t = new Date(t.getTime() + 6 * 60_000);
  job = jobs.claimNext(db, { type: 'summarize', now });
  jobs.defer(db, job.id, 600_000, 'no_provider', now);
  assert.equal(get().attempts, 1, 'deferral is not an attempt');
  assert.equal(get().status, 'pending');
  t = new Date(t.getTime() + 11 * 60_000);
  job = jobs.claimNext(db, { type: 'summarize', now });
  assert.equal(jobs.fail(db, job.id, 'e2', { maxAttempts: 3, now }), 'retry');
  t = new Date(t.getTime() + 20 * 60_000);
  job = jobs.claimNext(db, { type: 'summarize', now });
  assert.equal(jobs.fail(db, job.id, 'e3', { maxAttempts: 3, now }), 'failed');
  assert.equal(get().status, 'failed');
  assert.equal(jobs.stats(db).failed, 1);
  assert.equal(jobs.retryFailed(db, now), 1);
  assert.equal(get().attempts, 0);
  jobs.claimNext(db, { type: 'summarize', now });
  assert.equal(jobs.recover(db), 1);
  assert.equal(get().status, 'pending');
  const only = jobs.list(db, { status: 'pending' });
  assert.equal(only[0].slug, 'a');
  assert.equal(jobs.skip(db, get().id, now), 1);
});

// ---------- worker ----------
function workerFor(db, chain, overrides = {}) {
  return createSummarizer({ db, chain, events: createEvents({ db }), settings: () => ({ ...settings, ...overrides }), sleep: async () => {} });
}

test('worker: a queued game becomes summaries, the job is done, the snapshot counts it', async () => {
  const { db, game } = await dbWithElden();
  planSummary(db, game.id, settings);
  const w = workerFor(db, chainFor(db));
  assert.equal(await w.runOnce(), 'done');
  assert.equal(await w.runOnce(), 'idle');
  assert.equal(db.prepare("SELECT status FROM summaries WHERE kind = 'users'").get().status, 'ok');
  assert.equal(jobs.stats(db).done, 1);
  assert.equal(w.snapshot().processed_today >= 0, true);
  assert.equal(w.snapshot().state, 'idle');
});

test('worker: unavailable AI defers the job without using an attempt; other errors fail with backoff', async () => {
  const { db, game } = await dbWithElden();
  planSummary(db, game.id, settings);
  const w1 = workerFor(db, chainFor(db, {}), {});
  assert.equal(await w1.runOnce(), 'deferred');
  const j = db.prepare('SELECT status, attempts, error FROM jobs').get();
  assert.deepEqual({ ...j }, { status: 'pending', attempts: 0, error: 'no_provider' });
  assert.equal(await w1.runOnce(), 'idle', 'deferred job is not due yet');

  db.prepare("UPDATE jobs SET next_at = '2000-01-01T00:00:00.000Z'").run();
  const broken = { complete: async () => { throw new Error('unexpected bug'); } };
  const w2 = workerFor(db, { complete: broken.complete });
  assert.equal(await w2.runOnce(), 'failed');
  const j2 = db.prepare('SELECT status, attempts, error FROM jobs').get();
  assert.equal(j2.attempts, 1);
  assert.match(j2.error, /unexpected bug/);
  assert.equal(w2.snapshot().last_error, 'unexpected bug');
});

test('worker: does nothing while AI is switched off', async () => {
  const { db, game } = await dbWithElden();
  planSummary(db, game.id, settings);
  const w = workerFor(db, chainFor(db), { ai_enabled: false });
  assert.equal(await w.runOnce(), 'disabled');
  assert.equal(w.snapshot().state, 'paused');
  assert.equal(jobs.stats(db).pending, 1);
});

test('AiError subclasses carry what the queue needs', () => {
  const u = new AiUnavailable('all_failed', 5000, new AiError('rate_limit', 'x'));
  assert.equal(u.retryAfterMs, 5000);
  assert.match(u.message, /all_failed/);
});
