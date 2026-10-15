// Offline stand-in for fetch: answers from recorded fixtures (see scripts/record-fixtures.js).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'mc.json');

/** Stable key for a request: path plus sorted query without the API key; site pages get a SITE: prefix. */
export function urlKey(url) {
  const u = new URL(url);
  if (u.hostname === 'www.metacritic.com') return `SITE:${u.pathname}`;
  const params = [...u.searchParams].filter(([k]) => k !== 'apiKey').sort(([a], [b]) => a.localeCompare(b));
  return `${u.pathname}?${params.map(([k, v]) => `${k}=${v}`).join('&')}`;
}

export const loadFixtures = (file = FIXTURES_FILE) => JSON.parse(readFileSync(file, 'utf8'));

export function createMockFetch(table) {
  return async (url) => {
    const hit = table[urlKey(String(url))];
    if (!hit) return new Response(JSON.stringify({ error: 'not in fixtures' }), { status: 404 });
    return new Response(hit.body, { status: hit.status ?? 200 });
  };
}
