import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/mc/client.js';
import { createMockFetch, loadFixtures } from '../src/mc/mock.js';
import { McError } from '../src/mc/errors.js';
import { collectBatch } from '../src/collect.js';
import { fetchGame, persistGame } from '../src/pipeline.js';
import { unpackJson } from '../src/db.js';
import { defaults } from '../src/settings.js';
import { freshDb } from './helpers.js';

const DAY = '2026-10-15';
const settings = defaults();
const mockClient = () => createClient({ apiKey: 't', settings: () => settings, fetchImpl: createMockFetch(loadFixtures()), sleep: async () => {} });
const count = (db, sql, ...args) => db.prepare(sql).get(...args).c;

test('a batch of recorded New Releases games is fetched and saved', async () => {
  const db = freshDb();
  const { picked, results } = await collectBatch({ db, client: mockClient(), settings, day: DAY, n: 2 });
  assert.equal(picked.length, 2);
  assert.ok(picked.every((p) => p.source === 'new_releases'));
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM games WHERE processed_day = ?', DAY), 2);
  assert.ok(count(db, 'SELECT COUNT(*) AS c FROM game_platforms') >= 2);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM review_samples'), 4);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM raw_payloads'), 2);
  const raw = unpackJson(db.prepare('SELECT product FROM raw_payloads').get().product);
  assert.ok(raw.data.item.title);
});

test('a full game with reviews is stored with platforms, history and a balanced sample', async () => {
  const db = freshDb();
  const data = await fetchGame(mockClient(), 'elden-ring', settings);
  const info = persistGame(db, data, { day: DAY });
  assert.equal(info.created, true);
  assert.equal(info.platforms, 5);
  const g = db.prepare('SELECT * FROM games WHERE slug = ?').get('elden-ring');
  assert.equal(g.developer, 'From Software');
  assert.deepEqual(JSON.parse(g.genres), ['Action RPG']);
  assert.equal(g.processed_day, DAY);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM score_history'), 5);
  const critics = unpackJson(db.prepare("SELECT items FROM review_samples WHERE kind = 'critics'").get().items);
  assert.ok(critics.length > 0 && critics.every((r) => r.quote && r.bucket));
  const users = db.prepare("SELECT total FROM review_samples WHERE kind = 'users'").get();
  assert.ok(users.total > 1000);
});

test('saving the same game again updates it without duplicates or new history', async () => {
  const db = freshDb();
  const data = await fetchGame(mockClient(), 'elden-ring', settings);
  persistGame(db, data, { day: DAY });
  const again = persistGame(db, data, { day: '2026-10-16' });
  assert.equal(again.created, false);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM games'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM score_history'), 5, 'unchanged scores add nothing');
  assert.equal(db.prepare('SELECT processed_day FROM games').get().processed_day, '2026-10-16');
});

test('a changed score adds a history row, a vanished platform is removed, admin flags survive', async () => {
  const db = freshDb();
  const data = await fetchGame(mockClient(), 'elden-ring', settings);
  persistGame(db, data, { day: DAY });
  db.prepare('UPDATE games SET hidden = 1, pinned = 1, blacklisted = 1').run();

  const changed = structuredClone(data);
  changed.platforms[0].criticScore = (changed.platforms[0].criticScore ?? 50) - 1;
  changed.platforms.pop();
  persistGame(db, changed, { day: DAY });

  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM score_history'), 6);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM game_platforms'), 4);
  const g = db.prepare('SELECT hidden, pinned, blacklisted FROM games').get();
  assert.deepEqual([g.hidden, g.pinned, g.blacklisted], [1, 1, 1]);
});

test('one failing game does not stop the others', async () => {
  const db = freshDb();
  const base = mockClient();
  const client = { ...base, product: async (s) => { if (s !== 'castlevania-belmonts-curse') throw new McError('http', 'HTTP 500', 500); return base.product(s); } };
  const done = [];
  const failed = [];
  const { results } = await collectBatch({ db, client, settings, day: DAY, n: 2, hooks: { onDone: (i) => done.push(i.slug), onFail: (i) => failed.push(i.slug) } });
  assert.deepEqual(done, ['castlevania-belmonts-curse']);
  assert.equal(failed.length, 1);
  assert.equal(results.filter((r) => !r.ok).length, 1);
  assert.match(results.find((r) => !r.ok).error, /http: HTTP 500/);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM games'), 1);
});

test('an unavailable New Releases block warns and falls back to the feed without closing the source', async () => {
  const db = freshDb();
  const base = mockClient();
  const client = { ...base, newReleases: async () => { throw new McError('network', 'down'); } };
  const warns = [];
  const { picked } = await collectBatch({ db, client, settings, day: DAY, n: 3, dryRun: true, hooks: { onWarn: (m) => warns.push(m) } });
  assert.equal(warns.length, 1);
  assert.equal(picked.length, 3);
  assert.ok(picked.every((p) => p.source === 'finder'));
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM day_cursor'), 0, 'dry run leaves no trace');
});

test('dry run reports the batch and writes nothing', async () => {
  const db = freshDb();
  const { picked, results } = await collectBatch({ db, client: mockClient(), settings, day: DAY, n: 5, dryRun: true });
  assert.equal(picked.length, 5);
  assert.deepEqual(results, []);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM games'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS c FROM day_cursor'), 0);
});

test('shouldStop ends the batch after the current game', async () => {
  const db = freshDb();
  let stop = false;
  const { results } = await collectBatch({ db, client: mockClient(), settings, day: DAY, n: 2,
    hooks: { onDone: () => { stop = true; }, shouldStop: () => stop } });
  assert.equal(results.length, 1);
});
