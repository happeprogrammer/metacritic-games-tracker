// Dev tool: summarise one game from ./data/dev.db with the real providers (keys from the environment).
// Usage: node --env-file=.env scripts/summarize.js <slug>
import { loadConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db.js';
import { loadSettings } from '../src/settings.js';
import { createAdapters } from '../src/ai/providers.js';
import { createChain } from '../src/ai/chain.js';
import { summarizeGame } from '../src/ai/summarize.js';

const cfg = loadConfig();
const db = openDb(`${cfg.dataDir}/dev.db`);
migrate(db);
const settings = loadSettings(db);
const adapters = createAdapters(cfg.keys, { mock: cfg.mock });
console.log('providers with a key:', Object.keys(adapters).join(', ') || 'none');
const chain = createChain({ db, adapters, settings: () => settings });

const game = db.prepare('SELECT * FROM games WHERE slug = ?').get(process.argv[2]);
if (!game) { console.error('no such game in dev.db'); process.exit(1); }
const out = await summarizeGame({ db, chain, game: { ...game }, settings });
console.log('result:', JSON.stringify(out));
for (const r of db.prepare('SELECT kind, status, likes, dislikes, aspects, provider, model, dropped_points FROM summaries WHERE game_id = ?').all(game.id)) {
  console.log(`\n[${r.kind}] ${r.status} via ${r.provider}/${r.model}, dropped ${r.dropped_points}`);
  for (const p of JSON.parse(r.likes ?? '[]')) console.log('  +', p.text, '\n      «' + p.evidence.slice(0, 90) + '»');
  for (const p of JSON.parse(r.dislikes ?? '[]')) console.log('  -', p.text, '\n      «' + p.evidence.slice(0, 90) + '»');
  console.log('  aspects:', r.aspects);
}
console.log('\ncalls journal:', db.prepare('SELECT provider, model, ok, substr(error,1,80) AS error, latency_ms FROM ai_calls ORDER BY id DESC LIMIT 5').all().map((c) => JSON.stringify(c)).join('\n  '));
