import { openDb, migrate } from '../src/db.js';

export function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

export function addGame(db, slug, { processedDay = null, blacklisted = 0 } = {}) {
  db.prepare('INSERT INTO games(slug, title, first_seen_at, processed_day, blacklisted) VALUES (?, ?, ?, ?, ?)')
    .run(slug, slug, '2026-10-01T00:00:00Z', processedDay, blacklisted);
}

export function markProcessed(db, slugs, day) {
  for (const slug of slugs) {
    const hit = db.prepare('UPDATE games SET processed_day = ? WHERE slug = ?').run(day, slug);
    if (hit.changes === 0) addGame(db, slug, { processedDay: day });
  }
}

export function addRun(db, day, status) {
  return Number(db.prepare("INSERT INTO runs(trigger, day, status, started_at) VALUES ('schedule', ?, ?, '2026-10-15T00:00:00Z')").run(day, status).lastInsertRowid);
}

export function addRunItem(db, runId, slug, status) {
  db.prepare("INSERT INTO run_items(run_id, slug, source, status) VALUES (?, ?, 'finder', ?)").run(runId, slug, status);
}

/** Fake sources over fixed lists: home "New Releases" and the paged SEE ALL feed. */
export function fakeSources(newReleaseSlugs, feedSlugs) {
  const calls = { finder: [], newReleases: 0 };
  return {
    calls,
    newReleases: async () => { calls.newReleases++; return newReleaseSlugs; },
    finderPage: async (offset, limit) => { calls.finder.push(offset); return feedSlugs.slice(offset, offset + limit).map((slug) => ({ slug })); },
  };
}

export const range = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);
