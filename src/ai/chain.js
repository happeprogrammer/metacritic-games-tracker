// Routes an AI request through the configured providers: budgets, cooldowns, retries, fallbacks, call journal.
import { AiError, AiUnavailable, AiValidationError } from './errors.js';
import { dayOf } from '../selection.js';
import { getState, setState } from '../state.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DENIED_MS = 24 * 3600 * 1000;
const SERVER_COOLDOWN_MS = 60_000;

export function createChain({ db, settings, adapters, now = () => new Date(), sleep = defaultSleep, random = Math.random, events = null }) {
  const nowMs = () => now().getTime();
  const iso = (ms) => new Date(ms).toISOString();
  const breaker = () => getState(db, 'ai_breaker', {});          // { "provider|model": untilISO, "provider": deniedUntilISO }
  const lastErrors = () => getState(db, 'ai_last_error', {});    // { provider: message }

  // OpenRouter counts its daily quota by UTC day; the rest follow the configured time zone.
  const dayKey = (provider) => (provider === 'openrouter' ? now().toISOString().slice(0, 10) : dayOf(now(), settings().tz));
  const counterKey = (provider) => `ai_calls:${provider}:${dayKey(provider)}`;
  const callsToday = (provider) => getState(db, counterKey(provider), 0);
  const bump = (provider) => setState(db, counterKey(provider), callsToday(provider) + 1);

  const untilMs = (key) => { const v = breaker()[key]; return v ? new Date(v).getTime() : 0; };
  const hold = (key, ms) => { const b = breaker(); b[key] = iso(nowMs() + ms); setState(db, 'ai_breaker', b); };
  const noteError = (provider, message) => { const e = lastErrors(); e[provider] = message.slice(0, 200); setState(db, 'ai_last_error', e); };

  const logCall = (row) => db.prepare(`INSERT INTO ai_calls(at, game_id, run_id, purpose, provider, model, prompt_version, ok, error, latency_ms, tokens_in, tokens_out, dropped_points)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(iso(nowMs()), row.gameId ?? null, row.runId ?? null, row.purpose, row.provider, row.model, row.promptVersion ?? null,
    row.ok ? 1 : 0, row.error ?? null, row.latency ?? null, row.usage?.in ?? null, row.usage?.out ?? null, row.dropped ?? null);

  /** Ordered (provider, model) candidates that are enabled, have a key, are not denied, within budget and not cooling down. */
  function candidates() {
    const out = [];
    for (const p of settings().ai_providers) {
      if (!p.enabled || !adapters[p.id] || untilMs(p.id) > nowMs() || callsToday(p.id) >= p.daily_cap) continue;
      for (const model of p.model.split(',')) {
        if (untilMs(`${p.id}|${model}`) <= nowMs()) out.push({ provider: p.id, model, cap: p.daily_cap });
      }
    }
    return out;
  }

  function soonestRetryMs() {
    const future = Object.values(breaker()).map((v) => new Date(v).getTime() - nowMs()).filter((ms) => ms > 0);
    return future.length ? Math.min(...future) : 5 * 60_000;
  }

  /** Handle an AiError from provider/model; returns 'retry' to try the same candidate again, 'next' otherwise. */
  function onError(c, e, attempt, s) {
    noteError(c.provider, `${e.kind}: ${e.message}`);
    if (e.kind === 'rate_limit') hold(`${c.provider}|${c.model}`, e.retryAfter ? Math.min(e.retryAfter, 3600) * 1000 : s.ai_breaker_cooldown_min * 60_000);
    else if (e.kind === 'denied') { hold(c.provider, DENIED_MS); events?.warn('ai', `Провайдер ${c.provider} отклонил доступ (${e.status ?? ''}), отключён на сутки`, { error: e.message }); }
    else if (e.kind === 'server' || e.kind === 'timeout' || e.kind === 'network') {
      if (attempt === 0) return 'retry';
      hold(`${c.provider}|${c.model}`, SERVER_COOLDOWN_MS);
    } else if (e.kind === 'bad_request') hold(`${c.provider}|${c.model}`, 60 * 60_000); // e.g. the model is no longer free: stop spending calls on it
    else if (e.kind === 'empty') hold(`${c.provider}|${c.model}`, 5 * 60_000);
    return 'next';
  }

  /**
   * validate(text) -> value, or throws (AiValidationError may carry a weaker fallback).
   * Returns { value, provider, model, usage, degraded? }; throws AiUnavailable when nothing worked.
   */
  async function complete({ system, user, purpose = 'summary', gameId = null, runId = null, promptVersion = null, validate = (t) => t, maxTokens }) {
    const s = settings();
    if (!s.ai_enabled) throw new AiUnavailable('ai_disabled', 0);
    const list = candidates();
    if (list.length === 0) throw new AiUnavailable('no_provider', soonestRetryMs());

    let lastErr = null;
    let fallback = null;
    for (const c of list) {
      if (untilMs(c.provider) > nowMs() || callsToday(c.provider) >= c.cap) continue; // changed while we were looping
      let hint = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        const t0 = nowMs();
        bump(c.provider);
        let out;
        try {
          out = await adapters[c.provider].complete({ model: c.model, system, user: user + hint, timeoutMs: s.ai_timeout_ms, maxTokens });
        } catch (e) {
          if (!(e instanceof AiError)) throw e;
          lastErr = e;
          logCall({ gameId, runId, purpose, provider: c.provider, model: c.model, promptVersion, ok: false, error: `${e.kind}: ${e.message}`.slice(0, 300), latency: nowMs() - t0 });
          if (onError(c, e, attempt, s) === 'retry') { await sleep(1000 + random() * 2000); continue; }
          break;
        }
        try {
          const value = validate(out.text);
          logCall({ gameId, runId, purpose, provider: c.provider, model: c.model, promptVersion, ok: true, latency: nowMs() - t0, usage: out.usage, dropped: value?.dropped });
          return { value, provider: c.provider, model: c.model, usage: out.usage };
        } catch (ve) {
          lastErr = ve;
          logCall({ gameId, runId, purpose, provider: c.provider, model: c.model, promptVersion, ok: false, error: `invalid: ${ve.message}`.slice(0, 300), latency: nowMs() - t0, usage: out.usage });
          if (ve instanceof AiValidationError && ve.fallback && (!fallback || ve.score > fallback.score)) {
            fallback = { value: ve.fallback, provider: c.provider, model: c.model, usage: out.usage, score: ve.score };
          }
          hint = `\n\nYour previous answer was rejected (${ve.message}). Return ONLY valid JSON of the required shape; every "evidence" must be copied verbatim from a review line.`;
        }
      }
    }
    if (fallback) return { ...fallback, degraded: true };
    throw new AiUnavailable('all_failed', soonestRetryMs(), lastErr);
  }

  /** One tiny real request to check a provider's key and model. */
  async function probe(providerId) {
    const s = settings();
    const p = s.ai_providers.find((x) => x.id === providerId);
    if (!p) return { ok: false, error: 'неизвестный провайдер' };
    if (!adapters[providerId]) return { ok: false, error: 'нет ключа в окружении' };
    const model = p.model.split(',')[0];
    const t0 = nowMs();
    bump(providerId);
    try {
      const out = await adapters[providerId].complete({ model, system: 'Reply with JSON only.', user: 'Return {"ok": true}', timeoutMs: s.ai_timeout_ms, maxTokens: 60 });
      logCall({ purpose: 'probe', provider: providerId, model, ok: true, latency: nowMs() - t0, usage: out.usage });
      return { ok: true, model, ms: nowMs() - t0, text: out.text.slice(0, 60) };
    } catch (e) {
      if (!(e instanceof AiError)) throw e;
      logCall({ purpose: 'probe', provider: providerId, model, ok: false, error: `${e.kind}: ${e.message}`.slice(0, 300), latency: nowMs() - t0 });
      onError({ provider: providerId, model }, e, 1, s);
      return { ok: false, model, kind: e.kind, error: e.message };
    }
  }

  /** Per-provider state for the monitor and the admin page. */
  function status() {
    return settings().ai_providers.map((p) => {
      const denied = untilMs(p.id) > nowMs();
      const models = p.model.split(',');
      const cooling = models.filter((m) => untilMs(`${p.id}|${m}`) > nowMs());
      const calls = callsToday(p.id);
      let state = 'ok';
      if (!p.enabled) state = 'off';
      else if (!adapters[p.id]) state = 'no_key';
      else if (denied) state = 'denied';
      else if (calls >= p.daily_cap) state = 'budget';
      else if (cooling.length === models.length) state = 'cooldown';
      const until = denied ? untilMs(p.id) : cooling.length ? Math.min(...cooling.map((m) => untilMs(`${p.id}|${m}`))) : 0;
      return { id: p.id, enabled: p.enabled, state, calls_today: calls, cap: p.daily_cap, models, breaker_until: until ? iso(until) : null, last_error: lastErrors()[p.id] ?? null };
    });
  }

  /** Share of today's calls still unspent across the usable providers (1 = untouched, 0 = all spent). */
  function headroom() {
    let cap = 0;
    let left = 0;
    for (const p of settings().ai_providers) {
      if (!p.enabled || !adapters[p.id] || untilMs(p.id) > nowMs()) continue;
      cap += p.daily_cap;
      left += Math.max(0, p.daily_cap - callsToday(p.id));
    }
    return cap ? left / cap : 0;
  }

  /** Forget cooldowns (admin action). */
  const resetBreakers = () => setState(db, 'ai_breaker', {});

  return { complete, probe, status, resetBreakers, candidates, headroom };
}
