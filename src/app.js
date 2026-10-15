// Composition root: wires every part together. Tests build it with in-memory pieces; main.js builds the real one.
import { openDb, migrate } from './db.js';
import { loadSettings } from './settings.js';
import { createEvents } from './events.js';
import { createClientFromConfig } from './mc/client.js';
import { createAdapters } from './ai/providers.js';
import { createChain } from './ai/chain.js';
import { planSummary } from './ai/summarize.js';
import { createScheduler } from './scheduler.js';
import { createSummarizer } from './workers.js';
import { createHousekeeper } from './housekeeper.js';
import { createSimilar } from './similar.js';
import { createManage } from './manage.js';
import { createAuth } from './auth.js';
import { dayOf } from './selection.js';
import * as jobs from './jobs.js';

export function createApp(cfg, o = {}) {
  const db = o.db ?? openDb(`${cfg.dataDir}/games.db`);
  migrate(db);
  const now = o.now ?? (() => new Date());
  const settings = () => loadSettings(db);
  const events = createEvents({ db, now, sink: o.logSink === undefined ? (line) => console.log(line) : o.logSink, maxRows: () => settings().events_max_rows });
  const client = o.client ?? createClientFromConfig(cfg, settings);
  const chain = createChain({ db, settings, adapters: o.adapters ?? createAdapters(cfg.keys, { mock: cfg.mock }), now, events });

  // Hooks that queue follow-up work after a game is saved (let's plays are added by the letsplay module when present).
  const afterSave = [];
  const onGameSaved = (gameId) => { planSummary(db, gameId, settings(), now); for (const f of afterSave) f(gameId); };

  const scheduler = createScheduler({ db, client, events, now, settings, onGameSaved, checkSource: o.checkSource });
  const summarizer = createSummarizer({ db, chain, events, settings, now, sleep: o.sleep });
  const housekeeper = createHousekeeper({ db, events, settings, dataDir: o.dataDir ?? cfg.dataDir, now });
  const workers = [summarizer];
  const similar = createSimilar(db);
  const manage = createManage({ db, client, settings, events, scheduler, onGameSaved, now });
  const auth = createAuth(cfg);
  const startedAt = Date.now();

  const app = { cfg, db, now, settings, events, client, chain, scheduler, summarizer, housekeeper, similar, manage, auth, workers, afterSave, version: '0.1.0' };

  app.snapshot = () => {
    const s = settings();
    const day = dayOf(now(), s.tz);
    const one = (sql, ...a) => db.prepare(sql).get(...a).c;
    const base = scheduler.snapshot();
    const size = db.prepare('SELECT page_count * page_size AS b FROM pragma_page_count(), pragma_page_size()').get().b;
    return {
      now: now().toISOString(), uptime_s: Math.round((Date.now() - startedAt) / 1000), version: app.version, mock: cfg.mock,
      scheduler: base.scheduler, run: base.run, manual_run: base.manual_run, source: base.source,
      workers: [...base.workers, ...workers.map((w) => w.snapshot()), housekeeper.snapshot()],
      queue: jobs.stats(db),
      counters: {
        games_total: one('SELECT COUNT(*) AS c FROM games WHERE hidden = 0'),
        games_today: one('SELECT COUNT(*) AS c FROM games WHERE processed_day = ?', day),
        summaries_ok: one("SELECT COUNT(DISTINCT game_id) AS c FROM summaries WHERE status = 'ok'"),
        summaries_waiting: one("SELECT COUNT(*) AS c FROM jobs WHERE type = 'summarize' AND status IN ('pending', 'running')"),
        letsplay_ok: one("SELECT COUNT(*) AS c FROM letsplay WHERE status = 'ok'"),
      },
      providers: chain.status(),
      db: { size_mb: Math.round((size / 1024 / 1024) * 100) / 100 },
    };
  };

  app.start = () => {
    scheduler.start();
    for (const w of workers) w.start();
    housekeeper.start();
    events.info('app', `Сервис запущен (версия ${app.version}${cfg.mock ? ', режим образцов MOCK' : ''})`);
  };

  app.stop = async () => {
    events.info('app', 'Остановка сервиса');
    housekeeper.stop();
    for (const w of workers) await w.stop();
    await scheduler.stop();
  };

  return app;
}
