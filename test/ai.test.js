import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from '../src/ai/json.js';
import { gemini, groq, openrouter, mockAdapter, createAdapters } from '../src/ai/providers.js';
import { createChain } from '../src/ai/chain.js';
import { AiError, AiUnavailable, AiValidationError } from '../src/ai/errors.js';
import { defaults } from '../src/settings.js';
import { getState } from '../src/state.js';
import { freshDb } from './helpers.js';

const res = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const adapter = (id, fn) => ({ id, complete: async (args) => fn(args) });
const ok = (text = '{"ok":true}') => ({ text, usage: { in: 10, out: 5 } });

test('extractJson handles plain JSON, code fences, reasoning before the answer and junk', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":{"b":2}}\n```'), { a: { b: 2 } });
  assert.deepEqual(extractJson('Okay, the user wants {braces} like this. Final: {"critics":{"likes":[]}} done'), { critics: { likes: [] } });
  assert.deepEqual(extractJson('{"text":"a } tricky { string","n":1}'), { text: 'a } tricky { string', n: 1 });
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson(''), null);
});

test('Gemini: key goes in a header, never in the URL; text is read from parts', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, headers: init.headers, body: JSON.parse(init.body) }; return res({ candidates: [{ content: { parts: [{ text: '{"x":' }, { text: '1}' }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } }); };
  const out = await gemini({ key: 'SECRETKEY', fetchImpl }).complete({ model: 'gemini-flash-latest', system: 'sys', user: 'usr', timeoutMs: 5000 });
  assert.equal(out.text, '{"x":1}');
  assert.deepEqual(out.usage, { in: 7, out: 3 });
  assert.ok(!seen.url.includes('SECRETKEY'));
  assert.equal(seen.headers['x-goog-api-key'], 'SECRETKEY');
  assert.equal(seen.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(seen.body.systemInstruction.parts[0].text, 'sys');
});

test('OpenRouter asks for short reasoning and a big answer budget, and retries without JSON mode when a model rejects it', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.response_format) return res({ error: { message: 'Provider does not support response_format' } }, 400);
    return res({ choices: [{ message: { content: '{"a":1}' } }] });
  };
  const out = await openrouter({ key: 'o', fetchImpl }).complete({ model: 'm:free', system: 's', user: 'u', timeoutMs: 5000 });
  assert.equal(out.text, '{"a":1}');
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
  assert.equal(bodies[1].response_format, undefined);
  assert.deepEqual(bodies[0].reasoning, { enabled: false });
  assert.equal(bodies[0].max_tokens, 4000);
});

test('a model that cannot switch thinking off is retried without that switch and with a big budget', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.reasoning) return res({ error: { message: 'Reasoning is mandatory for this endpoint and cannot be disabled' } }, 400);
    return res({ choices: [{ message: { content: '{"a":1}' } }] });
  };
  const out = await openrouter({ key: 'o', fetchImpl }).complete({ model: 'think:free', system: 's', user: 'u', timeoutMs: 5000 });
  assert.equal(out.text, '{"a":1}');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].reasoning, undefined);
  assert.equal(bodies[1].max_tokens, 32000);
});

test('an unrelated bad request is not retried', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return res({ error: { message: 'model not found' } }, 400); };
  await assert.rejects(openrouter({ key: 'o', fetchImpl }).complete({ model: 'x:free', system: 's', user: 'u', timeoutMs: 5000 }), (e) => e.kind === 'bad_request');
  assert.equal(n, 1);
});

test('a model that is gone (bad request) is put on hold so no more calls are wasted on it', async () => {
  let calls = 0;
  const c = chainWith({ openrouter: adapter('openrouter', ({ model }) => { calls++; if (model === 'old:free') throw new AiError('bad_request', 'no longer free'); return ok(); }) },
    { providers: [{ id: 'openrouter', enabled: true, model: 'old:free,new:free', daily_cap: 50 }] });
  await c.chain.complete(req);
  await c.chain.complete(req);
  assert.equal(calls, 3, 'old:free tried once, then skipped');
});

test('OpenAI-compatible providers: Groq asks for JSON mode and a small budget', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return res({ choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }); };
  await groq({ key: 'g', fetchImpl }).complete({ model: 'm1', system: 's', user: 'u', timeoutMs: 5000 });
  await openrouter({ key: 'o', fetchImpl }).complete({ model: 'm2:free', system: 's', user: 'u', timeoutMs: 5000 });
  assert.equal(seen[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.deepEqual(seen[0].body.response_format, { type: 'json_object' });
  assert.equal(seen[0].headers.authorization, 'Bearer g');
  assert.equal(seen[1].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(seen[0].body.max_tokens, 2048);
  assert.deepEqual(seen[1].body.messages.map((m) => m.role), ['system', 'user']);
});

test('provider errors are classified', async () => {
  const run = (response) => groq({ key: 'k', fetchImpl: async () => response }).complete({ model: 'm', system: 's', user: 'u', timeoutMs: 5000 });
  await assert.rejects(run(res({ error: { message: 'slow down' } }, 429, { 'retry-after': '7' })), (e) => e.kind === 'rate_limit' && e.retryAfter === 7);
  await assert.rejects(run(res('nope', 401)), (e) => e.kind === 'denied');
  await assert.rejects(run(res('nope', 403)), (e) => e.kind === 'denied');
  await assert.rejects(run(res('boom', 503)), (e) => e.kind === 'server');
  await assert.rejects(run(res('bad', 400)), (e) => e.kind === 'bad_request');
  await assert.rejects(run(res({ error: { code: 429, message: 'upstream busy' } }, 200)), (e) => e.kind === 'rate_limit', 'a 200 with an error body is still an error');
  await assert.rejects(run(res({ choices: [{ message: { content: '  ' } }] })), (e) => e.kind === 'empty');
  const net = groq({ key: 'k', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(net.complete({ model: 'm', system: 's', user: 'u', timeoutMs: 5000 }), (e) => e.kind === 'network');
});

test('createAdapters builds only providers with a key; mock mode gives all four', () => {
  assert.deepEqual(Object.keys(createAdapters({ openrouter: 'x', groq: '', gemini: '', github: '' })), ['openrouter']);
  assert.deepEqual(Object.keys(createAdapters({}, { mock: true })).sort(), ['gemini', 'github', 'groq', 'openrouter']);
});

test('the mock adapter answers with evidence quoted from the prompt', async () => {
  const user = 'Game: X\n\n<critics total="9">\n[1|90|2026-01-01] A truly wonderful game with a great story and music\n[2|20|2026-01-02] Boring combat and constant stutters on every platform\n</critics>';
  const out = JSON.parse((await mockAdapter('m').complete({ user })).text);
  assert.equal(out.critics.likes[0].evidence, 'A truly wonderful game with a great story and music');
  assert.equal(out.critics.dislikes.length, 1);
  assert.equal(out.users, undefined);
});

// ---------- chain ----------
function chainWith(adapters, { providers, overrides = {}, start = '2026-10-15T10:00:00Z' } = {}) {
  const db = freshDb();
  let t = new Date(start);
  const sleeps = [];
  const base = defaults();
  const list = providers ?? [{ id: 'groq', enabled: true, model: 'g1', daily_cap: 100 }, { id: 'openrouter', enabled: true, model: 'a:free,b:free', daily_cap: 100 }, { id: 'gemini', enabled: true, model: 'gm', daily_cap: 100 }];
  const chain = createChain({ db, settings: () => ({ ...base, ai_providers: list, ...overrides }), adapters, now: () => new Date(t), sleep: async (ms) => { sleeps.push(ms); }, random: () => 0 });
  return { db, chain, sleeps, advance: (ms) => { t = new Date(t.getTime() + ms); }, calls: () => db.prepare('SELECT provider, model, ok, error FROM ai_calls ORDER BY id').all().map((r) => ({ ...r })) };
}
const req = { system: 's', user: 'u' };

test('a 429 moves on to the next provider and the cooldown is remembered', async () => {
  let groqCalls = 0;
  const c = chainWith({ groq: adapter('groq', () => { groqCalls++; throw new AiError('rate_limit', 'slow', { retryAfter: 120 }); }), openrouter: adapter('openrouter', () => ok('{"v":1}')) });
  const r1 = await c.chain.complete(req);
  assert.equal(r1.provider, 'openrouter');
  assert.equal(groqCalls, 1);
  await c.chain.complete(req);
  assert.equal(groqCalls, 1, 'groq is not called again while cooling down');
  c.advance(121_000);
  await c.chain.complete(req);
  assert.equal(groqCalls, 2, 'after Retry-After it is tried again');
  assert.ok(getState(c.db, 'ai_breaker')['groq|g1']);
});

test('free OpenRouter models are tried one by one; each cools down separately', async () => {
  const seen = [];
  const c = chainWith({ openrouter: adapter('openrouter', ({ model }) => { seen.push(model); if (model === 'a:free') throw new AiError('rate_limit', 'busy'); return ok(); }) },
    { providers: [{ id: 'openrouter', enabled: true, model: 'a:free,b:free', daily_cap: 100 }] });
  const r = await c.chain.complete(req);
  assert.equal(r.model, 'b:free');
  assert.deepEqual(seen, ['a:free', 'b:free']);
  seen.length = 0;
  await c.chain.complete(req);
  assert.deepEqual(seen, ['b:free'], 'a:free is skipped while cooling');
});

test('a denied provider is switched off for a day, others keep working', async () => {
  let n = 0;
  const c = chainWith({ gemini: adapter('gemini', () => { n++; throw new AiError('denied', 'project denied access', { status: 403 }); }), groq: adapter('groq', () => ok()) },
    { providers: [{ id: 'gemini', enabled: true, model: 'gm', daily_cap: 10 }, { id: 'groq', enabled: true, model: 'g1', daily_cap: 10 }] });
  assert.equal((await c.chain.complete(req)).provider, 'groq');
  await c.chain.complete(req);
  assert.equal(n, 1);
  assert.equal(c.chain.status().find((p) => p.id === 'gemini').state, 'denied');
  c.advance(25 * 3600_000);
  await c.chain.complete(req);
  assert.equal(n, 2, 'tried again after a day');
});

test('daily caps stop a provider; counters reset on a new day', async () => {
  const c = chainWith({ groq: adapter('groq', () => ok()), openrouter: adapter('openrouter', () => ok()) },
    { providers: [{ id: 'groq', enabled: true, model: 'g1', daily_cap: 2 }, { id: 'openrouter', enabled: true, model: 'a:free', daily_cap: 5 }] });
  const used = [];
  for (let i = 0; i < 3; i++) used.push((await c.chain.complete(req)).provider);
  assert.deepEqual(used, ['groq', 'groq', 'openrouter']);
  assert.equal(c.chain.status().find((p) => p.id === 'groq').state, 'budget');
  c.advance(24 * 3600_000);
  assert.equal((await c.chain.complete(req)).provider, 'groq');
});

test('the OpenRouter quota is counted by UTC day, others by the configured zone', async () => {
  const c = chainWith({ groq: adapter('groq', () => ok()), openrouter: adapter('openrouter', () => ok()) }, { start: '2026-10-15T22:00:00Z' }); // already Oct 16 in Moscow
  await c.chain.complete(req);
  await c.chain.probe('openrouter');
  assert.equal(getState(c.db, 'ai_calls:groq:2026-10-16'), 1);
  assert.equal(getState(c.db, 'ai_calls:openrouter:2026-10-15'), 1);
});

test('nothing available gives AiUnavailable with a retry hint; ai_enabled=false is reported as such', async () => {
  const noKeys = chainWith({});
  await assert.rejects(noKeys.chain.complete(req), (e) => e instanceof AiUnavailable && e.reason === 'no_provider');
  const off = chainWith({ groq: adapter('groq', () => ok()) }, { overrides: { ai_enabled: false } });
  await assert.rejects(off.chain.complete(req), (e) => e.reason === 'ai_disabled');
  const failing = chainWith({ groq: adapter('groq', () => { throw new AiError('rate_limit', 'x', { retryAfter: 90 }); }) }, { providers: [{ id: 'groq', enabled: true, model: 'g1', daily_cap: 9 }] });
  await assert.rejects(failing.chain.complete(req), (e) => e.reason === 'all_failed' && e.retryAfterMs > 80_000 && e.retryAfterMs <= 90_000);
});

test('server errors are retried once on the same model, then the next provider is used', async () => {
  let groqCalls = 0;
  const c = chainWith({ groq: adapter('groq', () => { groqCalls++; throw new AiError('server', 'oops'); }), openrouter: adapter('openrouter', () => ok()) });
  const r = await c.chain.complete(req);
  assert.equal(groqCalls, 2);
  assert.equal(r.provider, 'openrouter');
  assert.equal(c.sleeps.length, 1);
});

test('invalid answers get one repair attempt with a hint, then the next provider', async () => {
  const prompts = [];
  const c = chainWith({ groq: adapter('groq', ({ user }) => { prompts.push(user); return ok('not json'); }), openrouter: adapter('openrouter', () => ok('{"good":true}')) });
  const validate = (t) => { const v = JSON.parse(t); return v; };
  const r = await c.chain.complete({ ...req, validate });
  assert.equal(r.provider, 'openrouter');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /previous answer was rejected/);
  assert.deepEqual(c.calls().map((x) => x.ok), [0, 0, 1]);
});

test('when every provider gives a weak answer the best weak one is used, marked degraded', async () => {
  const mk = (score) => () => ok(`{"score":${score}}`);
  const c = chainWith({ groq: adapter('groq', mk(1)), openrouter: adapter('openrouter', mk(3)) }, { providers: [{ id: 'groq', enabled: true, model: 'g1', daily_cap: 9 }, { id: 'openrouter', enabled: true, model: 'a:free', daily_cap: 9 }] });
  const validate = (t) => { const { score } = JSON.parse(t); throw new AiValidationError('weak', { score }, score); };
  const r = await c.chain.complete({ ...req, validate });
  assert.equal(r.degraded, true);
  assert.deepEqual(r.value, { score: 3 });
  assert.equal(r.provider, 'openrouter');
});

test('every call is journaled; probe reports and also feeds the breaker', async () => {
  const c = chainWith({ groq: adapter('groq', () => ok()), openrouter: adapter('openrouter', () => { throw new AiError('denied', 'bad key', { status: 401 }); }) });
  await c.chain.complete(req);
  const good = await c.chain.probe('groq');
  assert.equal(good.ok, true);
  const bad = await c.chain.probe('openrouter');
  assert.equal(bad.ok, false);
  assert.equal(bad.kind, 'denied');
  assert.equal((await c.chain.probe('gemini')).error, 'нет ключа в окружении');
  assert.equal(c.chain.status().find((p) => p.id === 'openrouter').state, 'denied');
  const purposes = c.db.prepare('SELECT purpose, ok FROM ai_calls ORDER BY id').all().map((r) => `${r.purpose}:${r.ok}`);
  assert.deepEqual(purposes, ['summary:1', 'probe:1', 'probe:0']);
});

test('status shows no_key, off and ok states with budgets', () => {
  const c = chainWith({ groq: adapter('groq', () => ok()) }, { providers: [{ id: 'groq', enabled: true, model: 'g1', daily_cap: 5 }, { id: 'openrouter', enabled: true, model: 'a:free', daily_cap: 5 }, { id: 'gemini', enabled: false, model: 'x', daily_cap: 5 }] });
  assert.deepEqual(c.chain.status().map((p) => [p.id, p.state, p.cap]), [['groq', 'ok', 5], ['openrouter', 'no_key', 5], ['gemini', 'off', 5]]);
});
