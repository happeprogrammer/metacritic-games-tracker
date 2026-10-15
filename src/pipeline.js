// One game end to end: gather everything from Metacritic, then save it in a single transaction.
import { tx, packJson } from './db.js';
import { sampleReviews } from './reviews.js';

/** Network part. Skips review requests when the counts say there is nothing to read. */
export async function fetchGame(client, slug, s) {
  const product = await client.product(slug);
  const platforms = [];
  for (const p of product.platforms.slice(0, s.max_platforms_per_game)) {
    const u = await client.userStats(slug, p.slug);
    platforms.push({ ...p, userScore: u.score, userCount: u.count });
  }

  const hasCritic = platforms.some((p) => p.criticCount > 0);
  const hasUsers = platforms.some((p) => p.userCount > 0);

  const critics = { total: 0, items: [] };
  for (let page = 0; hasCritic && page < s.critic_pages; page++) {
    const r = await client.criticReviews(slug, page * 10);
    critics.total = r.total;
    critics.items.push(...r.items);
    if (r.items.length < 10 || critics.items.length >= r.total) break;
  }
  const users = hasUsers ? await client.userReviews(slug, 0, s.user_page_size) : { total: 0, items: [] };

  return { slug, product, platforms, critics, users };
}

/** Save one fetched game; marks it processed for `day`. Admin flags (hidden/pinned/blacklisted) are never touched. */
export function persistGame(db, data, { day, now = () => new Date(), source = 'finder', sample = { critic: 40, user: 40 } }) {
  const ts = now().toISOString();
  const g = data.product.game;
  const genres = JSON.stringify(g.genres);
  const publishers = JSON.stringify(g.publishers);

  return tx(db, () => {
    const found = db.prepare('SELECT id FROM games WHERE slug = ?').get(data.slug);
    let id;
    if (found) {
      id = found.id;
      db.prepare(`UPDATE games SET title=?, release_date=?, description=?, cover_url=?, developer=?, publishers=?, genres=?,
        esrb=?, video_url=?, video_title=?, last_fetched_at=?, processed_day=? WHERE id=?`)
        .run(g.title, g.releaseDate, g.description, g.coverUrl, g.developer, publishers, genres, g.esrb, g.videoUrl, g.videoTitle, ts, day, id);
    } else {
      id = Number(db.prepare(`INSERT INTO games(slug, title, release_date, description, cover_url, developer, publishers, genres,
        esrb, video_url, video_title, first_seen_at, last_fetched_at, processed_day, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(data.slug, g.title, g.releaseDate, g.description, g.coverUrl, g.developer, publishers, genres, g.esrb, g.videoUrl, g.videoTitle, ts, ts, day, source).lastInsertRowid);
    }

    const upsertPlatform = db.prepare(`INSERT INTO game_platforms(game_id, platform_slug, platform_name, is_lead, release_date,
      critic_score, critic_count, user_score, user_count, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(game_id, platform_slug) DO UPDATE SET platform_name=excluded.platform_name, is_lead=excluded.is_lead,
      release_date=excluded.release_date, critic_score=excluded.critic_score, critic_count=excluded.critic_count,
      user_score=excluded.user_score, user_count=excluded.user_count, updated_at=excluded.updated_at`);
    const lastHistory = db.prepare('SELECT critic_score, critic_count, user_score, user_count FROM score_history WHERE game_id=? AND platform_slug=? ORDER BY id DESC LIMIT 1');
    const addHistory = db.prepare('INSERT INTO score_history(game_id, platform_slug, critic_score, critic_count, user_score, user_count, captured_at) VALUES (?,?,?,?,?,?,?)');
    for (const p of data.platforms) {
      upsertPlatform.run(id, p.slug, p.name, p.isLead ? 1 : 0, p.releaseDate, p.criticScore, p.criticCount, p.userScore, p.userCount, ts);
      const last = lastHistory.get(id, p.slug);
      const changed = !last || last.critic_score !== p.criticScore || last.critic_count !== p.criticCount ||
        last.user_score !== p.userScore || last.user_count !== p.userCount;
      if (changed) addHistory.run(id, p.slug, p.criticScore, p.criticCount, p.userScore, p.userCount, ts);
    }
    const keep = data.platforms.map((p) => p.slug);
    db.prepare(`DELETE FROM game_platforms WHERE game_id=? AND platform_slug NOT IN (${keep.map(() => '?').join(',') || "''"})`).run(id, ...keep);

    const saveSample = db.prepare(`INSERT INTO review_samples(game_id, kind, items, total, fetched_at) VALUES (?,?,?,?,?)
      ON CONFLICT(game_id, kind) DO UPDATE SET items=excluded.items, total=excluded.total, fetched_at=excluded.fetched_at`);
    saveSample.run(id, 'critics', packJson(sampleReviews(data.critics.items, { kind: 'critics', cap: sample.critic })), data.critics.total, ts);
    saveSample.run(id, 'users', packJson(sampleReviews(data.users.items, { kind: 'users', cap: sample.user })), data.users.total, ts);

    db.prepare(`INSERT INTO raw_payloads(game_id, product, fetched_at) VALUES (?,?,?)
      ON CONFLICT(game_id) DO UPDATE SET product=excluded.product, fetched_at=excluded.fetched_at`).run(id, packJson(data.product.raw), ts);

    return { gameId: id, created: !found, platforms: data.platforms.length };
  });
}
