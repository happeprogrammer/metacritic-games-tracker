import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/mc/client.js';
import { defaults } from '../src/settings.js';

const json = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const OK = { data: { item: { title: 'T', slug: 't', platforms: [] } } };

function setup(responses, overrides = {}, clientOpts = {}) {
  const calls = [];
  const sleeps = [];
  const queue = [...responses];
  const fetchImpl = async (url) => {
    calls.push(url);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next();
  };
  const settings = { ...defaults(), ...overrides };
  const client = createClient({ apiKey: 'k', settings: () => settings, fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, ...clientOpts });
  return { client, calls, sleeps };
}

test('a 500 is retried with backoff and then succeeds', async () => {
  const { client, calls, sleeps } = setup([() => json('x', 500), () => json(OK)]);
  const r = await client.product('t');
  assert.equal(r.game.title, 'T');
  assert.equal(calls.length, 2);
  assert.ok(sleeps.some((ms) => ms === 2000), 'base 2000 ms * 2^0 * (0.5 + 0.5)');
});

test('429 honours Retry-After (capped at 60 s)', async () => {
  const { client, sleeps } = setup([() => json('x', 429, { 'retry-after': '3' }), () => json(OK)]);
  await client.product('t');
  assert.ok(sleeps.includes(3000));
  const slow = setup([() => json('x', 429, { 'retry-after': '999' }), () => json(OK)]);
  await slow.client.product('t');
  assert.ok(slow.sleeps.includes(60000));
});

test('404 is not retried and does not count against the source', async () => {
  const { client, calls } = setup([() => json('no', 404)]);
  await assert.rejects(client.product('t'), (e) => e.kind === 'http' && e.status === 404);
  assert.equal(calls.length, 1);
  assert.equal(client.state().failures, 0);
});

test('a body that is not JSON is a schema error, not retried', async () => {
  const { client, calls } = setup([() => json('<html>oops</html>')]);
  await assert.rejects(client.product('t'), (e) => e.kind === 'schema');
  assert.equal(calls.length, 1);
});

test('network errors give up after retry_max retries', async () => {
  const { client, calls } = setup([new Error('ECONNRESET')], { retry_max: 2 });
  await assert.rejects(client.product('t'), (e) => e.kind === 'network' && /ECONNRESET/.test(e.message));
  assert.equal(calls.length, 3);
});

test('the breaker opens after a streak of failures and fails fast, then recovers', async () => {
  let t = 1_000_000;
  const { client, calls } = setup([() => json('x', 500)], { retry_max: 0 }, { breakerThreshold: 2, breakerCooldownMs: 60_000, now: () => t });
  await assert.rejects(client.product('t'), (e) => e.status === 500);
  await assert.rejects(client.product('t'), (e) => e.status === 500);
  assert.equal(client.state().open, true);
  const before = calls.length;
  await assert.rejects(client.product('t'), (e) => e.kind === 'breaker');
  assert.equal(calls.length, before, 'no request is made while open');
  t += 61_000;
  assert.equal(client.state().open, false);
});

test('concurrent requests are spaced by request_delay_ms', async () => {
  const stamps = [];
  const fetchImpl = async () => { stamps.push(Date.now()); return json(OK); };
  const settings = { ...defaults(), request_delay_ms: 300 };
  const client = createClient({ apiKey: 'k', settings: () => settings, fetchImpl });
  await Promise.all([client.product('a'), client.product('b'), client.product('c')]);
  stamps.sort((x, y) => x - y);
  assert.ok(stamps[1] - stamps[0] >= 280 && stamps[2] - stamps[1] >= 280, `gaps ${stamps[1] - stamps[0]}, ${stamps[2] - stamps[1]}`);
});

test('the API key goes into the URL and the configured User-Agent into the headers', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, ua: init.headers['user-agent'] }; return json(OK); };
  const settings = { ...defaults(), user_agent: 'TestAgent/1' };
  await createClient({ apiKey: 'KEY123', settings: () => settings, fetchImpl }).product('t');
  assert.match(seen.url, /apiKey=KEY123$/);
  assert.equal(seen.ua, 'TestAgent/1');
});
