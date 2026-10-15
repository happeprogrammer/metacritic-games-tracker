import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayOf, pickBatch } from '../src/selection.js';
import { freshDb, addGame, markProcessed, addRun, addRunItem, fakeSources, range } from './helpers.js';

const DAY = '2026-10-15';
const slugs = (batch) => batch.map((b) => b.slug);

test('dayOf follows the configured time zone', () => {
  const d = new Date('2026-10-14T21:30:00Z');
  assert.equal(dayOf(d, 'Europe/Moscow'), '2026-10-15');
  assert.equal(dayOf(d, 'UTC'), '2026-10-14');
});

test('first batch of the day comes from New Releases and closes that source', async () => {
  const db = freshDb();
  const nr = range('n', 1, 20);
  const src = fakeSources(nr, range('f', 1, 200));
  const batch = await pickBatch({ db, day: DAY, n: 20, ...src });
  assert.deepEqual(slugs(batch), nr);
  assert.ok(batch.every((b) => b.source === 'new_releases'));
  assert.equal(src.calls.finder.length, 0, 'feed is not touched while New Releases fills the batch');
  assert.equal(db.prepare("SELECT exhausted FROM day_cursor WHERE day = ? AND source = 'new_releases'").get(DAY).exhausted, 1);
});

test('next batches continue the feed exactly, without gaps or repeats', async () => {
  const db = freshDb();
  const feed = range('f', 1, 200);
  const src = fakeSources(range('n', 1, 20), feed);
  markProcessed(db, slugs(await pickBatch({ db, day: DAY, n: 20, ...src })), DAY);

  const second = await pickBatch({ db, day: DAY, n: 20, ...src });
  markProcessed(db, slugs(second), DAY);
  const third = await pickBatch({ db, day: DAY, n: 20, ...src });

  assert.deepEqual(slugs(second), range('f', 1, 20));
  assert.deepEqual(slugs(third), range('f', 21, 40));
  assert.ok(second.every((b) => b.source === 'finder'));
});

test('a partly used page resumes at the exact position', async () => {
  const db = freshDb();
  const src = fakeSources([], range('f', 1, 100));
  const first = await pickBatch({ db, day: DAY, n: 5, ...src });
  markProcessed(db, slugs(first), DAY);
  const next = await pickBatch({ db, day: DAY, n: 5, ...src });
  assert.deepEqual(slugs(first), range('f', 1, 5));
  assert.deepEqual(slugs(next), range('f', 6, 10));
  assert.equal(db.prepare("SELECT next_offset FROM day_cursor WHERE day = ? AND source = 'finder'").get(DAY).next_offset, 10);
});

test('games already processed today and blacklisted games are skipped but passed over', async () => {
  const db = freshDb();
  markProcessed(db, ['f1', 'f2'], DAY);
  addGame(db, 'f3', { blacklisted: 1 });
  const src = fakeSources([], range('f', 1, 50));
  const batch = await pickBatch({ db, day: DAY, n: 3, ...src });
  assert.deepEqual(slugs(batch), ['f4', 'f5', 'f6']);
  assert.equal(db.prepare("SELECT next_offset FROM day_cursor WHERE day = ? AND source = 'finder'").get(DAY).next_offset, 6);
});

test('a new day starts from scratch, even for games processed yesterday', async () => {
  const db = freshDb();
  const nr = range('n', 1, 20);
  const src = fakeSources(nr, range('f', 1, 200));
  markProcessed(db, slugs(await pickBatch({ db, day: DAY, n: 20, ...src })), DAY);
  const tomorrow = await pickBatch({ db, day: '2026-10-16', n: 20, ...src });
  assert.deepEqual(slugs(tomorrow), nr);
  assert.ok(tomorrow.every((b) => b.source === 'new_releases'));
});

test('a short New Releases list is topped up from the feed in the same batch', async () => {
  const db = freshDb();
  const src = fakeSources(range('n', 1, 5), range('f', 1, 100));
  const batch = await pickBatch({ db, day: DAY, n: 8, ...src });
  assert.deepEqual(slugs(batch), [...range('n', 1, 5), 'f1', 'f2', 'f3']);
});

test('failed and interrupted items are retried first, up to the attempt limit', async () => {
  const db = freshDb();
  const run = addRun(db, DAY, 'interrupted');
  addRunItem(db, run, 'bad1', 'failed');
  addRunItem(db, run, 'cut1', 'pending');
  const src = fakeSources(range('n', 1, 20), []);
  const batch = await pickBatch({ db, day: DAY, n: 5, ...src });
  assert.deepEqual(slugs(batch).slice(0, 2), ['bad1', 'cut1']);
  assert.ok(batch.slice(0, 2).every((b) => b.source === 'retry'));

  for (let i = 0; i < 2; i++) addRunItem(db, addRun(db, DAY, 'done'), 'bad1', 'failed');
  const later = await pickBatch({ db, day: DAY, n: 5, retryMax: 3, ...src });
  assert.ok(!slugs(later).includes('bad1'), 'three failures today means we stop retrying');
});

test('items of a still-running run are not retried', async () => {
  const db = freshDb();
  addRunItem(db, addRun(db, DAY, 'running'), 'busy1', 'running');
  const batch = await pickBatch({ db, day: DAY, n: 5, ...fakeSources([], range('f', 1, 10)) });
  assert.ok(!slugs(batch).includes('busy1'));
});

test('the page limit ends the feed for the day', async () => {
  const db = freshDb();
  const src = fakeSources([], range('f', 1, 1000));
  const batch = await pickBatch({ db, day: DAY, n: 100, maxPages: 2, ...src });
  assert.equal(batch.length, 40);
  assert.equal(db.prepare("SELECT exhausted FROM day_cursor WHERE day = ? AND source = 'finder'").get(DAY).exhausted, 1);
  const again = await pickBatch({ db, day: DAY, n: 10, maxPages: 2, ...src });
  assert.equal(again.length, 0);
});

test('an unavailable New Releases (null) is skipped but stays open for the next try', async () => {
  const db = freshDb();
  const src = fakeSources([], range('f', 1, 50));
  const batch = await pickBatch({ db, day: DAY, n: 3, ...src, newReleases: async () => null });
  assert.deepEqual(slugs(batch), ['f1', 'f2', 'f3']);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM day_cursor WHERE source = 'new_releases'").get().c, 0);
});

test('an empty source gives an empty batch without errors', async () => {
  const db = freshDb();
  assert.deepEqual(await pickBatch({ db, day: DAY, n: 20, ...fakeSources([], []) }), []);
});

test('dry run (persist=false) never writes cursors', async () => {
  const db = freshDb();
  const batch = await pickBatch({ db, day: DAY, n: 20, persist: false, ...fakeSources(range('n', 1, 20), range('f', 1, 50)) });
  assert.equal(batch.length, 20);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM day_cursor').get().c, 0);
});
