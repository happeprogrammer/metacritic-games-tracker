import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvents } from '../src/events.js';
import { freshDb } from './helpers.js';

test('events go to the table, the ring and the sink; secrets are masked', () => {
  const db = freshDb();
  const lines = [];
  const ev = createEvents({ db, sink: (l) => lines.push(l), now: () => new Date('2026-10-15T10:00:00Z') });
  ev.info('run', 'hello', { apiKey: 'sk-live-123', nested: { token: 'abc', ok: 1 }, game: 'x' });
  const row = db.prepare('SELECT level, scope, message, data FROM events').get();
  assert.equal(row.level, 'info');
  assert.deepEqual(JSON.parse(row.data), { apiKey: '***', nested: { token: '***', ok: 1 }, game: 'x' });
  assert.ok(!lines[0].includes('sk-live-123') && !JSON.stringify(ev.recent()).includes('abc'));
  assert.equal(JSON.parse(lines[0]).msg, 'hello');
  assert.equal(ev.recent(1)[0].message, 'hello');
});

test('subscribers get events; unsubscribing works; a broken subscriber does not break logging', () => {
  const ev = createEvents({ db: freshDb() });
  const seen = [];
  const off = ev.subscribe((e) => seen.push(e.message));
  ev.subscribe(() => { throw new Error('bad listener'); });
  assert.doesNotThrow(() => ev.warn('x', 'one'));
  off();
  ev.warn('x', 'two');
  assert.deepEqual(seen, ['one']);
});

test('prune keeps only the newest maxRows events', () => {
  const db = freshDb();
  const ev = createEvents({ db, maxRows: () => 3 });
  for (let i = 1; i <= 5; i++) ev.info('x', `m${i}`);
  ev.prune();
  assert.deepEqual(db.prepare('SELECT message FROM events ORDER BY id').all().map((r) => r.message), ['m3', 'm4', 'm5']);
  ev.prune(); // nothing more to cut
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM events').get().c, 3);
});

test('the in-memory ring is capped', () => {
  const ev = createEvents({ db: freshDb(), ringSize: 3 });
  for (let i = 1; i <= 5; i++) ev.info('x', `m${i}`);
  assert.deepEqual(ev.recent().map((e) => e.message), ['m3', 'm4', 'm5']);
});
