// Dev tool: run one collection batch into ./data/dev.db.  MOCK=1 uses fixtures; without it, live Metacritic.
// Usage: node --env-file=.env scripts/collect.js [count]
import { loadConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db.js';
import { loadSettings } from '../src/settings.js';
import { createClientFromConfig } from '../src/mc/client.js';
import { collectBatch } from '../src/collect.js';
import { dayOf } from '../src/selection.js';

const cfg = loadConfig();
const db = openDb(`${cfg.dataDir}/dev.db`);
migrate(db);
const settings = loadSettings(db);
const client = createClientFromConfig(cfg, () => settings);
const n = Number(process.argv[2] ?? settings.batch_size);

const { picked, results } = await collectBatch({
  db, client, settings, n, day: dayOf(new Date(), settings.tz),
  hooks: { onWarn: (m) => console.warn('!', m), onStart: (i) => console.log('->', i.slug, `(${i.source})`) },
});
console.log(`picked ${picked.length}, ok ${results.filter((r) => r.ok).length}, failed ${results.filter((r) => !r.ok).length}`);
for (const r of results.filter((x) => !x.ok)) console.log('  FAIL', r.slug, r.error);
console.log('games in db:', db.prepare('SELECT COUNT(*) AS c FROM games').get().c);
