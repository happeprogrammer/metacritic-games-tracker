// Records live Metacritic answers into test/fixtures/mc.json for offline tests and MOCK=1.
// Usage: node scripts/record-fixtures.js   (about a minute: requests are spaced out politely)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createClient } from '../src/mc/client.js';
import { fetchGame } from '../src/pipeline.js';
import { defaults } from '../src/settings.js';
import { urlKey, FIXTURES_FILE } from '../src/mc/mock.js';
import { loadConfig } from '../src/config.js';

const settings = defaults();
const store = {};
const recordingFetch = async (url, init) => {
  const res = await fetch(url, init);
  const body = await res.text();
  store[urlKey(String(url))] = { status: res.status, body };
  return new Response(body, { status: res.status });
};
const client = createClient({ apiKey: loadConfig().mcApiKey, settings: () => settings, fetchImpl: recordingFetch });

const home = await client.newReleases();
await client.finderPage(0, 20);
await client.finderPage(20, 20);
const slugs = ['elden-ring', ...home.slice(0, 2)];
for (const slug of slugs) {
  console.log('recording', slug);
  await fetchGame(client, slug, settings);
}

// Trim: keep the New Releases block only, a handful of reviews per page, no real user names.
for (const [key, rec] of Object.entries(store)) {
  if (key === 'SITE:/game/') {
    const i = rec.body.indexOf('New Releases');
    const j = rec.body.indexOf('global-header-title', i + 300);
    rec.body = rec.body.slice(i, j + 40);
  } else if (key.includes('/reviews/metacritic/') && !key.includes('/stats/')) {
    const json = JSON.parse(rec.body);
    const isUser = key.includes('/user/');
    json.data.items = json.data.items.slice(0, isUser ? 12 : 10).map((r) => {
      delete r.reviewedProduct;
      if (isUser) r.author = 'player';
      return r;
    });
    rec.body = JSON.stringify(json);
  }
}
store._meta = { recordedAt: new Date().toISOString(), slugs };
mkdirSync(dirname(FIXTURES_FILE), { recursive: true });
writeFileSync(FIXTURES_FILE, JSON.stringify(store));
console.log(`saved ${Object.keys(store).length - 1} responses, ${(JSON.stringify(store).length / 1024).toFixed(0)} KB`);
