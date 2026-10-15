// Speech to text for a video: the video's own captions (manual first, then automatic), in Russian or English.
const ANDROID = { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en', gl: 'US' };
const MAX_CHARS = 60_000;

/** Best track: manual before automatic, Russian before English, then anything. */
export function chooseTrack(tracks) {
  const score = (t) => (t.kind === 'asr' ? 0 : 10) + (t.languageCode?.startsWith('ru') ? 2 : t.languageCode?.startsWith('en') ? 1 : 0);
  return [...(tracks ?? [])].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** json3 caption events -> one clean text. */
export function captionsToText(json3) {
  const text = (json3?.events ?? []).flatMap((e) => (e.segs ?? []).map((s) => s.utf8 ?? '')).join(' ');
  return text.replace(/\[[^\]]{0,40}\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
}

/** Caption files sometimes come as XML even when json3 was asked for: strip tags and decode entities. */
export function xmlToText(xml) {
  const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
  return String(xml).replace(/<[^>]+>/g, ' ').replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (m) => entities[m]).replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
}

/** Returns { text, lang, kind } or null when the video has no usable captions. */
export async function fetchCaptions(videoId, { fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const res = await fetchImpl('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip', 'x-youtube-client-name': '3', 'x-youtube-client-version': '20.10.38' },
    body: JSON.stringify({ context: { client: ANDROID }, videoId, contentCheckOk: true, racyCheckOk: true }), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`YouTube player HTTP ${res.status}`);
  const json = await res.json();
  if (json?.playabilityStatus?.status && json.playabilityStatus.status !== 'OK') return null;
  const track = chooseTrack(json?.captions?.playerCaptionsTracklistRenderer?.captionTracks);
  if (!track?.baseUrl) return null;
  const cap = await fetchImpl(`${track.baseUrl}${track.baseUrl.includes('?') ? '&' : '?'}fmt=json3`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!cap.ok) throw new Error(`YouTube captions HTTP ${cap.status}`);
  const body = await cap.text();
  let text;
  try { text = captionsToText(JSON.parse(body)); } catch { text = xmlToText(body); }
  return text.length >= 200 ? { text, lang: track.languageCode, kind: track.kind === 'asr' ? 'asr' : 'manual' } : null;
}

/** Offline stand-in for MOCK mode and demos. */
export function mockCaptions() {
  return async () => ({
    text: 'Okay so welcome back everyone, today we continue playing and honestly the combat feels great, every fight is tense and the boss design is really creative. '
      + 'The world looks beautiful and exploring it is rewarding, although the menus are a bit clunky and the map could be clearer. '
      + 'I ran into a few performance dips in big fights, but nothing game breaking. Overall I would say it is a very solid game that is worth your time if you like this genre. '.repeat(2),
    lang: 'en', kind: 'asr',
  });
}
