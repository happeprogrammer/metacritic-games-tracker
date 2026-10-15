// JSON API (/api/v1). Each route: { method, path, role, handler(ctx) -> {status?, json?|csv?|download?, headers?} }.
import { REGISTRY, setSettings, defaults } from './settings.js';
import * as jobs from './jobs.js';

const ASPECTS = ['gameplay', 'story', 'visuals_audio', 'performance', 'controls', 'multiplayer', 'price'];
const int = (v, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const escLike = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
const parse = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const bad = (message) => ({ status: 400, json: { error: message } });
const RUN_STATUS = { busy: 409, cooldown: 429, daily_cap: 429, paused: 403, disabled: 403, bad_params: 400 };

export function createApi(app) {
  const { db, settings, events, scheduler, chain, manage, similar, auth, cfg } = app;
  const rows = (sql, ...args) => db.prepare(sql).all(...args).map((r) => ({ ...r }));
  const row = (sql, ...args) => { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; };

  // ---------------- games ----------------
  const SORTS = { critic: 'critic_best', user: 'user_best', gap: 'gap', release: 'release_date', updated: 'last_fetched_at', title: 'title' };

  function listGames(q) {
    const page = clamp(int(q.page, 1), 1, 10_000);
    const per = clamp(int(q.per, 24), 1, 100);
    const where = ['g.hidden = 0'];
    const args = [];
    if (q.q) { where.push("(g.title LIKE ? ESCAPE '\\' OR g.developer LIKE ? ESCAPE '\\')"); const like = `%${escLike(q.q.slice(0, 100))}%`; args.push(like, like); }
    if (q.platform) { where.push('EXISTS (SELECT 1 FROM game_platforms p WHERE p.game_id = g.id AND p.platform_slug = ?)'); args.push(q.platform); }
    if (q.genre) { where.push('EXISTS (SELECT 1 FROM json_each(g.genres) j WHERE j.value = ?)'); args.push(q.genre); }
    if (q.year) { where.push('substr(g.release_date, 1, 4) = ?'); args.push(q.year); }
    if (q.aspect) {
      const [verdict, aspect] = q.aspect.split(':');
      if (!['praise', 'criticism'].includes(verdict) || !ASPECTS.includes(aspect)) return null;
      where.push("EXISTS (SELECT 1 FROM summaries s WHERE s.game_id = g.id AND s.status = 'ok' AND json_extract(s.aspects, '$.' || ?) = ?)");
      args.push(aspect, verdict);
    }
    const sortCol = SORTS[q.sort] ?? 'last_fetched_at';
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
    const inner = `SELECT g.id, g.slug, g.title, g.cover_url, g.developer, g.genres, g.release_date, g.last_fetched_at,
      (SELECT MAX(critic_score) FROM game_platforms WHERE game_id = g.id) AS critic_best,
      (SELECT MAX(user_score) FROM game_platforms WHERE game_id = g.id) AS user_best
      FROM games g WHERE ${where.join(' AND ')}`;
    const outer = `SELECT *, CASE WHEN critic_best IS NOT NULL AND user_best IS NOT NULL THEN ROUND(ABS(critic_best / 10.0 - user_best), 1) END AS gap FROM (${inner})`;
    const total = row(`SELECT COUNT(*) AS c FROM (${inner})`, ...args).c;
    const items = rows(`${outer} ORDER BY ${sortCol} IS NULL, ${sortCol} ${dir}, title LIMIT ? OFFSET ?`, ...args, per, (page - 1) * per);
    const ids = items.map((i) => i.id);
    const mark = ids.map(() => '?').join(',') || 'NULL';
    const plats = rows(`SELECT game_id, platform_slug, platform_name, critic_score, user_score, is_lead FROM game_platforms WHERE game_id IN (${mark}) ORDER BY is_lead DESC, platform_name`, ...ids);
    const sums = rows(`SELECT game_id, kind, status, aspects FROM summaries WHERE game_id IN (${mark})`, ...ids);
    for (const it of items) {
      it.genres = parse(it.genres, []);
      it.platforms = plats.filter((p) => p.game_id === it.id).map((p) => ({ slug: p.platform_slug, name: p.platform_name, critic: p.critic_score, user: p.user_score }));
      const mine = sums.filter((s) => s.game_id === it.id);
      it.summary_status = mine.some((s) => s.status === 'ok') ? 'ok' : mine.some((s) => s.status === 'pending') ? 'pending' : mine.some((s) => s.status === 'insufficient') ? 'insufficient' : 'none';
      const praise = new Set();
      const criticism = new Set();
      for (const s of mine.filter((x) => x.status === 'ok')) {
        for (const [k, v] of Object.entries(parse(s.aspects, {}))) (v === 'praise' ? praise : v === 'criticism' ? criticism : { add() {} }).add(k);
      }
      it.praise = [...praise].slice(0, 3);
      it.criticism = [...criticism].slice(0, 3);
      delete it.id;
    }
    return { items, total, page, per };
  }

  function facets() {
    return {
      platforms: rows(`SELECT p.platform_slug AS slug, p.platform_name AS name, COUNT(DISTINCT p.game_id) AS count FROM game_platforms p
        JOIN games g ON g.id = p.game_id WHERE g.hidden = 0 GROUP BY p.platform_slug ORDER BY count DESC, name`),
      genres: rows('SELECT j.value AS name, COUNT(*) AS count FROM games g, json_each(g.genres) j WHERE g.hidden = 0 GROUP BY j.value ORDER BY count DESC, name LIMIT 60'),
      years: rows("SELECT substr(release_date, 1, 4) AS name, COUNT(*) AS count FROM games WHERE hidden = 0 AND release_date IS NOT NULL GROUP BY name ORDER BY name DESC"),
      aspects: ASPECTS,
    };
  }

  function gameCard(slug) {
    const g = row('SELECT * FROM games WHERE slug = ? AND hidden = 0', slug);
    if (!g) return null;
    const platforms = rows('SELECT platform_slug AS slug, platform_name AS name, is_lead, release_date, critic_score, critic_count, user_score, user_count FROM game_platforms WHERE game_id = ? ORDER BY is_lead DESC, platform_name', g.id);
    const history = {};
    for (const h of rows('SELECT platform_slug, critic_score, user_score, captured_at FROM score_history WHERE game_id = ? ORDER BY captured_at, id', g.id)) {
      (history[h.platform_slug] ??= []).push({ at: h.captured_at, critic: h.critic_score, user: h.user_score });
    }
    const summaries = {};
    for (const s of rows('SELECT * FROM summaries WHERE game_id = ?', g.id)) {
      summaries[s.kind] = { status: s.status, likes: parse(s.likes, []), dislikes: parse(s.dislikes, []), aspects: parse(s.aspects, {}), provider: s.provider, model: s.model,
        reviews_used: s.reviews_used, reviews_total: s.reviews_total, dropped_points: s.dropped_points, created_at: s.created_at };
    }
    const lp = row('SELECT * FROM letsplay WHERE game_id = ?', g.id);
    const best = (k) => platforms.reduce((m, p) => (p[k] != null && (m == null || p[k] > m) ? p[k] : m), null);
    const critic = best('critic_score');
    const user = best('user_score');
    return {
      slug: g.slug, title: g.title, description: g.description, cover_url: g.cover_url, developer: g.developer, publishers: parse(g.publishers, []),
      genres: parse(g.genres, []), esrb: g.esrb, release_date: g.release_date, video: g.video_url ? { url: g.video_url, title: g.video_title } : null,
      metacritic_url: `https://www.metacritic.com/game/${g.slug}/`,
      platforms, history, summaries,
      gap: critic != null && user != null ? Math.round(Math.abs(critic / 10 - user) * 10) / 10 : null,
      letsplay: lp ? { status: lp.status, video_url: lp.video_url, video_title: lp.video_title, channel: lp.channel, views: lp.views, duration_s: lp.duration_s,
        transcript_source: lp.transcript_source, transcript: lp.transcript ? lp.transcript.slice(0, 6000) : null, conclusion: parse(lp.conclusion, null), updated_at: lp.updated_at } : null,
      similar: similar.similarTo(g.slug, 6),
      freshness: { last_fetched_at: g.last_fetched_at, first_seen_at: g.first_seen_at, processed_day: g.processed_day },
    };
  }

  // ---------------- monitor / runs / ai ----------------
  const aiStats = () => ({
    by_model: rows(`SELECT provider, model, COUNT(*) AS calls, SUM(ok) AS ok, ROUND(AVG(latency_ms)) AS avg_ms, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out
      FROM ai_calls WHERE purpose = 'summary' GROUP BY provider, model ORDER BY calls DESC`),
    last_24h: row("SELECT COUNT(*) AS calls, COALESCE(SUM(ok), 0) AS ok, COALESCE(SUM(dropped_points), 0) AS dropped FROM ai_calls WHERE purpose = 'summary' AND at >= ?", new Date(Date.now() - 86_400_000).toISOString()),
    summaries: row("SELECT COUNT(*) AS ok, COALESCE(SUM(dropped_points), 0) AS dropped, COALESCE(SUM(json_array_length(likes) + json_array_length(dislikes)), 0) AS kept FROM summaries WHERE status = 'ok'"),
    recent: rows(`SELECT c.at, c.purpose, c.provider, c.model, c.ok, c.error, c.latency_ms, c.tokens_in, c.tokens_out, c.dropped_points, g.slug
      FROM ai_calls c LEFT JOIN games g ON g.id = c.game_id ORDER BY c.id DESC LIMIT 50`),
    providers: chain.status(),
  });

  function mapRun(r) {
    const status = r.ok ? 202 : (RUN_STATUS[r.reason] ?? 400);
    return { status, json: { ok: r.ok, runId: r.runId ?? null, reason: r.reason ?? null, retry_in_s: r.retry_in_s ?? null, detail: r.detail ?? null } };
  }

  function updateProvider(id, patch) {
    const list = settings().ai_providers.map((p) => ({ ...p }));
    const p = list.find((x) => x.id === id);
    if (!p) return { status: 404, json: { error: 'нет такого провайдера' } };
    for (const k of ['enabled', 'daily_cap', 'model']) if (patch[k] !== undefined) p[k] = patch[k];
    return { updated: list };
  }

  const J = (json, status = 200) => ({ status, json });
  const guard = (fn) => (ctx) => { try { return fn(ctx); } catch (e) { return bad(e.message); } };

  const routes = [
    // public
    { method: 'GET', path: '/api/health', role: 'public', handler: () => J({ ok: true, uptime_s: Math.round(process.uptime()), version: app.version }) },
    { method: 'POST', path: '/api/v1/auth/login', role: 'public', handler: ({ body, ip, secure }) => {
      if (!auth.enabled()) return J({ error: 'вход не настроен' }, 503);
      const r = auth.login(String(body.username ?? ''), String(body.password ?? ''), ip);
      if (!r.ok) {
        events.warn('auth', 'Неудачная попытка входа', { reason: r.reason, ip });
        return { status: r.reason === 'rate_limited' ? 429 : 401, json: { error: r.reason === 'rate_limited' ? `Слишком много попыток, подождите ${r.retryAfterS} с` : 'Неверный логин или пароль', retry_in_s: r.retryAfterS ?? null } };
      }
      events.info('auth', `Вход: ${r.role}`, { ip });
      return { status: 200, json: { ok: true, role: r.role }, headers: { 'set-cookie': auth.cookie(auth.issue(r.role, r.user), { secure }) } };
    } },
    // viewer
    { method: 'POST', path: '/api/v1/auth/logout', role: 'viewer', handler: ({ secure }) => ({ status: 200, json: { ok: true }, headers: { 'set-cookie': auth.clearCookie({ secure }) } }) },
    { method: 'GET', path: '/api/v1/me', role: 'viewer', handler: ({ session }) => J({ role: session.role, mock: cfg.mock, test_banner: true }) },
    { method: 'GET', path: '/api/v1/games', role: 'viewer', handler: ({ query }) => { const r = listGames(query); return r ? J({ ...r, facets: facets() }) : bad('неверный фильтр aspect'); } },
    { method: 'GET', path: '/api/v1/games/:slug', role: 'viewer', handler: ({ params }) => { const c = gameCard(params.slug); return c ? J(c) : J({ error: 'игра не найдена' }, 404); } },
    { method: 'GET', path: '/api/v1/monitor', role: 'viewer', handler: () => J(app.snapshot()) },
    { method: 'GET', path: '/api/v1/ai/stats', role: 'viewer', handler: () => J(aiStats()) },
    { method: 'GET', path: '/api/v1/runs', role: 'viewer', handler: ({ query }) => J({ runs: rows('SELECT id, trigger, day, status, started_at, finished_at, picked, ok, failed, note FROM runs ORDER BY id DESC LIMIT ?', clamp(int(query.limit, 20), 1, 100)) }) },
    { method: 'GET', path: '/api/v1/runs/:id', role: 'viewer', handler: ({ params }) => {
      const r = row('SELECT * FROM runs WHERE id = ?', int(params.id, 0));
      return r ? J({ ...r, params: parse(r.params, {}), items: rows('SELECT slug, source, status, attempts, error, duration_ms FROM run_items WHERE run_id = ? ORDER BY id', r.id) }) : J({ error: 'нет такого прогона' }, 404);
    } },
    { method: 'POST', path: '/api/v1/runs', role: 'viewer', handler: ({ body, session }) => mapRun(scheduler.runNow({ role: session.role === 'admin' ? 'admin' : 'viewer', params: session.role === 'admin' ? body : {} })) },
    // admin: control
    { method: 'POST', path: '/api/v1/scheduler/pause', role: 'admin', handler: ({ session }) => { scheduler.pause(session.user); return J({ ok: true }); } },
    { method: 'POST', path: '/api/v1/scheduler/resume', role: 'admin', handler: ({ session }) => { scheduler.resume(session.user); return J({ ok: true }); } },
    { method: 'POST', path: '/api/v1/runs/current/cancel', role: 'admin', handler: ({ session }) => J({ ok: scheduler.cancel(session.user) }) },
    { method: 'POST', path: '/api/v1/cursor/reset', role: 'admin', handler: ({ body }) => { const r = manage.resetCursor({ source: ['all', 'new_releases', 'finder'].includes(body.source) ? body.source : 'all', offset: body.offset ?? null }); return r.ok ? J(r) : bad(r.detail ?? r.reason); } },
    { method: 'POST', path: '/api/v1/source/check', role: 'admin', handler: async () => J(await manage.checkSource()) },
    // admin: settings
    { method: 'GET', path: '/api/v1/settings', role: 'admin', handler: () => J({ registry: REGISTRY, values: settings() }) },
    { method: 'PUT', path: '/api/v1/settings', role: 'admin', handler: guard(({ body, session, ip }) => J({ values: setSettings(db, body, { actor: session.user, ip }) })) },
    { method: 'GET', path: '/api/v1/settings/export', role: 'admin', noObserver: true, handler: () => ({ status: 200, json: { exported_at: new Date().toISOString(), values: settings() }, headers: { 'content-disposition': 'attachment; filename="settings.json"' } }) },
    { method: 'POST', path: '/api/v1/settings/import', role: 'admin', handler: guard(({ body, session, ip }) => J({ values: setSettings(db, body.values ?? {}, { actor: session.user, ip }) })) },
    { method: 'POST', path: '/api/v1/settings/reset', role: 'admin', handler: ({ session, ip }) => { const d = defaults(); const keep = {}; for (const k of Object.keys(d)) keep[k] = d[k]; return J({ values: setSettings(db, keep, { actor: session.user, ip }) }); } },
    // admin: providers
    { method: 'GET', path: '/api/v1/providers', role: 'admin', handler: () => J({ providers: chain.status() }) },
    { method: 'PATCH', path: '/api/v1/providers/:id', role: 'admin', handler: guard(({ params, body, session, ip }) => {
      const r = updateProvider(params.id, body);
      return r.updated ? J({ values: setSettings(db, { ai_providers: r.updated }, { actor: session.user, ip }).ai_providers }) : r;
    }) },
    { method: 'POST', path: '/api/v1/providers/:id/probe', role: 'admin', handler: async ({ params }) => J(await chain.probe(params.id)) },
    { method: 'POST', path: '/api/v1/providers/reset', role: 'admin', handler: () => { chain.resetBreakers(); return J({ ok: true }); } },
    // admin: queue
    { method: 'GET', path: '/api/v1/jobs', role: 'admin', handler: ({ query }) => J({ stats: jobs.stats(db), jobs: jobs.list(db, { status: query.status || null, limit: clamp(int(query.limit, 100), 1, 500) }) }) },
    { method: 'POST', path: '/api/v1/jobs/retry-failed', role: 'admin', handler: () => J({ retried: jobs.retryFailed(db) }) },
    { method: 'POST', path: '/api/v1/jobs/:id/retry', role: 'admin', handler: ({ params }) => J({ ok: jobs.retry(db, int(params.id, 0)) > 0 }) },
    { method: 'POST', path: '/api/v1/jobs/:id/skip', role: 'admin', handler: ({ params }) => J({ ok: jobs.skip(db, int(params.id, 0)) > 0 }) },
    // admin: games
    { method: 'GET', path: '/api/v1/admin/games', role: 'admin', handler: ({ query }) => {
      const like = `%${escLike((query.q ?? '').slice(0, 100))}%`;
      return J({ games: rows("SELECT slug, title, hidden, pinned, blacklisted, processed_day, last_fetched_at FROM games WHERE title LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\' ORDER BY last_fetched_at DESC LIMIT 100", like, like) });
    } },
    { method: 'POST', path: '/api/v1/games', role: 'admin', handler: ({ body, session }) => { const r = manage.addGame(body.slug ?? body.url, session.user); return r.ok ? J(r, 202) : { status: r.reason === 'busy' ? 409 : 400, json: r }; } },
    { method: 'POST', path: '/api/v1/games/:slug/reprocess', role: 'admin', handler: ({ params, body, session }) => {
      const stages = Array.isArray(body.stages) ? body.stages.filter((s) => ['data', 'summary', 'letsplay'].includes(s)) : undefined;
      const r = manage.reprocess(params.slug, stages, session.user);
      return r.ok ? J(r, 202) : { status: r.reason === 'not_found' ? 404 : 409, json: r };
    } },
    { method: 'PATCH', path: '/api/v1/games/:slug', role: 'admin', handler: ({ params, body }) => { const r = manage.setFlags(params.slug, body); return r.ok ? J(r) : { status: r.reason === 'not_found' ? 404 : 400, json: r }; } },
    { method: 'DELETE', path: '/api/v1/games/:slug', role: 'admin', handler: ({ params }) => { const r = manage.deleteGame(params.slug); return r.ok ? J(r) : J(r, 404); } },
    { method: 'POST', path: '/api/v1/summaries/recompute', role: 'admin', handler: ({ session }) => J(manage.recomputeSummaries(session.user)) },
    // admin: diagnostics
    { method: 'GET', path: '/api/v1/audit', role: 'admin', handler: ({ query, session }) => {
      const audit = rows('SELECT at, actor, ip, action, detail FROM audit_log ORDER BY id DESC LIMIT ?', clamp(int(query.limit, 100), 1, 500));
      return J({ audit: session.role === 'observer' ? audit.map(({ ip, ...rest }) => rest) : audit }); // the read-only observer never sees addresses
    } },
    { method: 'GET', path: '/api/v1/events', role: 'admin', handler: ({ query }) => {
      const level = ['info', 'warn', 'error'].includes(query.level) ? query.level : null;
      return J({ events: rows(`SELECT id, at, level, scope, message FROM events ${level ? 'WHERE level = ?' : ''} ORDER BY id DESC LIMIT ?`, ...(level ? [level] : []), clamp(int(query.limit, 200), 1, 1000)) });
    } },
    { method: 'GET', path: '/api/v1/export/games.json', role: 'admin', noObserver: true, handler: () => ({ status: 200, json: manage.exportRows(), headers: { 'content-disposition': 'attachment; filename="games.json"' } }) },
    { method: 'GET', path: '/api/v1/export/games.csv', role: 'admin', noObserver: true, handler: () => ({ status: 200, csv: manage.exportCsv(), headers: { 'content-disposition': 'attachment; filename="games.csv"' } }) },
    { method: 'GET', path: '/api/v1/backup', role: 'admin', noObserver: true, handler: () => ({ status: 200, backup: true }) },
  ];

  return { routes, listGames, gameCard };
}
