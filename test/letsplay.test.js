import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClock, parseIso8601, parseInnertubeSearch, rankCandidates, createYouTube } from '../src/yt/search.js';
import { chooseTrack, captionsToText, xmlToText, fetchCaptions } from '../src/yt/captions.js';
import { processLetsplay, planLetsplay, validateConclusion } from '../src/yt/letsplay.js';
import { createLetsplay } from '../src/workers.js';
import { createChain } from '../src/ai/chain.js';
import { createEvents } from '../src/events.js';
import { mockAdapter } from '../src/ai/providers.js';
import { AiUnavailable } from '../src/ai/errors.js';
import * as jobs from '../src/jobs.js';
import { defaults } from '../src/settings.js';
import { freshDb, addGame } from './helpers.js';

const settings = defaults();
const res = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const video = (id, title, views, len) => ({ videoRenderer: { videoId: id, title: { runs: [{ text: title }] }, ownerText: { runs: [{ text: 'Chan' }] }, viewCountText: { simpleText: `${views.toLocaleString('en-US')} views` }, ...(len ? { lengthText: { simpleText: len } } : {}) } });
const search = (...videos) => ({ contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: videos } }] } } } } });

test('durations and the search page are parsed', () => {
  assert.equal(parseClock('1:02:03'), 3723);
  assert.equal(parseClock('12:34'), 754);
  assert.equal(parseClock(undefined), null);
  assert.equal(parseIso8601('PT1H2M3S'), 3723);
  assert.equal(parseIso8601('PT45S'), 45);
  const found = parseInnertubeSearch(search(video('a', 'Elden Ring let\'s play #1', 1_234_567, '45:10'), video('live', 'Elden Ring LIVE', 5, null), { channelRenderer: {} }));
  assert.deepEqual(found.map((v) => [v.videoId, v.views, v.durationS]), [['a', 1_234_567, 2710], ['live', 5, null]]);
});

test('only real let\'s plays of this game are kept, the most viewed first', () => {
  const c = (videoId, title, views, durationS) => ({ videoId, title, views, durationS, channel: 'x' });
  const ranked = rankCandidates([
    c('1', 'Elden Ring Full Walkthrough Part 1', 500, 3600),
    c('2', 'ELDEN RING - Let\'s Play Episode 1', 9000, 2400),
    c('3', 'Elden Ring Trailer', 99999, 120),
    c('4', 'Elden Ring Review: is it worth it', 80000, 1500),
    c('5', 'Elden Ring speedrun any%', 70000, 3000),
    c('6', 'Dark Souls let\'s play', 60000, 3000),
    c('7', 'Elden Ring let\'s play LIVE', 50000, null),
    c('8', 'Elden Ring short clip', 40000, 90),
    c('9', 'Playing as the Goddess ELDEN RING boss in Minecraft!', 90000, 1300),
    c('2', 'duplicate', 1, 3000),
  ], 'Elden Ring');
  assert.deepEqual(ranked.map((x) => x.videoId), ['2', '1']);
});

test('search: keyless mode asks the site endpoint sorted by views; API mode uses the Data API and durations', async () => {
  const urls = [];
  const keyless = createYouTube({ settings: () => settings, fetchImpl: async (url, init) => { urls.push([url, init.body]); return res(search(video('k1', 'Hades let\'s play', 1000, '30:00'))); } });
  assert.equal((await keyless.findLetsplay('Hades')).videoId, 'k1');
  assert.match(urls[0][0], /youtubei\/v1\/search/);
  assert.match(urls[0][1], /CAMSAhAB/);
  assert.equal(urls.length, 2, 'two queries: English and Russian');

  const api = createYouTube({ settings: () => ({ ...settings, youtube_mode: 'api' }), apiKey: 'K', fetchImpl: async (url) => {
    if (url.includes('/search?')) return res({ items: [{ id: { videoId: 'a1' }, snippet: { title: 'Hades let\'s play', channelTitle: 'C' } }] });
    return res({ items: [{ id: 'a1', contentDetails: { duration: 'PT25M' }, statistics: { viewCount: '777' } }] });
  } });
  const best = await api.findLetsplay('Hades');
  assert.deepEqual([best.videoId, best.views, best.durationS], ['a1', 777, 1500]);
  await assert.rejects(createYouTube({ settings: () => settings, fetchImpl: async () => res('no', 429) }).findLetsplay('X'), /HTTP 429/);
});

test('captions: manual beats automatic, Russian beats English, text is cleaned', async () => {
  const tracks = [{ languageCode: 'en', kind: 'asr', baseUrl: 'u1' }, { languageCode: 'en', baseUrl: 'u2' }, { languageCode: 'ru', kind: 'asr', baseUrl: 'u3' }];
  assert.equal(chooseTrack(tracks).baseUrl, 'u2', 'manual English beats automatic Russian');
  assert.equal(chooseTrack([tracks[0], tracks[2]]).baseUrl, 'u3');
  assert.equal(chooseTrack([]), null);
  assert.equal(captionsToText({ events: [{ segs: [{ utf8: 'Hello' }, { utf8: ' world [Music]' }] }, { segs: [{ utf8: 'again' }] }] }), 'Hello world again');

  const long = 'word '.repeat(80);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/player')) return res({ playabilityStatus: { status: 'OK' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', baseUrl: 'https://yt.test/api/timedtext?v=1' }] } } });
    return res({ events: [{ segs: [{ utf8: long }] }] });
  };
  const got = await fetchCaptions('vid', { fetchImpl });
  assert.deepEqual([got.lang, got.kind], ['en', 'manual']);
  assert.match(calls[1], /&fmt=json3$/);
  assert.equal(await fetchCaptions('v', { fetchImpl: async () => res({ playabilityStatus: { status: 'LOGIN_REQUIRED' } }) }), null);
  assert.equal(await fetchCaptions('v', { fetchImpl: async () => res({ playabilityStatus: { status: 'OK' } }) }), null, 'no caption tracks');
});

test('captions that arrive as XML are still turned into text', async () => {
  assert.equal(xmlToText('<transcript><text start="0">Tom &amp; Jerry &#39;s</text><text>second</text></transcript>'), "Tom & Jerry 's second");
  const body = '<timedtext>' + '<p>' + 'plain words '.repeat(40) + '</p></timedtext>';
  const got = await fetchCaptions('v', { fetchImpl: async (url) => (url.includes('/player') ? res({ playabilityStatus: { status: 'OK' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', baseUrl: 'https://yt.test/t?v=1' }] } } }) : res(body)) });
  assert.ok(got && got.text.startsWith('plain words'));
});

test('conclusion JSON is validated and trimmed', () => {
  const v = validateConclusion('```json\n{"summary":" Хорошо ","pros":["a","b","c","d","e"],"cons":"nope","verdict":"ok"}\n```');
  assert.equal(v.summary, 'Хорошо');
  assert.equal(v.pros.length, 4);
  assert.deepEqual(v.cons, []);
  assert.throws(() => validateConclusion('{"pros":[]}'), /summary/);
});

// ---------- processing ----------
function setup({ yt, captions, overrides = {} } = {}) {
  const db = freshDb();
  addGame(db, 'hades');
  const game = { ...db.prepare("SELECT * FROM games WHERE slug = 'hades'").get(), title: 'Hades' };
  db.prepare("UPDATE games SET title = 'Hades', release_date = '2020-09-17' WHERE id = ?").run(game.id);
  db.prepare("INSERT INTO game_platforms(game_id, platform_slug, platform_name, critic_count, updated_at) VALUES (?, 'pc', 'PC', 50, 'x')").run(game.id);
  let t = new Date('2026-10-15T10:00:00Z');
  const now = () => new Date(t);
  const chain = createChain({ db, adapters: { groq: mockAdapter('groq') }, settings: () => ({ ...settings, ai_providers: [{ id: 'groq', enabled: true, model: 'g', daily_cap: 99 }] }), now, sleep: async () => {} });
  const found = { videoId: 'v1', title: 'Hades let\'s play', channel: 'Chan', views: 5000, durationS: 1800 };
  const deps = { db, chain, game, now, settings: { ...settings, ...overrides },
    yt: yt ?? { findLetsplay: async () => found }, captions: captions ?? (async () => ({ text: 'transcript '.repeat(60), lang: 'en', kind: 'asr' })) };
  return { db, game, deps, advance: (ms) => { t = new Date(t.getTime() + ms); }, now };
}

test('a found let\'s play with captions becomes a Russian conclusion with the link', async () => {
  const s = setup();
  const out = await processLetsplay(s.deps);
  assert.match(out.note, /Chan/);
  const row = s.db.prepare('SELECT * FROM letsplay').get();
  assert.deepEqual([row.status, row.video_url, row.channel, row.views, row.transcript_source, row.provider], ['ok', 'https://www.youtube.com/watch?v=v1', 'Chan', 5000, 'captions', 'groq']);
  const c = JSON.parse(row.conclusion);
  assert.ok(c.summary && c.pros.length && c.verdict);
  assert.ok(row.transcript.length > 100);
  assert.equal((await processLetsplay(s.deps)).note, 'уже есть', 'done games are not redone');
});

test('nothing found: retried after 1, 3, 7 days, then given up', async () => {
  const s = setup({ yt: { findLetsplay: async () => null } });
  const day = 86_400_000;
  const r1 = await processLetsplay(s.deps);
  assert.equal(r1.retryAfterMs, day);
  assert.equal(s.db.prepare('SELECT status, attempts FROM letsplay').get().status, 'not_found');
  assert.equal((await processLetsplay(s.deps)).retryAfterMs, 3 * day);
  assert.equal((await processLetsplay(s.deps)).retryAfterMs, 7 * day);
  const last = await processLetsplay(s.deps);
  assert.equal(last.retryAfterMs, undefined);
  assert.match(last.note, /больше не ищем/);
  const row = s.db.prepare('SELECT attempts, next_retry_at FROM letsplay').get();
  assert.deepEqual([row.attempts, row.next_retry_at], [4, null]);
});

test('a video without captions is recorded with its link and retried later', async () => {
  const s = setup({ captions: async () => null });
  const out = await processLetsplay(s.deps);
  assert.ok(out.retryAfterMs);
  const row = s.db.prepare('SELECT status, video_url FROM letsplay').get();
  assert.deepEqual({ ...row }, { status: 'no_transcript', video_url: 'https://www.youtube.com/watch?v=v1' });
});

test('the daily cap postpones to the next day; AI outage propagates for the queue to defer', async () => {
  const s = setup({ overrides: { letsplay_daily_cap: 1 } });
  await processLetsplay(s.deps);
  const s2 = setup({ overrides: { letsplay_daily_cap: 0 } });
  const capped = await processLetsplay(s2.deps);
  assert.match(capped.note, /лимит/);
  assert.ok(capped.retryAfterMs >= 60_000 && capped.retryAfterMs <= 25 * 3600_000);
  const down = setup();
  down.deps.chain = { complete: async () => { throw new AiUnavailable('no_provider', 120_000); } };
  await assert.rejects(processLetsplay(down.deps), AiUnavailable);
});

test('planLetsplay queues only released, rated games without a finished let\'s play', () => {
  const s = setup();
  assert.equal(planLetsplay(s.db, s.game.id, settings, s.now), 'queued');
  assert.equal(planLetsplay(s.db, s.game.id, { ...settings, letsplay_enabled: false }, s.now), 'off');
  s.db.prepare("UPDATE games SET release_date = '2099-01-01'").run();
  assert.equal(planLetsplay(s.db, s.game.id, settings, s.now), 'unreleased');
  s.db.prepare("UPDATE games SET release_date = '2020-01-01'").run();
  s.db.prepare('UPDATE game_platforms SET critic_count = 0, user_count = 0').run();
  assert.equal(planLetsplay(s.db, s.game.id, settings, s.now), 'no_reviews');
  s.db.prepare('UPDATE game_platforms SET critic_count = 5').run();
  s.db.prepare("INSERT INTO letsplay(game_id, status, attempts, next_retry_at) VALUES (?, 'not_found', 1, '2999-01-01')").run(s.game.id);
  assert.equal(planLetsplay(s.db, s.game.id, settings, s.now), 'later', 'retry time has not come yet');
});

test('the worker completes, defers on retryAfterMs and on AI outage', async () => {
  const s = setup();
  planLetsplay(s.db, s.game.id, settings, s.now);
  const events = createEvents({ db: s.db });
  const mk = (deps) => createLetsplay({ db: s.db, chain: deps.chain, yt: deps.yt, captions: deps.captions, events, settings: () => settings, now: s.now, sleep: async () => {} });
  assert.equal(await mk(s.deps).runOnce(), 'done');
  assert.equal(jobs.stats(s.db).done, 1);

  const none = setup({ yt: { findLetsplay: async () => null } });
  planLetsplay(none.db, none.game.id, settings, none.now);
  const w = createLetsplay({ db: none.db, chain: none.deps.chain, yt: none.deps.yt, captions: none.deps.captions, events: createEvents({ db: none.db }), settings: () => settings, now: none.now, sleep: async () => {} });
  assert.equal(await w.runOnce(), 'deferred');
  const j = none.db.prepare('SELECT status, attempts FROM jobs').get();
  assert.deepEqual({ ...j }, { status: 'pending', attempts: 0 });
  assert.equal(await w.runOnce(), 'idle', 'not due until tomorrow');
});
