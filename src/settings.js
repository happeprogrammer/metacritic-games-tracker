// One registry drives defaults, validation and the admin form. Secrets never live here (env only).
import { tx } from './db.js';

const PROVIDER_IDS = ['groq', 'openrouter', 'gemini', 'github'];

const int = (key, def, min, max, desc) => ({ key, type: 'int', def, min, max, desc });
const bool = (key, def, desc) => ({ key, type: 'bool', def, desc });

export const REGISTRY = [
  bool('scheduler_enabled', true, 'Планировщик включён'),
  int('interval_min', 60, 5, 1440, 'Интервал между запусками, минут'),
  int('batch_size', 20, 1, 100, 'Сколько игр брать за один запуск'),
  int('fetch_concurrency', 1, 1, 3, 'Игр одновременно (общий лимит запросов действует всегда)'),
  int('request_delay_ms', 1000, 300, 10000, 'Пауза между запросами к Metacritic, мс'),
  int('request_timeout_ms', 20000, 5000, 60000, 'Таймаут запроса к Metacritic, мс'),
  int('retry_max', 3, 0, 6, 'Повторов при ошибке сети/источника'),
  int('retry_base_ms', 2000, 500, 60000, 'Базовая пауза перед повтором, мс'),
  { key: 'tz', type: 'tz', def: 'Europe/Moscow', desc: 'Часовой пояс «дня» (по нему сбрасывается выбор игр)' },
  int('max_finder_pages_per_day', 50, 1, 500, 'Максимум страниц ленты SEE ALL за день'),
  int('max_platforms_per_game', 8, 1, 12, 'Максимум платформ с запросом оценок игроков на игру'),
  int('critic_pages', 5, 1, 10, 'Страниц отзывов критиков (по 10) для выборки'),
  int('user_page_size', 100, 10, 100, 'Размер страницы отзывов игроков'),
  int('review_sample_critic', 40, 5, 100, 'Отзывов критиков в выборке для резюме'),
  int('review_sample_user', 40, 5, 100, 'Отзывов игроков в выборке для резюме'),
  int('min_reviews_for_summary', 3, 1, 50, 'Минимум отзывов, чтобы делать резюме'),
  int('resummarize_min_hours', 12, 0, 168, 'Не пересчитывать резюме чаще, часов'),
  int('resummarize_delta_pct', 5, 0, 100, 'Пересчёт, если число отзывов изменилось на, %'),
  int('resummarize_max_age_days', 7, 1, 60, 'Пересчёт, если резюме старше, дней'),
  bool('ai_enabled', true, 'ИИ включён (выключен: данные собираются, резюме ждут)'),
  {
    key: 'ai_providers',
    type: 'providers',
    desc: 'Порядок и лимиты провайдеров ИИ (без ключа в env или в состоянии denied провайдер пропускается)',
    def: [
      { id: 'groq', enabled: true, model: 'llama-3.3-70b-versatile', daily_cap: 300 },
      {
        id: 'openrouter',
        enabled: true,
        model: 'dots-studio/dots-3-note-preview:free,nvidia/nemotron-3.5-super-vl:free,google/gemma-4-26b-a4b-it:free,google/gemma-4-31b-it:free,nvidia/nemotron-3-super-120b-a12b:free',
        daily_cap: 30,
      },
      { id: 'gemini', enabled: true, model: 'gemini-flash-latest', daily_cap: 200 },
      { id: 'github', enabled: true, model: 'openai/gpt-4.1-mini', daily_cap: 100 },
    ],
  },
  int('ai_timeout_ms', 240000, 5000, 600000, 'Таймаут вызова ИИ, мс (бесплатные модели с рассуждением отвечают 1-3 минуты)'),
  int('ai_job_max_attempts', 4, 1, 10, 'Попыток задачи ИИ до статуса failed'),
  int('ai_breaker_cooldown_min', 15, 1, 1440, 'Пауза провайдера после 429/серии ошибок, минут'),
  bool('letsplay_enabled', true, 'Искать летсплеи'),
  int('letsplay_daily_cap', 30, 0, 500, 'Летсплеев в сутки'),
  int('letsplay_clip_seconds', 600, 60, 3600, 'Сколько секунд ролика разбирать через Gemini'),
  { key: 'youtube_mode', type: 'enum', values: ['keyless', 'api'], def: 'keyless', desc: 'Поиск на YouTube: без ключа или через API' },
  bool('public_run_enabled', true, 'Публичная кнопка «Запустить сейчас»'),
  int('public_run_cooldown_s', 60, 10, 3600, 'Пауза между ручными запусками, секунд'),
  int('public_run_daily_cap', 12, 0, 200, 'Ручных запусков в сутки'),
  int('events_max_rows', 5000, 500, 100000, 'Сколько событий хранить'),
  int('log_retention_days', 14, 1, 365, 'Сколько дней хранить журнал вызовов ИИ'),
  int('backup_keep', 7, 1, 30, 'Сколько бэкапов базы хранить'),
  { key: 'notify_webhook_url', type: 'url', def: '', desc: 'Адрес для уведомлений о сбоях (пусто: выключено)' },
  { key: 'user_agent', type: 'string', max: 200, def: 'Mozilla/5.0 (compatible; GamesTrackerDemo/1.0)', desc: 'User-Agent запросов к Metacritic' },
];

const BY_KEY = new Map(REGISTRY.map((d) => [d.key, d]));

/** Validate and normalise one value against its definition; throws Error with a readable message. */
export function coerce(def, v) {
  const fail = (m) => { throw new Error(`${def.key}: ${m}`); };
  switch (def.type) {
    case 'bool':
      if (typeof v !== 'boolean') fail('нужно true или false');
      return v;
    case 'int':
      if (!Number.isInteger(v)) fail('нужно целое число');
      if (v < def.min || v > def.max) fail(`допустимо ${def.min}..${def.max}`);
      return v;
    case 'string':
      if (typeof v !== 'string') fail('нужна строка');
      if (v.length > def.max) fail(`не длиннее ${def.max} символов`);
      return v;
    case 'enum':
      if (!def.values.includes(v)) fail(`допустимо: ${def.values.join(', ')}`);
      return v;
    case 'tz':
      try { new Intl.DateTimeFormat('en-CA', { timeZone: v }); } catch { fail('неизвестный часовой пояс'); }
      return v;
    case 'url':
      if (typeof v !== 'string') fail('нужна строка');
      if (v === '') return v;
      try { if (!/^https?:$/.test(new URL(v).protocol)) throw 0; } catch { fail('нужен адрес http(s)'); }
      return v;
    case 'providers': {
      if (!Array.isArray(v) || v.length === 0) fail('нужен непустой список');
      const seen = new Set();
      return v.map((p) => {
        if (!p || !PROVIDER_IDS.includes(p.id)) fail(`id из: ${PROVIDER_IDS.join(', ')}`);
        if (seen.has(p.id)) fail(`провайдер ${p.id} повторяется`);
        seen.add(p.id);
        if (typeof p.enabled !== 'boolean') fail(`${p.id}.enabled: true или false`);
        if (typeof p.model !== 'string' || !p.model.trim() || p.model.length > 400) fail(`${p.id}.model: нужна строка`);
        if (!Number.isInteger(p.daily_cap) || p.daily_cap < 0 || p.daily_cap > 10000) fail(`${p.id}.daily_cap: 0..10000`);
        const models = p.model.split(',').map((m) => m.trim()).filter(Boolean);
        if (p.id === 'openrouter' && !models.every((m) => m.endsWith(':free'))) fail('для OpenRouter разрешены только модели с суффиксом :free');
        return { id: p.id, enabled: p.enabled, model: models.join(','), daily_cap: p.daily_cap };
      });
    }
    default:
      throw new Error(`unknown type ${def.type}`);
  }
}

export const defaults = () => Object.fromEntries(REGISTRY.map((d) => [d.key, structuredClone(d.def)]));

/** Defaults overlaid with stored values; a corrupt stored value falls back to its default. */
export function loadSettings(db) {
  const out = defaults();
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    const def = BY_KEY.get(row.key);
    if (!def) continue;
    try { out[row.key] = coerce(def, JSON.parse(row.value)); } catch { /* keep default */ }
  }
  return out;
}

/** Validate the whole patch first, then write all keys and audit entries in one transaction. */
export function setSettings(db, patch, { actor = 'system', ip = null, now = () => new Date() } = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    const def = BY_KEY.get(key);
    if (!def) throw new Error(`${key}: неизвестная настройка`);
    clean[key] = coerce(def, value);
  }
  const before = loadSettings(db);
  const at = now().toISOString();
  tx(db, () => {
    const upsert = db.prepare('INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
    const audit = db.prepare('INSERT INTO audit_log(at, actor, ip, action, detail) VALUES (?, ?, ?, ?, ?)');
    for (const [key, value] of Object.entries(clean)) {
      upsert.run(key, JSON.stringify(value), at);
      audit.run(at, actor, ip, 'settings.set', JSON.stringify({ key, from: before[key], to: value }));
    }
  });
  return loadSettings(db);
}
