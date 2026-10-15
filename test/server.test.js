import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createHttpServer } from '../src/server.js';
import { hashPassword, verifyPassword, createAuth, createLimiter } from '../src/auth.js';
import { createClient } from '../src/mc/client.js';
import { createMockFetch, loadFixtures } from '../src/mc/mock.js';
import { createAdapters } from '../src/ai/providers.js';
import { freshDb } from './helpers.js';

const cfg = loadConfig({
  MOCK: '1', SESSION_SECRET: 's'.repeat(40), VIEWER_USER: 'viewer', VIEWER_PASS_HASH: hashPassword('viewer-pass-1'),
  ADMIN_USER: 'admin', ADMIN_PASS_HASH: hashPassword('admin-pass-1'),
  OBSERVER_USER: 'observer', OBSERVER_PASS_HASH: hashPassword('observer-pass-1'),
});
let app, server, base;

before(async () => {
  const db = freshDb();
  const client = createClient({ apiKey: 't', settings: () => app.settings(), fetchImpl: createMockFetch(loadFixtures()), sleep: async () => {} });
  app = createApp(cfg, { db, client, logSink: null, adapters: createAdapters({}, { mock: true }), dataDir: ':memory:' });
  server = createHttpServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeSse(); server.close(); });

async function call(path, { method = 'GET', body, cookie, headers = {}, csrf = method !== 'GET' } = {}) {
  const res = await fetch(base + path, {
    method, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(csrf ? { 'x-requested-with': 'fetch' } : {}), ...(cookie ? { cookie } : {}), ...headers },
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}
async function login(username, password) {
  const r = await call('/api/v1/auth/login', { method: 'POST', body: { username, password } });
  return r.status === 200 ? r.headers.getSetCookie()[0].split(';')[0] : null;
}
const waitIdle = async () => { for (let i = 0; i < 200 && app.scheduler.isRunning(); i++) await new Promise((r) => setTimeout(r, 25)); };
let viewer, admin, observer;

test('auth primitives: scrypt hashes verify, sessions are signed and expire, limiter counts', () => {
  const h = hashPassword('correct horse');
  assert.ok(verifyPassword('correct horse', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.ok(!verifyPassword('x', 'garbage'));
  assert.match(h, /^scrypt(:[0-9a-f]+){5}$/, 'only [0-9a-f:] so a Docker env_file cannot mangle the hash');
  assert.ok(!h.includes('$'));
  assert.ok(verifyPassword('correct horse', h.replaceAll(':', '$')), 'older $-separated hashes still verify');
  let t = 1_000_000_000_000;
  const auth = createAuth(cfg, { now: () => t });
  const cookie = auth.issue('viewer', 'v');
  assert.deepEqual(auth.verify(cookie), { role: 'viewer', user: 'v' });
  assert.equal(auth.verify(`${cookie}x`), null, 'tampered signature');
  assert.equal(auth.verify(cookie.replace(/^[^.]+/, Buffer.from('{"role":"admin","user":"v","exp":9999999999}').toString('base64url'))), null, 'forged role');
  t += 13 * 3600_000;
  assert.equal(auth.verify(cookie), null, 'expired after 12 h');
  let now = 0;
  const lim = createLimiter({ max: 2, windowMs: 1000, now: () => now });
  assert.ok(lim.hit('a').ok && lim.hit('a').ok && !lim.hit('a').ok);
  now = 1001;
  assert.ok(lim.hit('a').ok, 'window resets');
});

test('everything is closed without a login; health and the login page are open', async () => {
  assert.equal((await call('/api/health')).status, 200);
  const page = await call('/');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');
  assert.equal((await call('/login')).status, 200);
  for (const p of ['/api/v1/games', '/api/v1/monitor', '/api/v1/me', '/api/v1/settings', '/api/v1/stream']) assert.equal((await call(p)).status, 401, p);
  for (const p of ['/monitor', '/about', '/admin', '/game/x']) assert.equal((await call(p)).status, 302, p);
});

test('security headers are set on pages, assets and API', async () => {
  for (const p of ['/login', '/assets/app.css', '/api/health']) {
    const r = await call(p);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/, p);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), p);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.equal((await call('/api/health')).headers.get('cache-control'), 'no-store');
});

test('every script and stylesheet a page references is actually served', async () => {
  const pages = readdirSync(new URL('../public/', import.meta.url)).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length >= 6);
  for (const page of pages) {
    const html = readFileSync(new URL(`../public/${page}`, import.meta.url), 'utf8');
    for (const ref of [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])) {
      const r = await call(ref);
      assert.equal(r.status, 200, `${page} -> ${ref}`);
    }
  }
  const css = await fetch(`${base}/assets/app.css`);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.match(css.headers.get('cache-control'), /max-age/);
  const js = await fetch(`${base}/assets/common.js`);
  assert.match(js.headers.get('content-type'), /text\/javascript/);
});

test('login: wrong credentials are refused, the right ones give an HttpOnly signed cookie, repeated failures lock the IP out', async () => {
  const bad = await call('/api/v1/auth/login', { method: 'POST', body: { username: 'viewer', password: 'nope' } });
  assert.equal(bad.status, 401);
  const ok = await call('/api/v1/auth/login', { method: 'POST', body: { username: 'viewer', password: 'viewer-pass-1' } });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.getSetCookie()[0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  viewer = cookie.split(';')[0];
  admin = await login('admin', 'admin-pass-1');
  assert.ok(admin);
  observer = await login('observer', 'observer-pass-1');
  assert.ok(observer);
  assert.deepEqual((await call('/api/v1/me', { cookie: viewer })).json.role, 'viewer');
  assert.equal((await call('/api/v1/me', { cookie: admin })).json.role, 'admin');
  // lock-out (all test requests share one IP)
  for (let i = 0; i < 6; i++) await call('/api/v1/auth/login', { method: 'POST', body: { username: 'viewer', password: `bad${i}` } });
  const locked = await call('/api/v1/auth/login', { method: 'POST', body: { username: 'viewer', password: 'viewer-pass-1' } });
  assert.equal(locked.status, 429);
});

test('state-changing requests need the custom header and a matching origin', async () => {
  assert.equal((await call('/api/v1/runs', { method: 'POST', body: {}, cookie: admin, csrf: false })).status, 403);
  assert.equal((await call('/api/v1/runs', { method: 'POST', body: {}, cookie: admin, headers: { origin: 'https://evil.example' } })).status, 403);
});

test('roles: a viewer cannot reach admin API or the admin page, an admin can', async () => {
  assert.equal((await call('/api/v1/settings', { cookie: viewer })).status, 403);
  assert.equal((await call('/api/v1/jobs', { cookie: viewer })).status, 403);
  assert.equal((await call('/api/v1/scheduler/pause', { method: 'POST', cookie: viewer })).status, 403);
  const page = await call('/admin', { cookie: viewer });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/');
  assert.equal((await call('/admin', { cookie: admin })).status, 200);
  assert.equal((await call('/api/v1/settings', { cookie: admin })).status, 200);
});

test('observer: reads every admin screen, changes and downloads nothing', async () => {
  assert.equal((await call('/api/v1/me', { cookie: observer })).json.role, 'observer');
  for (const p of ['/api/v1/settings', '/api/v1/providers', '/api/v1/jobs', '/api/v1/audit', '/api/v1/events', '/api/v1/admin/games', '/api/v1/ai/stats', '/api/v1/monitor', '/api/v1/games']) {
    assert.equal((await call(p, { cookie: observer })).status, 200, p);
  }
  assert.equal((await call('/admin', { cookie: observer })).status, 200, 'the admin page opens for the observer');
  const writes = [['PUT', '/api/v1/settings', { interval_min: 30 }], ['POST', '/api/v1/settings/reset', {}], ['POST', '/api/v1/settings/import', { values: {} }],
    ['POST', '/api/v1/scheduler/pause', {}], ['POST', '/api/v1/scheduler/resume', {}], ['POST', '/api/v1/runs/current/cancel', {}], ['POST', '/api/v1/cursor/reset', {}],
    ['POST', '/api/v1/source/check', {}], ['POST', '/api/v1/summaries/recompute', {}], ['POST', '/api/v1/jobs/retry-failed', {}], ['POST', '/api/v1/jobs/1/retry', {}],
    ['POST', '/api/v1/providers/groq/probe', {}], ['POST', '/api/v1/providers/reset', {}], ['PATCH', '/api/v1/providers/groq', { enabled: false }],
    ['POST', '/api/v1/games', { slug: 'x' }], ['PATCH', '/api/v1/games/elden-ring', { hidden: true }], ['POST', '/api/v1/games/elden-ring/reprocess', {}], ['DELETE', '/api/v1/games/elden-ring', undefined]];
  for (const [method, path, body] of writes) {
    const r = await call(path, { method, body, cookie: observer });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.match(r.json.error, /Только просмотр/, `${method} ${path}`);
  }
  for (const p of ['/api/v1/backup', '/api/v1/export/games.json', '/api/v1/export/games.csv', '/api/v1/settings/export']) {
    assert.equal((await call(p, { cookie: observer })).status, 403, `download ${p}`);
  }
  assert.equal((await call('/api/v1/settings', { cookie: admin })).json.values.interval_min, 60, 'nothing was changed');
  assert.equal((await call('/api/v1/audit', { cookie: admin })).json.audit.length, 0, 'and nothing was audited');
  assert.equal((await call('/api/v1/auth/logout', { method: 'POST', cookie: observer })).status, 200, 'logout still works');
});

test('a manual run collects recorded games; list, filters, search and sort work', async () => {
  const run = await call('/api/v1/runs', { method: 'POST', body: { limit: 2 }, cookie: admin });
  assert.equal(run.status, 202);
  await waitIdle();
  const add = await call('/api/v1/games', { method: 'POST', body: { url: 'https://www.metacritic.com/game/elden-ring/' }, cookie: admin });
  assert.equal(add.status, 202);
  for (let i = 0; i < 200 && (await call('/api/v1/games?q=elden', { cookie: viewer })).json.total === 0; i++) await new Promise((r) => setTimeout(r, 25));
  while ((await app.summarizer.runOnce()) === 'done');

  const all = (await call('/api/v1/games', { cookie: viewer })).json;
  assert.equal(all.total, 3);
  assert.ok(all.facets.platforms.length > 0 && all.facets.genres.length > 0);
  const elden = all.items.find((g) => g.slug === 'elden-ring');
  assert.ok(elden.platforms.length === 5 && elden.platforms[0].name);
  assert.equal(elden.summary_status, 'ok');

  assert.equal((await call('/api/v1/games?q=elden', { cookie: viewer })).json.total, 1);
  assert.equal((await call('/api/v1/games?q=%25', { cookie: viewer })).json.total, 0, 'LIKE wildcards are escaped');
  assert.equal((await call('/api/v1/games?platform=xbox-series-x', { cookie: viewer })).json.items.every((g) => g.platforms.some((p) => p.slug === 'xbox-series-x')), true);
  assert.equal((await call('/api/v1/games?genre=Action%20RPG', { cookie: viewer })).json.total, 1);
  assert.equal((await call('/api/v1/games?year=2022', { cookie: viewer })).json.total, 1);
  const sorted = (await call('/api/v1/games?sort=critic&dir=desc', { cookie: viewer })).json.items.map((g) => Math.max(...g.platforms.map((p) => p.critic ?? -1)));
  assert.deepEqual(sorted, [...sorted].sort((a, b) => b - a));
  assert.equal((await call('/api/v1/games?per=1&page=2', { cookie: viewer })).json.items.length, 1);
  assert.equal((await call('/api/v1/games?aspect=bogus:x', { cookie: viewer })).status, 400);
  const aspect = (await call('/api/v1/games?aspect=praise:gameplay', { cookie: viewer })).json;
  assert.ok(aspect.total >= 1 && aspect.items.every((g) => g.praise.includes('gameplay')));
});

test('the game card has platforms, grounded summaries with evidence, history, similar games and freshness', async () => {
  const card = (await call('/api/v1/games/elden-ring', { cookie: viewer })).json;
  assert.equal(card.title, 'Elden Ring');
  assert.equal(card.developer, 'From Software');
  assert.equal(card.platforms.length, 5);
  assert.ok(card.summaries.critics.likes.length > 0 && card.summaries.critics.likes.every((p) => p.text && p.evidence));
  assert.equal(card.summaries.users.status, 'ok');
  assert.ok(Object.keys(card.history).length > 0);
  assert.ok(Array.isArray(card.similar));
  assert.ok(card.freshness.last_fetched_at);
  assert.match(card.metacritic_url, /metacritic\.com\/game\/elden-ring/);
  assert.equal((await call('/api/v1/games/no-such-game', { cookie: viewer })).status, 404);
});

test('viewer manual run: allowed once, then the cooldown applies; admin is not limited', async () => {
  await waitIdle();
  const first = await call('/api/v1/runs', { method: 'POST', body: { dryRun: true, limit: 1 }, cookie: viewer });
  assert.equal(first.status, 202, 'viewer cannot steer: parameters are ignored, a normal run starts');
  await waitIdle();
  const second = await call('/api/v1/runs', { method: 'POST', body: {}, cookie: viewer });
  assert.equal(second.status, 429);
  assert.equal(second.json.reason, 'cooldown');
  assert.ok(second.json.retry_in_s > 0);
  const adminRun = await call('/api/v1/runs', { method: 'POST', body: { dryRun: true }, cookie: admin });
  assert.equal(adminRun.status, 202);
  await waitIdle();
  assert.equal((await call('/api/v1/runs', { method: 'POST', body: { source: 'bogus' }, cookie: admin })).status, 400);
});

test('monitor snapshot and run history', async () => {
  const m = (await call('/api/v1/monitor', { cookie: viewer })).json;
  assert.equal(m.counters.games_total, 3);
  assert.ok(m.workers.some((w) => w.id === 'fetcher') && m.workers.some((w) => w.id === 'summarizer'));
  assert.ok(Array.isArray(m.providers) && m.providers.length === 4);
  assert.ok(['green', 'yellow', 'red', 'unknown'].includes(m.source.status));
  assert.ok(typeof m.db.size_mb === 'number');
  const runs = (await call('/api/v1/runs', { cookie: viewer })).json.runs;
  assert.ok(runs.length >= 2);
  const detail = (await call(`/api/v1/runs/${runs.at(-1).id}`, { cookie: viewer })).json;
  assert.ok(Array.isArray(detail.items));
});

test('SSE stream sends a snapshot and log events', async () => {
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/v1/stream`, { headers: { cookie: viewer }, signal: ctl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  let buf = '';
  while (!/event: snapshot\ndata: .+\n\n/.test(buf)) { const { value, done } = await reader.read(); if (done) break; buf += Buffer.from(value).toString(); }
  ctl.abort();
  const data = /event: snapshot\ndata: (.+)\n\n/.exec(buf)[1];
  assert.ok(JSON.parse(data).counters);
  assert.ok(!/"ip"|data":/.test(buf.split('event: snapshot')[0]), 'log events carry no private details');
});

test('admin: settings are validated, saved, audited; providers can be probed and toggled', async () => {
  assert.equal((await call('/api/v1/settings', { method: 'PUT', body: { interval_min: 1 }, cookie: admin })).status, 400);
  assert.equal((await call('/api/v1/settings', { method: 'PUT', body: { bogus: 1 }, cookie: admin })).status, 400);
  const saved = await call('/api/v1/settings', { method: 'PUT', body: { interval_min: 30, public_run_cooldown_s: 120 }, cookie: admin });
  assert.equal(saved.json.values.interval_min, 30);
  const audit = (await call('/api/v1/audit', { cookie: admin })).json.audit;
  assert.ok(audit.some((a) => a.action === 'settings.set' && a.actor === 'admin'));
  const probe = (await call('/api/v1/providers/groq/probe', { method: 'POST', cookie: admin })).json;
  assert.equal(probe.ok, true);
  const off = await call('/api/v1/providers/gemini', { method: 'PATCH', body: { enabled: false }, cookie: admin });
  assert.equal(off.json.values.find((p) => p.id === 'gemini').enabled, false);
  assert.equal((await call('/api/v1/providers/nope', { method: 'PATCH', body: {}, cookie: admin })).status, 404);
  assert.equal((await call('/api/v1/providers/openrouter', { method: 'PATCH', body: { model: 'paid/model' }, cookie: admin })).status, 400, 'only :free models for OpenRouter');
});

test('admin: pause/resume, cursor reset, jobs, game flags, reprocess, delete', async () => {
  assert.equal((await call('/api/v1/scheduler/pause', { method: 'POST', cookie: admin })).status, 200);
  assert.equal((await call('/api/v1/monitor', { cookie: admin })).json.scheduler.paused, true);
  assert.equal((await call('/api/v1/scheduler/resume', { method: 'POST', cookie: admin })).status, 200);
  assert.equal((await call('/api/v1/cursor/reset', { method: 'POST', body: { source: 'finder', offset: 40 }, cookie: admin })).status, 200);
  assert.equal((await call('/api/v1/cursor/reset', { method: 'POST', body: { offset: -5 }, cookie: admin })).status, 400);
  assert.ok((await call('/api/v1/jobs', { cookie: admin })).json.stats);
  assert.equal((await call('/api/v1/games/elden-ring', { method: 'PATCH', body: { hidden: true }, cookie: admin })).status, 200);
  assert.equal((await call('/api/v1/games/elden-ring', { cookie: viewer })).status, 404, 'hidden games disappear for viewers');
  assert.equal((await call('/api/v1/games', { cookie: viewer })).json.total, 2);
  await call('/api/v1/games/elden-ring', { method: 'PATCH', body: { hidden: false }, cookie: admin });
  assert.equal((await call('/api/v1/games/elden-ring', { method: 'PATCH', body: { hidden: 'yes' }, cookie: admin })).status, 400);
  const re = await call('/api/v1/games/elden-ring/reprocess', { method: 'POST', body: { stages: ['summary'] }, cookie: admin });
  assert.equal(re.status, 202);
  assert.equal((await call('/api/v1/games/no-such/reprocess', { method: 'POST', body: {}, cookie: admin })).status, 404);
  assert.equal((await call('/api/v1/games', { method: 'POST', body: { url: 'not a slug!' }, cookie: admin })).status, 400);
  assert.equal((await call('/api/v1/games/ratatan', { method: 'DELETE', cookie: admin })).status, 200);
  assert.equal((await call('/api/v1/games', { cookie: viewer })).json.total, 2);
});

test('admin: exports and the database backup', async () => {
  const csv = await call('/api/v1/export/games.csv', { cookie: admin });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.text, /^slug,title/);
  assert.ok(Array.isArray((await call('/api/v1/export/games.json', { cookie: admin })).json));
  const res = await fetch(`${base}/api/v1/backup`, { headers: { cookie: admin } });
  assert.equal(res.status, 200);
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
});

test('routing edge cases: unknown paths, wrong methods, oversized and broken bodies, static ETag', async () => {
  assert.equal((await call('/api/v1/nope', { cookie: viewer })).status, 404);
  assert.equal((await call('/api/v1/games', { method: 'DELETE', cookie: viewer })).status, 405);
  const huge = await fetch(`${base}/api/v1/runs`, { method: 'POST', headers: { cookie: admin, 'x-requested-with': 'fetch', 'content-type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(70_000) }) });
  assert.equal(huge.status, 413);
  const broken = await fetch(`${base}/api/v1/runs`, { method: 'POST', headers: { cookie: admin, 'x-requested-with': 'fetch' }, body: '{oops' });
  assert.equal(broken.status, 400);
  const first = await fetch(`${base}/assets/app.css`);
  const again = await fetch(`${base}/assets/app.css`, { headers: { 'if-none-match': first.headers.get('etag') } });
  assert.equal(again.status, 304);
  assert.equal((await call('/game/..%2F..%2Fetc', { cookie: viewer })).status, 404);
});

test('stored hostile text is returned as inert JSON text', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  app.db.prepare("UPDATE games SET title = ?, description = ? WHERE slug = 'castlevania-belmonts-curse'").run(evil, `<script>${evil}</script>`);
  const r = await call('/api/v1/games/castlevania-belmonts-curse', { cookie: viewer });
  assert.equal(r.json.title, evil);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('every front-end script is syntactically valid', () => {
  const dir = decodeURIComponent(new URL('../public/assets/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const r = spawnSync(process.execPath, ['--check', join(dir, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr.split('\n').slice(0, 4).join(' ')}`);
  }
});

test('the front end never builds HTML from data: no innerHTML, inline scripts or inline styles', () => {
  const dir = new URL('../public/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  for (const f of walk(decodeURIComponent(dir))) {
    const src = readFileSync(f, 'utf8');
    if (f.endsWith('.js')) assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(src), `${f}: dangerous API`);
    if (f.endsWith('.html')) {
      assert.ok(!/\sstyle="/.test(src), `${f}: inline style attribute (blocked by CSP)`);
      assert.ok(!/<script(?![^>]*\ssrc=)/.test(src), `${f}: inline script (blocked by CSP)`);
      assert.ok(!/\son[a-z]+="/.test(src), `${f}: inline event handler`);
    }
  }
});
