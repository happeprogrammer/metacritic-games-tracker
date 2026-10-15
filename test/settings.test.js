import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGISTRY, coerce, defaults, loadSettings, setSettings } from '../src/settings.js';
import { freshDb } from './helpers.js';

const def = (key) => REGISTRY.find((d) => d.key === key);

test('every default passes its own validation', () => {
  for (const d of REGISTRY) assert.deepEqual(coerce(d, structuredClone(d.def)), d.def, d.key);
});

test('numbers must respect their bounds', () => {
  assert.throws(() => coerce(def('interval_min'), 1), /5\.\.1440/);
  assert.throws(() => coerce(def('batch_size'), 101), /1\.\.100/);
  assert.throws(() => coerce(def('batch_size'), 20.5), /целое/);
  assert.equal(coerce(def('interval_min'), 5), 5);
});

test('time zone, enum and url are checked', () => {
  assert.throws(() => coerce(def('tz'), 'Mars/Olympus'), /часовой пояс/);
  assert.throws(() => coerce(def('youtube_mode'), 'scrape'), /допустимо/);
  assert.throws(() => coerce(def('notify_webhook_url'), 'ftp://x'), /http/);
  assert.equal(coerce(def('notify_webhook_url'), ''), '');
});

test('OpenRouter accepts only :free models', () => {
  const providers = (model) => [{ id: 'openrouter', enabled: true, model, daily_cap: 10 }];
  assert.throws(() => coerce(def('ai_providers'), providers('openai/gpt-4o')), /:free/);
  assert.throws(() => coerce(def('ai_providers'), providers('a/b:free, c/d')), /:free/);
  assert.doesNotThrow(() => coerce(def('ai_providers'), providers('a/b:free, c/d:free')));
});

test('provider list rejects unknown ids and duplicates', () => {
  const p = (id) => ({ id, enabled: true, model: 'm', daily_cap: 1 });
  assert.throws(() => coerce(def('ai_providers'), [p('skynet')]), /id из/);
  assert.throws(() => coerce(def('ai_providers'), [p('groq'), p('groq')]), /повторяется/);
});

test('setSettings stores values, audits the change and loadSettings reads them back', () => {
  const db = freshDb();
  assert.equal(loadSettings(db).interval_min, 60);
  const out = setSettings(db, { interval_min: 30, ai_enabled: false }, { actor: 'admin', ip: '1.2.3.4' });
  assert.equal(out.interval_min, 30);
  assert.equal(out.ai_enabled, false);
  const rows = db.prepare("SELECT actor, ip, action, detail FROM audit_log ORDER BY id").all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].actor, 'admin');
  assert.equal(rows[0].action, 'settings.set');
  assert.deepEqual(JSON.parse(rows[0].detail), { key: 'interval_min', from: 60, to: 30 });
});

test('an invalid patch changes nothing', () => {
  const db = freshDb();
  assert.throws(() => setSettings(db, { interval_min: 30, batch_size: 0 }), /batch_size/);
  assert.throws(() => setSettings(db, { nope: 1 }), /неизвестная/);
  assert.equal(loadSettings(db).interval_min, 60);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM settings').get().c, 0);
});

test('a corrupt stored value falls back to the default', () => {
  const db = freshDb();
  db.prepare("INSERT INTO settings(key, value, updated_at) VALUES ('interval_min', '\"abc\"', 'x')").run();
  assert.equal(loadSettings(db).interval_min, defaults().interval_min);
});
