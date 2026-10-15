// Operator actions on games and the queue (used by the admin API). Fetching shares the client's request spacing.
import { fetchGame, persistGame } from './pipeline.js';
import { planSummary } from './ai/summarize.js';
import { enqueue } from './jobs.js';
import { dayOf } from './selection.js';
import { tx } from './db.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;

export function slugFrom(input) {
  const s = String(input ?? '').trim();
  const fromUrl = /metacritic\.com\/game\/([a-z0-9][a-z0-9-]*)/.exec(s)?.[1];
  const slug = fromUrl ?? s;
  return SLUG.test(slug) ? slug : null;
}

export function createManage({ db, client, settings, events, scheduler, onGameSaved, now = () => new Date() }) {
  const busy = new Set();

  /** Fetch and save one game in the background; refuses a slug that is already being fetched. */
  function fetchOne(slug, source = 'manual', actor = 'admin') {
    if (busy.has(slug)) return { ok: false, reason: 'busy' };
    busy.add(slug);
    const s = settings();
    (async () => {
      try {
        const data = await fetchGame(client, slug, s);
        const info = persistGame(db, data, { day: dayOf(now(), s.tz), now, source, sample: { critic: s.review_sample_critic, user: s.review_sample_user } });
        onGameSaved?.(info.gameId);
        events.info('manage', `Игра ${slug} загружена вручную (${actor})`);
      } catch (e) {
        events.warn('manage', `Игра ${slug}: не загрузилась (${e.kind ?? 'error'}: ${e.message})`);
      } finally {
        busy.delete(slug);
      }
    })();
    return { ok: true };
  }

  function addGame(input, actor) {
    const slug = slugFrom(input);
    if (!slug) return { ok: false, reason: 'bad_slug' };
    return { ...fetchOne(slug, 'manual', actor), slug };
  }

  /** stages: any of 'data' (refetch), 'summary' (force a new summary), 'letsplay'. */
  function reprocess(slug, stages = ['data', 'summary'], actor = 'admin') {
    const game = db.prepare('SELECT id FROM games WHERE slug = ?').get(slug);
    if (!game) return { ok: false, reason: 'not_found' };
    const done = [];
    if (stages.includes('data')) { const r = fetchOne(slug, 'manual', actor); if (!r.ok) return r; done.push('data'); }
    if (stages.includes('summary')) { planSummary(db, game.id, settings(), now, { force: true }); done.push('summary'); }
    if (stages.includes('letsplay')) { db.prepare('DELETE FROM letsplay WHERE game_id = ?').run(game.id); enqueue(db, { type: 'letsplay', gameId: game.id, force: true, now }); done.push('letsplay'); }
    events.info('manage', `Игра ${slug}: повторная обработка (${done.join(', ')}) по запросу ${actor}`);
    return { ok: true, stages: done };
  }

  /** Queue fresh summaries for every game that has review samples (e.g. after a prompt change). */
  function recomputeSummaries(actor = 'admin') {
    let n = 0;
    for (const g of db.prepare('SELECT id FROM games WHERE blacklisted = 0').all()) if (planSummary(db, g.id, settings(), now, { force: true }) === 'queued') n++;
    events.info('manage', `Пересчёт резюме: поставлено в очередь ${n} игр (${actor})`);
    return { ok: true, queued: n };
  }

  function setFlags(slug, flags) {
    const sets = [];
    const args = [];
    for (const k of ['hidden', 'pinned', 'blacklisted']) {
      if (flags[k] === undefined) continue;
      if (typeof flags[k] !== 'boolean') return { ok: false, reason: 'bad_params', detail: k };
      sets.push(`${k} = ?`);
      args.push(flags[k] ? 1 : 0);
    }
    if (!sets.length) return { ok: false, reason: 'bad_params' };
    const r = db.prepare(`UPDATE games SET ${sets.join(', ')} WHERE slug = ?`).run(...args, slug);
    return r.changes ? { ok: true } : { ok: false, reason: 'not_found' };
  }

  const deleteGame = (slug) => (db.prepare('DELETE FROM games WHERE slug = ?').run(slug).changes ? { ok: true } : { ok: false, reason: 'not_found' });

  /** Reset today's selection: both sources, or one, optionally restarting the feed at an offset. */
  function resetCursor({ source = 'all', offset = null }) {
    const day = dayOf(now(), settings().tz);
    if (offset !== null && !(Number.isInteger(offset) && offset >= 0)) return { ok: false, reason: 'bad_params', detail: 'offset' };
    tx(db, () => {
      if (source === 'all') db.prepare('DELETE FROM day_cursor WHERE day = ?').run(day);
      else db.prepare('DELETE FROM day_cursor WHERE day = ? AND source = ?').run(day, source);
      if (offset !== null) db.prepare("INSERT INTO day_cursor(day, source, next_offset, pages, exhausted) VALUES (?, 'finder', ?, 0, 0)").run(day, offset);
    });
    events.info('manage', `Курсор дня сброшен: ${source}${offset !== null ? `, лента с позиции ${offset}` : ''}`);
    return { ok: true, day };
  }

  async function checkSource() {
    const t0 = Date.now();
    try {
      const p = await client.product('elden-ring');
      const ok = p.game.title && p.platforms.length > 0;
      return { status: ok ? 'green' : 'red', ms: Date.now() - t0, detail: ok ? `${p.platforms.length} платформ, поля на месте` : 'карточка пустая' };
    } catch (e) {
      return { status: 'red', ms: Date.now() - t0, detail: `${e.kind ?? 'error'}: ${e.message}` };
    }
  }

  const exportRows = () => db.prepare('SELECT id, slug, title, developer, release_date, genres, esrb, video_url, last_fetched_at FROM games WHERE hidden = 0 ORDER BY title').all().map((g) => {
    const plat = db.prepare('SELECT platform_slug, platform_name, critic_score, critic_count, user_score, user_count FROM game_platforms WHERE game_id = ?').all(g.id).map((p) => ({ ...p }));
    const sums = db.prepare("SELECT kind, likes, dislikes, aspects, provider, model FROM summaries WHERE game_id = ? AND status = 'ok'").all(g.id)
      .map((s) => ({ kind: s.kind, likes: JSON.parse(s.likes), dislikes: JSON.parse(s.dislikes), aspects: JSON.parse(s.aspects), provider: s.provider, model: s.model }));
    return { slug: g.slug, title: g.title, developer: g.developer, release_date: g.release_date, genres: JSON.parse(g.genres), esrb: g.esrb, video_url: g.video_url, last_fetched_at: g.last_fetched_at, platforms: plat, summaries: sums };
  });

  function exportCsv() {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = exportRows().map((g) => [g.slug, g.title, g.developer, g.release_date, g.genres.join('; '), g.platforms.map((p) => `${p.platform_name} ${p.critic_score ?? '-'}/${p.user_score ?? '-'}`).join('; ')].map(q).join(','));
    return `slug,title,developer,release_date,genres,platforms (critic/user)\n${rows.join('\n')}\n`;
  }

  return { addGame, fetchOne, reprocess, recomputeSummaries, setFlags, deleteGame, resetCursor, checkSource, exportRows, exportCsv };
}
