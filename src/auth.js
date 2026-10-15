// Login for two roles (viewer < admin): scrypt password hashes, HMAC-signed session cookie, per-IP attempt limits.
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

const N = 16384, R = 8, P = 1, KEYLEN = 32;
const SESSION_TTL_S = 12 * 3600;

export function hashPassword(password) {
  const salt = randomBytes(16);
  // Separator is ":" on purpose: Docker Compose would treat "$name" inside an env_file value as a variable and corrupt the hash.
  return `scrypt:${N}:${R}:${P}:${salt.toString('hex')}:${scryptSync(password, salt, KEYLEN, { N, r: R, p: P }).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [alg, n, r, p, saltHex, hashHex] = String(stored ?? '').split(/[:$]/); // the older "$"-separated form is still accepted
  if (alg !== 'scrypt' || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Fixed-window counter per key (IP): allows `max` hits per `windowMs`. */
export function createLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  return {
    /** Count one hit; returns { ok, retryAfterS }. */
    hit(key) {
      const t = now();
      let e = hits.get(key);
      if (!e || t - e.start >= windowMs) { e = { start: t, n: 0 }; hits.set(key, e); }
      e.n++;
      if (hits.size > 10_000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
      return e.n <= max ? { ok: true, retryAfterS: 0 } : { ok: false, retryAfterS: Math.ceil((e.start + windowMs - t) / 1000) };
    },
    /** Is the key already over the limit (without counting)? */
    blocked(key) {
      const e = hits.get(key);
      const t = now();
      return e && t - e.start < windowMs && e.n > max ? Math.ceil((e.start + windowMs - t) / 1000) : 0;
    },
    reset(key) { hits.delete(key); },
  };
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function createAuth(config, { now = Date.now } = {}) {
  const accounts = { admin: config.admin, viewer: config.viewer };
  const failures = createLimiter({ max: 5, windowMs: 10 * 60_000, now });
  const secret = config.sessionSecret;
  const sign = (payload) => createHmac('sha256', secret).update(payload).digest();

  function login(username, password, ip) {
    const wait = failures.blocked(ip);
    if (wait) return { ok: false, reason: 'rate_limited', retryAfterS: wait };
    let role = null;
    for (const r of ['admin', 'viewer']) { // always check both, so timing does not reveal which account exists
      const a = accounts[r];
      const good = Boolean(a.user && a.hash) && username === a.user && verifyPassword(String(password ?? ''), a.hash);
      if (good && !role) role = r;
    }
    if (!role) {
      verifyPassword('x', 'scrypt:16384:8:1:00:00'); // burn comparable time on a miss
      const h = failures.hit(ip);
      return { ok: false, reason: h.ok ? 'bad_credentials' : 'rate_limited', retryAfterS: h.retryAfterS };
    }
    failures.reset(ip);
    return { ok: true, role, user: username };
  }

  function issue(role, user) {
    const payload = b64(JSON.stringify({ role, user, exp: Math.floor(now() / 1000) + SESSION_TTL_S }));
    return `${payload}.${b64(sign(payload))}`;
  }

  /** Cookie value -> { role, user } or null (bad signature, expired, malformed). */
  function verify(value) {
    if (!secret || typeof value !== 'string') return null;
    const [payload, mac] = value.split('.');
    if (!payload || !mac) return null;
    const expected = sign(payload);
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return s.exp > now() / 1000 && (s.role === 'admin' || s.role === 'viewer') ? { role: s.role, user: s.user } : null;
    } catch { return null; }
  }

  const cookie = (value, { secure }) => `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_S}${secure ? '; Secure' : ''}`;
  const clearCookie = ({ secure }) => `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
  const readCookie = (header) => /(?:^|;\s*)sid=([^;]+)/.exec(header ?? '')?.[1] ?? null;
  const enabled = () => Boolean(secret && ((accounts.viewer.user && accounts.viewer.hash) || (accounts.admin.user && accounts.admin.hash)));

  return { login, issue, verify, cookie, clearCookie, readCookie, enabled };
}

export const roleAtLeast = (have, need) => need === 'public' || (need === 'viewer' && (have === 'viewer' || have === 'admin')) || (need === 'admin' && have === 'admin');
