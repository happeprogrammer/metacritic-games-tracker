// Review summaries: when one is needed, what goes in, how the answer is checked, how it is saved.
import { createHash } from 'node:crypto';
import { unpackJson, tx } from '../db.js';
import { enqueue } from '../jobs.js';
import { AiValidationError } from './errors.js';
import { extractJson } from './json.js';
import { ASPECTS, ASPECT_VALUES, PROMPT_VERSION, buildSummaryPrompt } from './prompts.js';

/** Comparable form of a text: lower case, letters and digits only, single spaces. Used to check quotes. */
export const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function loadSamples(db, gameId) {
  const out = {};
  for (const r of db.prepare('SELECT kind, items, total FROM review_samples WHERE game_id = ?').all(gameId)) {
    out[r.kind] = { items: unpackJson(r.items), total: r.total };
  }
  return { critics: out.critics ?? { items: [], total: 0 }, users: out.users ?? { items: [], total: 0 } };
}

/** Groups with enough reviews to be worth an AI call. */
export const enabledGroups = (samples, min) =>
  ['critics', 'users'].filter((k) => samples[k].total >= min && samples[k].items.length >= min);

export function inputHash(samples, groups) {
  const key = groups.map((k) => [k, samples[k].items.map((r) => r.id ?? norm(r.quote)).sort()]);
  return createHash('sha1').update(JSON.stringify(key)).update(PROMPT_VERSION).digest('hex');
}

/**
 * After a game is saved: record "not enough reviews" where that is the case and queue a summary job when one is due.
 * Returns 'none' | 'queued' | 'fresh'.
 */
export function planSummary(db, gameId, s, now = () => new Date(), { force = false } = {}) {
  const samples = loadSamples(db, gameId);
  const groups = enabledGroups(samples, s.min_reviews_for_summary);
  const rows = Object.fromEntries(db.prepare('SELECT kind, status, input_hash, reviews_total, created_at FROM summaries WHERE game_id = ?').all(gameId).map((r) => [r.kind, { ...r }]));
  const ts = now().toISOString();

  for (const kind of ['critics', 'users']) {
    if (groups.includes(kind)) continue;
    if (rows[kind]?.status !== 'ok') {
      db.prepare(`INSERT INTO summaries(game_id, kind, status, reviews_total, created_at) VALUES (?, ?, 'insufficient', ?, ?)
        ON CONFLICT(game_id, kind) DO UPDATE SET status = 'insufficient', reviews_total = excluded.reviews_total, created_at = excluded.created_at`)
        .run(gameId, kind, samples[kind].total, ts);
    }
  }
  if (groups.length === 0) return 'none';

  let due = force || groups.some((k) => rows[k]?.status !== 'ok');
  if (!due) {
    const ageMs = now().getTime() - new Date(rows[groups[0]].created_at).getTime();
    const changed = rows[groups[0]].input_hash !== inputHash(samples, groups);
    const delta = Math.max(...groups.map((k) => (Math.abs(samples[k].total - (rows[k].reviews_total ?? 0)) / Math.max(rows[k].reviews_total ?? 0, 1)) * 100));
    due = changed && ageMs >= s.resummarize_min_hours * 3600_000 && (delta >= s.resummarize_delta_pct || ageMs >= s.resummarize_max_age_days * 86_400_000);
  }
  if (!due) return 'fresh';
  for (const k of groups) {
    db.prepare("INSERT OR IGNORE INTO summaries(game_id, kind, status, reviews_total, created_at) VALUES (?, ?, 'pending', ?, ?)").run(gameId, k, samples[k].total, ts);
  }
  enqueue(db, { type: 'summarize', gameId, force, now });
  return 'queued';
}

/**
 * Check the model's answer: shape, then grounding (every "evidence" must literally occur in a review of the same group).
 * Throws AiValidationError (with the cleaned partial result as fallback) when the answer is too weak.
 */
export function validateSummary(text, groups, samples) {
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== 'object') throw new AiValidationError('в ответе нет JSON');
  let kept = 0;
  let dropped = 0;
  const out = {};
  for (const kind of groups) {
    const g = parsed[kind];
    if (!g || typeof g !== 'object') throw new AiValidationError(`нет блока ${kind}`);
    const quotes = samples[kind].items.map((r) => norm(r.quote));
    const clean = (list) => (Array.isArray(list) ? list : []).slice(0, 5).flatMap((p) => {
      const point = String(p?.text ?? '').trim().slice(0, 140);
      const evidence = String(p?.evidence ?? '').trim().slice(0, 200);
      const n = norm(evidence);
      if (!point || n.length < 20 || !quotes.some((q) => q.includes(n))) { dropped++; return []; }
      kept++;
      return [{ text: point, evidence }];
    });
    const aspects = Object.fromEntries(ASPECTS.map((a) => [a, ASPECT_VALUES.includes(g.aspects?.[a]) ? g.aspects[a] : 'none']));
    out[kind] = { likes: clean(g.likes), dislikes: clean(g.dislikes), aspects };
  }
  out.dropped = dropped;
  if (kept === 0 || dropped > (kept + dropped) / 2) {
    throw new AiValidationError(`слабый ответ: принято ${kept}, отброшено ${dropped}`, kept > 0 ? out : null, kept);
  }
  return out;
}

/** Summarise one game with the AI chain and save the result. Throws AiUnavailable when no provider could help. */
export async function summarizeGame({ db, chain, game, settings: s, now = () => new Date(), runId = null }) {
  const samples = loadSamples(db, game.id);
  const groups = enabledGroups(samples, s.min_reviews_for_summary);
  if (groups.length === 0) return { provider: null, model: null, dropped: 0, groups: [] };

  const prompt = buildSummaryPrompt(game.title, Object.fromEntries(groups.map((k) => [k, samples[k]])));
  const res = await chain.complete({
    ...prompt, purpose: 'summary', gameId: game.id, runId, promptVersion: PROMPT_VERSION,
    validate: (text) => validateSummary(text, groups, samples),
  });
  const hash = inputHash(samples, groups);
  const ts = now().toISOString();
  tx(db, () => {
    for (const kind of groups) {
      const r = res.value[kind];
      db.prepare(`INSERT INTO summaries(game_id, kind, status, likes, dislikes, aspects, provider, model, prompt_version, input_hash, reviews_used, reviews_total, dropped_points, created_at)
        VALUES (?, ?, 'ok', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(game_id, kind) DO UPDATE SET status = 'ok', likes = excluded.likes, dislikes = excluded.dislikes, aspects = excluded.aspects,
          provider = excluded.provider, model = excluded.model, prompt_version = excluded.prompt_version, input_hash = excluded.input_hash,
          reviews_used = excluded.reviews_used, reviews_total = excluded.reviews_total, dropped_points = excluded.dropped_points, created_at = excluded.created_at`)
        .run(game.id, kind, JSON.stringify(r.likes), JSON.stringify(r.dislikes), JSON.stringify(r.aspects), res.provider, res.model, PROMPT_VERSION, hash,
          samples[kind].items.length, samples[kind].total, res.value.dropped, ts);
    }
  });
  return { provider: res.provider, model: res.model, dropped: res.value.dropped, groups, degraded: Boolean(res.degraded) };
}
