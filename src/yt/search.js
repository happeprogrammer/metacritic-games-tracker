// Finding the most popular let's play of a game on YouTube: keyless (the site's own search endpoint) or via the Data API.
const WEB = { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'US' };
const SORT_BY_VIEWS_VIDEOS = 'CAMSAhAB';
const UNWANTED = /\b(trailer|teaser|review|обзор|ost|soundtrack|cutscenes?|speedrun|reaction|announcement)\b/i;
const MIN_SECONDS = 600;
// A let's play title says so; this keeps out other videos that merely mention the name (e.g. 'Hades' in a Minecraft video).
const PLAYTHROUGH = /(let'?s play|lets play|walkthrough|playthrough|gameplay|прохождение|летсплей|part\s*\d+|episode\s*\d+|ep\.?\s*\d+|#\s*\d+|серия|часть)/i;

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** "1:02:03" -> seconds; null for live/upcoming (no length). */
export function parseClock(text) {
  if (!text) return null;
  const parts = String(text).split(':').map(Number);
  return parts.some(Number.isNaN) ? null : parts.reduce((a, p) => a * 60 + p, 0);
}

/** "PT1H2M3S" -> seconds. */
export function parseIso8601(d) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d ?? '');
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : null;
}

export function parseInnertubeSearch(json) {
  const out = [];
  const sections = json?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? [];
  for (const s of sections) {
    for (const it of s.itemSectionRenderer?.contents ?? []) {
      const v = it.videoRenderer;
      if (!v?.videoId) continue;
      out.push({
        videoId: v.videoId,
        title: v.title?.runs?.map((r) => r.text).join('') ?? '',
        channel: v.ownerText?.runs?.[0]?.text ?? null,
        views: Number(String(v.viewCountText?.simpleText ?? '').replace(/[^\d]/g, '')) || 0,
        durationS: parseClock(v.lengthText?.simpleText),
      });
    }
  }
  return out;
}

/** Keep real let's plays: the game named in the title, long enough, not live, not a trailer/review/etc.; most viewed first. */
export function rankCandidates(candidates, gameTitle) {
  const name = norm(gameTitle);
  const seen = new Set();
  return candidates
    .filter((c) => {
      if (seen.has(c.videoId)) return false;
      seen.add(c.videoId);
      return c.durationS !== null && c.durationS >= MIN_SECONDS && norm(c.title).includes(name) && PLAYTHROUGH.test(c.title) && !UNWANTED.test(c.title);
    })
    .sort((a, b) => b.views - a.views);
}

export function createYouTube({ fetchImpl = globalThis.fetch, settings, apiKey = '', timeoutMs = 20_000 }) {
  async function keyless(query) {
    const res = await fetchImpl('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
      method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': 'en-US,en;q=0.9' },
      body: JSON.stringify({ context: { client: WEB }, query, params: SORT_BY_VIEWS_VIDEOS }), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`YouTube search HTTP ${res.status}`);
    return parseInnertubeSearch(await res.json());
  }

  async function viaApi(query) {
    const q = new URLSearchParams({ part: 'snippet', type: 'video', order: 'viewCount', maxResults: '15', q: query, key: apiKey });
    const s = await fetchImpl(`https://www.googleapis.com/youtube/v3/search?${q}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!s.ok) throw new Error(`YouTube API HTTP ${s.status}`);
    const items = (await s.json()).items ?? [];
    if (!items.length) return [];
    const v = new URLSearchParams({ part: 'contentDetails,statistics', id: items.map((i) => i.id.videoId).join(','), key: apiKey });
    const d = await fetchImpl(`https://www.googleapis.com/youtube/v3/videos?${v}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!d.ok) throw new Error(`YouTube API HTTP ${d.status}`);
    const details = Object.fromEntries(((await d.json()).items ?? []).map((i) => [i.id, i]));
    return items.map((i) => ({
      videoId: i.id.videoId, title: i.snippet.title, channel: i.snippet.channelTitle,
      views: Number(details[i.id.videoId]?.statistics?.viewCount ?? 0), durationS: parseIso8601(details[i.id.videoId]?.contentDetails?.duration),
    }));
  }

  /** Matching let's plays for a game, most viewed first (the caller walks down the list until one has speech to read). */
  async function findLetsplays(gameTitle) {
    const useApi = settings().youtube_mode === 'api' && apiKey;
    const all = [];
    for (const query of [`${gameTitle} let's play`, `${gameTitle} прохождение`]) {
      all.push(...(await (useApi ? viaApi(query) : keyless(query))));
    }
    return rankCandidates(all, gameTitle);
  }

  /** The most viewed matching let's play, or null. */
  const findLetsplay = async (gameTitle) => (await findLetsplays(gameTitle))[0] ?? null;

  return { findLetsplay, findLetsplays };
}

/** Offline stand-in for MOCK mode and demos. */
export function mockYouTube() {
  const video = (title) => ({ videoId: 'mock-video', title: `${title} let's play, part 1`, channel: 'Demo Channel', views: 123_456, durationS: 1800 });
  return { findLetsplay: async (title) => video(title), findLetsplays: async (title) => [video(title)] };
}
