import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/mc/client.js';
import { createMockFetch, loadFixtures } from '../src/mc/mock.js';
import { McError } from '../src/mc/errors.js';
import { parseNewReleases, parseProduct, parseUserStats, parseReviews } from '../src/mc/parse.js';
import { defaults } from '../src/settings.js';

const settings = defaults();
const client = () => createClient({ apiKey: 'test', settings: () => settings, fetchImpl: createMockFetch(loadFixtures()), sleep: async () => {} });

test('New Releases block gives 20 unique slugs in page order', async () => {
  const slugs = await client().newReleases();
  assert.equal(slugs.length, 20);
  assert.equal(new Set(slugs).size, 20);
  assert.ok(slugs.every((s) => /^[a-z0-9][a-z0-9-]*$/.test(s)));
});

test('a multi-platform game is parsed completely (recorded Elden Ring)', async () => {
  const { game, platforms } = await client().product('elden-ring');
  assert.equal(game.title, 'Elden Ring');
  assert.equal(game.developer, 'From Software');
  assert.ok(game.publishers.includes('Bandai Namco Games'));
  assert.deepEqual(game.genres, ['Action RPG']);
  assert.equal(game.esrb, 'M');
  assert.match(game.coverUrl, /^https:\/\/www\.metacritic\.com\/a\/img\/catalog\/provider\//);
  assert.match(game.videoUrl, /^https:\/\/cdn\.jwplayer\.com\/players\//);
  assert.ok(game.description.length > 100);
  assert.equal(platforms.length, 5);
  assert.equal(platforms[0].isLead, true, 'lead platform comes first');
  const pc = platforms.find((p) => p.slug === 'pc');
  assert.ok(pc.criticScore >= 90 && pc.criticCount > 10);
  assert.ok(platforms.some((p) => p.criticScore === null), 'platforms without a score stay null');
});

test('player score, review pages and the feed come through the client', async () => {
  const c = client();
  const stats = await c.userStats('elden-ring', 'pc');
  assert.ok(stats.score > 0 && stats.score <= 10 && stats.count > 100);

  const critics = await c.criticReviews('elden-ring', 0);
  assert.equal(critics.items.length, 10);
  assert.ok(critics.total > 10);
  assert.ok(critics.items.every((r) => r.quote && r.score !== null));

  const users = await c.userReviews('elden-ring', 0, 100);
  assert.ok(users.items.length > 0);
  assert.ok(users.items.every((r) => r.who === 'player'), 'fixtures hold no real user names');

  assert.equal((await c.finderPage(0, 20)).length, 20);
  assert.deepEqual(await c.finderPage(40, 20), [], 'a page that does not exist is the end of the feed');
});

test('an unknown game is an http 404 error, not a crash', async () => {
  await assert.rejects(client().product('no-such-game'), (e) => e instanceof McError && e.kind === 'http' && e.status === 404);
  await assert.rejects(client().product('../etc/passwd'), (e) => e.kind === 'input');
});

test('"no score yet" players answer (score 0, 0 reviews) becomes null', () => {
  assert.deepEqual(parseUserStats({ data: { item: { score: 0, reviewCount: 0 } } }), { score: null, count: 0 });
  assert.deepEqual(parseUserStats({ data: { item: { score: 8.4, reviewCount: 120 } } }), { score: 8.4, count: 120 });
});

test('a brand-new game with nothing filled in still parses', () => {
  const json = { data: { item: { title: 'Fresh', slug: 'fresh', description: '', platform: 'PC', platforms: [{ name: 'PC', slug: 'pc', criticScoreSummary: { score: null, reviewCount: null } }], images: [], video: null } } };
  const { game, platforms } = parseProduct(json);
  assert.equal(game.description, null);
  assert.equal(game.coverUrl, null);
  assert.equal(game.videoUrl, null);
  assert.equal(game.developer, null);
  assert.deepEqual(platforms, [{ slug: 'pc', name: 'PC', isLead: true, releaseDate: null, criticScore: null, criticCount: null }]);
});

test('missing platforms fall back to the single platform field', () => {
  const { platforms } = parseProduct({ data: { item: { title: 'X', platform: 'PlayStation 5', criticScoreSummary: { score: 88, reviewCount: 12 } } } });
  assert.deepEqual(platforms.map((p) => [p.slug, p.criticScore, p.isLead]), [['playstation-5', 88, true]]);
});

test('unexpected shapes are schema errors', () => {
  assert.throws(() => parseProduct({ data: {} }), (e) => e.kind === 'schema');
  assert.throws(() => parseProduct(null), (e) => e.kind === 'schema');
  assert.throws(() => parseReviews({ data: {} }, 'users'), (e) => e.kind === 'schema');
  assert.deepEqual(parseNewReleases('<html>nothing here</html>'), []);
});

test('review text is normalised and spoilers are flagged', () => {
  const r = parseReviews({ data: { totalResults: 7, items: [{ quote: '  Great\n\n game  ', score: 9, author: 'a', spoiler: true }] } }, 'users');
  assert.equal(r.total, 7);
  assert.deepEqual(r.items[0], { id: null, quote: 'Great game', score: 9, date: null, who: 'a', spoiler: true });
});
