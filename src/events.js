// Event journal: table (pruned), in-memory ring for the live view, subscribers (SSE), optional stdout JSON line.
const SECRET_KEY = /key|token|password|secret|authorization|cookie/i;
const redact = (k, v) => (SECRET_KEY.test(k) && typeof v === 'string' ? '***' : v);

export function createEvents({ db, now = () => new Date(), sink = null, maxRows = () => 5000, ringSize = 300 }) {
  const ring = [];
  const subscribers = new Set();
  const insert = db.prepare('INSERT INTO events(at, level, scope, message, data) VALUES (?, ?, ?, ?, ?)');
  let sincePrune = 0;

  /** Keep only the newest maxRows rows. */
  function prune() {
    db.prepare('DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?)').run(maxRows());
  }

  function log(level, scope, message, data = null) {
    const safe = data === null ? null : JSON.parse(JSON.stringify(data, redact));
    const ev = { at: now().toISOString(), level, scope, message, data: safe };
    ev.id = Number(insert.run(ev.at, level, scope, message, safe === null ? null : JSON.stringify(safe)).lastInsertRowid);
    ring.push(ev);
    if (ring.length > ringSize) ring.shift();
    if (++sincePrune >= 100) { sincePrune = 0; prune(); }
    sink?.(JSON.stringify({ ts: ev.at, level, scope, msg: message, data: safe }));
    for (const fn of subscribers) { try { fn(ev); } catch { /* a broken listener must not break logging */ } }
    return ev;
  }

  return {
    log,
    info: (scope, msg, data) => log('info', scope, msg, data),
    warn: (scope, msg, data) => log('warn', scope, msg, data),
    error: (scope, msg, data) => log('error', scope, msg, data),
    recent: (n = 100) => ring.slice(-n),
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    prune,
  };
}
