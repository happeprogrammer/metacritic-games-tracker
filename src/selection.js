// Which games to take in a run. Pure of network: sources are injected, so every rule is unit-testable.

/** Calendar day YYYY-MM-DD in the given IANA time zone. */
export function dayOf(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

const getCursor = (db, day, source) =>
  db.prepare('SELECT next_offset, pages, exhausted FROM day_cursor WHERE day = ? AND source = ?').get(day, source) ??
  { next_offset: 0, pages: 0, exhausted: 0 };

const setCursor = (db, day, source, c) =>
  db.prepare(`INSERT INTO day_cursor(day, source, next_offset, pages, exhausted) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(day, source) DO UPDATE SET next_offset = excluded.next_offset, pages = excluded.pages, exhausted = excluded.exhausted`)
    .run(day, source, c.next_offset, c.pages, c.exhausted);

/** Slugs from earlier runs of this day that failed or were cut off, still under the attempt limit. */
function retryCandidates(db, day, retryMax) {
  return db.prepare(`SELECT ri.slug FROM run_items ri JOIN runs r ON r.id = ri.run_id
    WHERE r.day = ? AND r.status != 'running' AND ri.status IN ('failed', 'pending', 'running')
    GROUP BY ri.slug HAVING COUNT(*) < ? ORDER BY MIN(ri.id)`).all(day, retryMax).map((r) => r.slug);
}

/**
 * Pick up to n games not yet processed today. Order: (a) retries, (b) the home-page "New Releases" list,
 * (c) the SEE ALL feed continuing from the saved offset. Returns [{slug, source}].
 * persist=false (dry run) reads cursors but never writes them.
 */
export async function pickBatch({ db, day, n, newReleases, finderPage, maxPages = 50, retryMax = 3, persist = true }) {
  const picked = [];
  const seen = new Set();
  const take = (slug, source) => {
    if (picked.length >= n || seen.has(slug)) return;
    seen.add(slug);
    picked.push({ slug, source });
  };
  const done = (slug) => {
    const g = db.prepare('SELECT processed_day, blacklisted FROM games WHERE slug = ?').get(slug);
    return Boolean(g && (g.blacklisted || g.processed_day === day));
  };

  for (const slug of retryCandidates(db, day, retryMax)) if (!done(slug)) take(slug, 'retry');

  const nr = getCursor(db, day, 'new_releases');
  if (!nr.exhausted && picked.length < n) {
    const slugs = await newReleases();
    for (const slug of slugs) if (!done(slug)) take(slug, 'new_releases');
    const left = slugs.filter((s) => !done(s) && !seen.has(s));
    if (left.length === 0 && persist) setCursor(db, day, 'new_releases', { ...nr, exhausted: 1 });
  }

  const fc = getCursor(db, day, 'finder');
  if (!fc.exhausted && picked.length < n) {
    let { next_offset: offset, pages, exhausted } = fc;
    while (picked.length < n) {
      if (pages >= maxPages) { exhausted = 1; break; }
      const items = await finderPage(offset, 20);
      pages++;
      if (items.length === 0) { exhausted = 1; break; }
      let scanned = 0;
      for (const it of items) {
        scanned++;
        if (!done(it.slug)) take(it.slug, 'finder');
        if (picked.length >= n) break;
      }
      offset += scanned; // advance by what we actually looked at, so the next run continues exactly here
    }
    if (persist) setCursor(db, day, 'finder', { next_offset: offset, pages, exhausted });
  }
  return picked;
}
