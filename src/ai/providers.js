// Provider adapters: complete({model, system, user, timeoutMs, maxTokens}) -> {text, usage}. Errors are AiError.
import { AiError } from './errors.js';
import { ASPECTS } from './prompts.js';

async function post(url, headers, body, timeoutMs, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new AiError(e?.name === 'TimeoutError' ? 'timeout' : 'network', e?.message ?? String(e));
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw mapError(res.status, json?.error?.message ?? text.slice(0, 200), Number(res.headers?.get?.('retry-after')) || 0);
  if (json?.error) throw mapError(Number(json.error.code) || 0, json.error.message ?? 'ошибка провайдера', 0); // some gateways answer 200 with an error body
  return json;
}

function mapError(status, message, retryAfter) {
  const opts = { status, retryAfter };
  if (status === 429) return new AiError('rate_limit', message, opts);
  if (status === 401 || status === 402 || status === 403) return new AiError('denied', message, opts);
  if (status >= 500) return new AiError('server', message, opts);
  return new AiError('bad_request', message, opts);
}

export function gemini({ key, fetchImpl = globalThis.fetch }) {
  return {
    id: 'gemini',
    async complete({ model, system, user, timeoutMs, maxTokens = 2048 }) {
      const json = await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { 'x-goog-api-key': key }, // header, not URL: keys in URLs end up in logs
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: maxTokens },
        },
        timeoutMs, fetchImpl,
      );
      const text = (json?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (!text) throw new AiError('empty', json?.promptFeedback?.blockReason ? `заблокировано: ${json.promptFeedback.blockReason}` : 'пустой ответ');
      return { text, usage: { in: json.usageMetadata?.promptTokenCount ?? null, out: json.usageMetadata?.candidatesTokenCount ?? null } };
    },
  };
}

function openAiCompatible({ id, base, key, jsonMode, extraHeaders = {}, extraBody = {}, defaultMaxTokens = 2048, fetchImpl = globalThis.fetch }) {
  return {
    id,
    async complete({ model, system, user, timeoutMs, maxTokens = defaultMaxTokens }) {
      const body = { model, temperature: 0.2, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], ...extraBody };
      if (jsonMode) body.response_format = { type: 'json_object' };
      const send = () => post(`${base}/chat/completions`, { authorization: `Bearer ${key}`, ...extraHeaders }, body, timeoutMs, fetchImpl);
      let json;
      for (let attempt = 0; ; attempt++) {
        try {
          json = await send();
          break;
        } catch (e) {
          if (e.kind !== 'bad_request' || attempt >= 2) throw e;
          if (body.response_format && /response_format|json/i.test(e.message)) delete body.response_format; // JSON is extracted from plain text anyway
          else if (body.reasoning && /reason/i.test(e.message)) { delete body.reasoning; body.max_tokens = Math.max(body.max_tokens, 32000); } // thinking is mandatory: leave room for it
          else throw e;
        }
      }
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new AiError('empty', 'пустой ответ');
      return { text, usage: { in: json.usage?.prompt_tokens ?? null, out: json.usage?.completion_tokens ?? null } };
    },
  };
}

export const groq = (o) => openAiCompatible({ id: 'groq', base: 'https://api.groq.com/openai/v1', jsonMode: true, ...o });
export const github = (o) => openAiCompatible({ id: 'github', base: 'https://models.github.ai/inference', jsonMode: true, ...o });
// Free OpenRouter models are reasoning models that can burn the whole token budget on thinking (verified: 8000 tokens of
// thinking, empty answer). Thinking is switched off; if a model insists on it, the adapter retries with a big budget.
export const openrouter = (o) => openAiCompatible({
  id: 'openrouter', base: 'https://openrouter.ai/api/v1', jsonMode: true, defaultMaxTokens: 4000,
  extraHeaders: { 'x-title': 'games-tracker-demo' }, extraBody: { reasoning: { enabled: false } }, ...o,
});

/** Adapters for providers that have a key (or all of them, backed by a deterministic stub, in MOCK mode). */
export function createAdapters(keys, { mock = false, fetchImpl } = {}) {
  if (mock) return Object.fromEntries(['groq', 'openrouter', 'gemini', 'github'].map((id) => [id, mockAdapter(id)]));
  const out = {};
  if (keys.groq) out.groq = groq({ key: keys.groq, fetchImpl });
  if (keys.openrouter) out.openrouter = openrouter({ key: keys.openrouter, fetchImpl });
  if (keys.gemini) out.gemini = gemini({ key: keys.gemini, fetchImpl });
  if (keys.github) out.github = github({ key: keys.github, fetchImpl });
  return out;
}

/** Deterministic stand-in: builds a valid answer whose evidence is quoted from the prompt's own reviews. */
export function mockAdapter(id) {
  return {
    id,
    async complete({ user, maxTokens }) {
      if (/<transcript>/.test(user)) {
        const out = { summary: 'Блогер в целом доволен игрой: хвалит боевую систему и красоту мира, но отмечает неудобные меню и редкие просадки производительности.', pros: ['Сильная боевая система', 'Красивый мир, интересно исследовать'], cons: ['Неудобные меню и карта', 'Просадки в больших сражениях'], verdict: 'Крепкая игра, которую стоит попробовать любителям жанра.' };
        return { text: JSON.stringify(out), usage: { in: 300, out: 120 } };
      }
      if (!/<(critics|users)/.test(user)) return { text: '{"ok":true}', usage: { in: 10, out: 5 } };
      const out = {};
      for (const kind of ['critics', 'users']) {
        const block = user.match(new RegExp(`<${kind}[^>]*>\\n([\\s\\S]*?)\\n</${kind}>`));
        if (!block) continue;
        const rows = [...block[1].matchAll(/^\[[^|]*\|([^|]*)\|[^\]]*\] (.+)$/gm)].map((m) => ({ score: Number(m[1]), text: m[2] }));
        const [hi, lo] = kind === 'critics' ? [75, 50] : [8, 5];
        const point = (r, verb) => ({ text: `${verb}: ${r.text.slice(0, 60)}`.slice(0, 140), evidence: r.text.slice(0, 90) });
        const likes = rows.filter((r) => r.score >= hi).slice(0, 3).map((r) => point(r, 'Хвалят'));
        const dislikes = rows.filter((r) => r.score < lo).slice(0, 3).map((r) => point(r, 'Ругают'));
        const aspects = Object.fromEntries(ASPECTS.map((a, i) => [a, likes.length && i % 3 === 0 ? 'praise' : dislikes.length && i % 3 === 1 ? 'criticism' : i % 3 === 2 ? 'mixed' : 'none']));
        out[kind] = { likes, dislikes, aspects };
      }
      return { text: JSON.stringify(out), usage: { in: Math.ceil(user.length / 3.5), out: Math.ceil(JSON.stringify(out).length / 3.5) }, maxTokens };
    },
  };
}
