// HTTP layer: security headers, sessions and roles, CSRF guard, rate limits, static files, JSON API routes, SSE stream.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync, createReadStream } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createApi } from './api.js';
import { createLimiter, roleAtLeast } from './auth.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const PAGES = [['/', 'index.html', 'viewer'], ['/login', 'login.html', 'public'], ['/monitor', 'monitor.html', 'viewer'], ['/about', 'about.html', 'viewer'], ['/admin', 'admin.html', 'admin']];
const MAX_BODY = 64 * 1024;
const MAX_SSE = 20;

const CSP = "default-src 'self'; img-src 'self' https://www.metacritic.com https://*.metacritic.com data:; frame-src https://cdn.jwplayer.com https://www.youtube-nocookie.com; "
  + "script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function loadStatic() {
  const files = new Map();
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full, `${prefix}${name}/`); continue; }
      const body = readFileSync(full);
      const type = TYPES[extname(name)] ?? 'application/octet-stream';
      files.set(`${prefix}${name}`, { body, gz: /^(text|image\/svg|application\/json)/.test(type) ? gzipSync(body) : null, type, etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"` });
    }
  };
  walk(PUBLIC_DIR, '');
  return files;
}

/** '/api/v1/games/:slug' -> { regex, names } */
function compile(path) {
  const names = [];
  const regex = new RegExp(`^${path.replace(/:[a-z]+/g, (m) => { names.push(m.slice(1)); return '([^/]+)'; })}$`);
  return { regex, names };
}

export function createHttpServer(app) {
  const { cfg, auth, events } = app;
  const files = loadStatic();
  const api = createApi(app);
  const routes = api.routes.map((r) => ({ ...r, ...compile(r.path) }));
  const apiLimiter = createLimiter({ max: 600, windowMs: 60_000 });
  const sse = new Set();
  let sseTimer = null;

  const clientIp = (req) => {
    if (cfg.trustProxy) { const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean); if (xff.length) return xff[xff.length - 1]; }
    return req.socket?.remoteAddress ?? 'unknown';
  };
  const isSecure = (req) => Boolean(req.socket?.encrypted) || (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https');

  function baseHeaders(req) {
    const h = { 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
    if (isSecure(req)) h['strict-transport-security'] = 'max-age=31536000';
    return h;
  }

  function send(req, res, status, body, headers = {}) {
    res.writeHead(status, { ...baseHeaders(req), ...headers });
    res.end(req.method === 'HEAD' ? undefined : body);
  }
  const sendJson = (req, res, status, json, headers = {}) => send(req, res, status, JSON.stringify(json), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  const redirect = (req, res, to) => send(req, res, 302, '', { location: to, 'cache-control': 'no-store' });

  function serveFile(req, res, name, cache) {
    const f = files.get(name);
    if (!f) return false;
    if (req.headers['if-none-match'] === f.etag) { send(req, res, 304, '', { etag: f.etag }); return true; }
    const gz = f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    send(req, res, 200, gz ? f.gz : f.body, { 'content-type': f.type, etag: f.etag, 'cache-control': cache, vary: 'accept-encoding', ...(gz ? { 'content-encoding': 'gzip' } : {}) });
    return true;
  }

  /** Read a small JSON body. An oversized body is rejected without destroying the socket, so the 413 can still be sent. */
  function readBody(req) {
    const tooLarge = () => Object.assign(new Error('слишком большой запрос'), { status: 413 });
    return new Promise((resolve, reject) => {
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) { req.resume(); return reject(tooLarge()); }
      const chunks = [];
      let size = 0;
      let over = false;
      req.on('data', (c) => {
        if (over) return;
        size += c.length;
        if (size > MAX_BODY) { over = true; chunks.length = 0; req.resume(); reject(tooLarge()); return; }
        chunks.push(c);
      });
      req.on('error', reject);
      req.on('end', () => {
        if (over) return;
        if (!size) return resolve({});
        try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); } catch { reject(Object.assign(new Error('некорректный JSON'), { status: 400 })); }
      });
    });
  }

  /** State-changing requests must come from our own pages: custom header plus matching Origin. */
  function csrfOk(req) {
    if (req.headers['x-requested-with'] !== 'fetch') return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === (cfg.trustProxy ? (req.headers['x-forwarded-host'] ?? req.headers.host) : req.headers.host); } catch { return false; }
  }

  function startSse(req, res) {
    if (sse.size >= MAX_SSE) return sendJson(req, res, 503, { error: 'слишком много подключений' });
    res.writeHead(200, { ...baseHeaders(req), 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const client = { res, unsub: app.events.subscribe((ev) => write(res, 'log', { at: ev.at, level: ev.level, scope: ev.scope, message: ev.message })) };
    sse.add(client);
    write(res, 'snapshot', app.snapshot());
    for (const ev of app.events.recent(30)) write(res, 'log', { at: ev.at, level: ev.level, scope: ev.scope, message: ev.message });
    if (!sseTimer) {
      let beat = 0;
      sseTimer = setInterval(() => {
        const snap = JSON.stringify(app.snapshot());
        const ping = ++beat % 7 === 0;
        for (const c of sse) { c.res.write(`event: snapshot\ndata: ${snap}\n\n`); if (ping) c.res.write(': ping\n\n'); }
      }, 2000);
      sseTimer.unref?.();
    }
    req.on('close', () => { client.unsub(); sse.delete(client); if (!sse.size && sseTimer) { clearInterval(sseTimer); sseTimer = null; } });
  }
  const write = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  async function sendBackup(req, res) {
    const dir = mkdtempSync(join(tmpdir(), 'bk-'));
    const file = join(dir, 'games.db');
    app.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    res.writeHead(200, { ...baseHeaders(req), 'content-type': 'application/octet-stream', 'content-length': statSync(file).size, 'content-disposition': 'attachment; filename="games-backup.db"', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res).on('close', () => rmSync(dir, { recursive: true, force: true }));
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const path = url.pathname;
    const secure = isSecure(req);

    if (path.startsWith('/assets/')) { if (!['GET', 'HEAD'].includes(req.method) || !serveFile(req, res, path.slice(1), 'public, max-age=300')) sendJson(req, res, 404, { error: 'не найдено' }); return; }

    const session = auth.verify(auth.readCookie(req.headers.cookie));

    if (path.startsWith('/api/')) {
      const ip = clientIp(req);
      const lim = apiLimiter.hit(ip);
      if (!lim.ok) return sendJson(req, res, 429, { error: 'слишком много запросов', retry_in_s: lim.retryAfterS }, { 'retry-after': String(lim.retryAfterS) });
      if (path === '/api/v1/stream' && req.method === 'GET') {
        if (!session) return sendJson(req, res, 401, { error: 'нужен вход' });
        return startSse(req, res);
      }
      const matches = routes.filter((r) => r.regex.test(path));
      if (!matches.length) return sendJson(req, res, 404, { error: 'не найдено' });
      const route = matches.find((r) => r.method === req.method);
      if (!route) return sendJson(req, res, 405, { error: 'метод не поддерживается' });
      if (route.role !== 'public' && !session) return sendJson(req, res, 401, { error: 'нужен вход' });
      if (!roleAtLeast(session?.role, route.role)) return sendJson(req, res, 403, { error: 'недостаточно прав' });
      if (req.method !== 'GET' && !csrfOk(req)) return sendJson(req, res, 403, { error: 'запрос отклонён' });
      const m = route.regex.exec(path);
      const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      const out = await route.handler({ req, params, query: Object.fromEntries(url.searchParams), body, session, ip, secure });
      if (out.backup) return sendBackup(req, res);
      if (out.csv !== undefined) return send(req, res, out.status ?? 200, out.csv, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', ...(out.headers ?? {}) });
      return sendJson(req, res, out.status ?? 200, out.json, out.headers ?? {});
    }

    if (!['GET', 'HEAD'].includes(req.method)) return sendJson(req, res, 405, { error: 'метод не поддерживается' });
    const game = /^\/game\/[a-z0-9][a-z0-9-]*$/.test(path);
    const page = PAGES.find(([p]) => p === path) ?? (game ? [path, 'game.html', 'viewer'] : null);
    if (!page) return sendJson(req, res, 404, { error: 'страница не найдена' });
    const [, file, role] = page;
    if (path === '/login' && session) return redirect(req, res, '/');
    if (role !== 'public' && !session) return redirect(req, res, '/login');
    if (!roleAtLeast(session?.role, role)) return redirect(req, res, '/');
    serveFile(req, res, file, 'no-store');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      // This handler must never throw: a failure here would take the whole service down.
      try {
        const status = err.status && err.status < 500 ? err.status : 500;
        if (status === 500) events.error('http', `Ошибка запроса ${req.method} ${req.url.split('?')[0]}: ${err.message}`);
        if (res.destroyed || res.writableEnded) return;
        if (!res.headersSent) sendJson(req, res, status, { error: status === 500 ? 'внутренняя ошибка' : err.message }, status === 413 ? { connection: 'close' } : {});
        else res.end();
      } catch { try { res.destroy(); } catch { /* nothing left to do */ } }
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.closeSse = () => { for (const c of sse) { c.unsub(); c.res.end(); } sse.clear(); if (sseTimer) { clearInterval(sseTimer); sseTimer = null; } };
  return server;
}
