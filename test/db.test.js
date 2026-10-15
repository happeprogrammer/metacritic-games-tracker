import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, tx } from '../src/db.js';
import { loadConfig, publicConfig } from '../src/config.js';

const TABLES = ['games', 'game_platforms', 'score_history', 'review_samples', 'summaries', 'letsplay', 'jobs', 'runs',
  'run_items', 'day_cursor', 'settings', 'state', 'audit_log', 'events', 'ai_calls', 'raw_payloads', 'schema_version'];

test('migrations create every table and are idempotent', () => {
  const db = openDb(':memory:');
  const v1 = migrate(db);
  const v2 = migrate(db);
  assert.equal(v1, 1);
  assert.equal(v2, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM schema_version').get().c, 1);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  for (const t of TABLES) assert.ok(names.includes(t), `missing table ${t}`);
});

test('foreign keys are enforced and cascade on delete', () => {
  const db = openDb(':memory:');
  migrate(db);
  assert.throws(() => db.prepare("INSERT INTO game_platforms(game_id, platform_slug, platform_name, updated_at) VALUES (999, 'pc', 'PC', 'x')").run());
  db.prepare("INSERT INTO games(id, slug, title, first_seen_at) VALUES (1, 'g', 'G', 'x')").run();
  db.prepare("INSERT INTO game_platforms(game_id, platform_slug, platform_name, updated_at) VALUES (1, 'pc', 'PC', 'x')").run();
  db.prepare('DELETE FROM games WHERE id = 1').run();
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM game_platforms').get().c, 0);
});

test('tx rolls back on error and returns the result on success', () => {
  const db = openDb(':memory:');
  migrate(db);
  assert.throws(() => tx(db, () => {
    db.prepare("INSERT INTO state(key, value) VALUES ('a', '1')").run();
    throw new Error('boom');
  }), /boom/);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM state').get().c, 0);
  assert.equal(tx(db, () => 42), 42);
});

test('config parses env and publicConfig never exposes secret values', () => {
  const c = loadConfig({ PORT: '4000', MOCK: '1', OPENROUTER_API_KEY: 'sk-secret', SESSION_SECRET: 'zzz' });
  assert.equal(c.port, 4000);
  assert.equal(c.mock, true);
  const shown = JSON.stringify(publicConfig(c));
  assert.ok(!shown.includes('sk-secret') && !shown.includes('zzz'));
  assert.deepEqual(publicConfig(c).providersWithKey, ['openrouter']);
  assert.throws(() => loadConfig({ PORT: '99999' }), /PORT/);
});
