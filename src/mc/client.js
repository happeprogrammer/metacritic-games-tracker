// Polite Metacritic client: global request spacing, timeout, retries with backoff, circuit breaker.
import { McError } from './errors.js';
import { parseNewReleases, parseFinder, parseProduct, parseUserStats, parseReviews } from './parse.js';
import { createMockFetch, loadFixtures } from './mock.js';

const BACKEND = 'https://backend.metacritic.com';
const SITE = 'https://www.metacritic.com';
const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createClient({
  apiKey, settings, fetchImpl = globalThis.fetch, sleep = defaultSleep, now = Date.now, random = Math.random,
  breakerThreshold = 5, breakerCooldownMs = 120_000,
}) {
  let nextAt = 0;
  let failures = 0;
  let openUntil = 0;
  let lastError = null;
  let lastOkAt = null;

  async function throttle() {
    const t = now();
    const wait = Math.max(0, nextAt - t);
    nextAt = Math.max(t, nextAt) + settings().request_delay_ms; // reserve our slot before awaiting: safe under concurrency
    if (wait) await sleep(wait);
  }

  async function request(url, kind) {
    for (let attempt = 0; ; attempt++) {
      if (now() < openUntil) throw new McError('breaker', 'источник временно отключён после серии ошибок');
      await throttle();
      const s = settings();
      let err;
      try {
        const res = await fetchImpl(url, {
          headers: { 'user-agent': s.user_agent, 'accept-language': 'en-US,en;q=0.9', accept: kind === 'json' ? 'application/json' : 'text/html' },
          signal: AbortSignal.timeout(s.request_timeout_ms),
        });
        if (res.ok) {
          const text = await res.text();
          failures = 0;
          lastOkAt = now();
          if (kind === 'text') return text;
          try { return JSON.parse(text); } catch { throw new McError('schema', 'ответ не JSON'); }
        }
        err = new McError('http', `HTTP ${res.status}`, res.status);
        err.retryAfter = Number(res.headers?.get?.('retry-after')) || 0;
      } catch (e) {
        if (e instanceof McError && e.kind === 'schema') throw e;
        err = e instanceof McError ? e : new McError(e?.name === 'TimeoutError' ? 'timeout' : 'network', e?.message ?? String(e));
      }
      const retryable = err.kind === 'network' || err.kind === 'timeout' || err.status === 429 || err.status >= 500;
      if (!retryable) throw err; // 404 and friends mean "no such thing", not "source is sick"
      lastError = err.message;
      if (++failures >= breakerThreshold) { openUntil = now() + breakerCooldownMs; failures = 0; }
      if (attempt >= s.retry_max) throw err;
      await sleep(err.retryAfter ? Math.min(err.retryAfter, 60) * 1000 : s.retry_base_ms * 2 ** attempt * (0.5 + random()));
    }
  }

  const api = (path, query = '') => request(`${BACKEND}${path}?${query ? `${query}&` : ''}apiKey=${apiKey}`, 'json');
  const slug = (value) => { if (!SLUG.test(value)) throw new McError('input', `недопустимый slug: ${value}`); return value; };
  const notFound = (fallback) => (e) => { if (e.kind === 'http' && e.status === 404) return fallback; throw e; };

  return {
    state: () => ({ open: now() < openUntil, openUntil, failures, lastError, lastOkAt }),

    async newReleases() {
      return parseNewReleases(await request(`${SITE}/game/`, 'text'));
    },
    async finderPage(offset, limit = 20) {
      const json = await api('/finder/metacritic/web', `mcoTypeId=13&sortBy=-releaseDate&limit=${limit}&offset=${offset}`).catch(notFound(null));
      return json ? parseFinder(json).items : [];
    },
    async product(s) {
      const json = await api(`/games/metacritic/${slug(s)}/web`, 'componentName=product&componentDisplayName=Product&componentType=Product');
      return parseProduct(json);
    },
    async userStats(s, platform) {
      const json = await api(`/reviews/metacritic/user/games/${slug(s)}/platform/${slug(platform)}/stats/web`).catch(notFound(null));
      return json ? parseUserStats(json) : { score: null, count: 0 };
    },
    async criticReviews(s, offset) {
      const json = await api(`/reviews/metacritic/critic/games/${slug(s)}/web`, `limit=10&offset=${offset}`).catch(notFound(null));
      return json ? parseReviews(json, 'critics') : { total: 0, items: [] };
    },
    async userReviews(s, offset, limit) {
      const json = await api(`/reviews/metacritic/user/games/${slug(s)}/web`, `limit=${limit}&offset=${offset}`).catch(notFound(null));
      return json ? parseReviews(json, 'users') : { total: 0, items: [] };
    },
  };
}

/** Real client, or one backed by recorded fixtures when MOCK=1. */
export function createClientFromConfig(cfg, settings, extra = {}) {
  return createClient({
    apiKey: cfg.mcApiKey,
    settings,
    fetchImpl: cfg.mock ? createMockFetch(loadFixtures()) : globalThis.fetch,
    ...extra,
  });
}
