import { $, h, api, mountShell, fmtDate, toast } from './common.js';

await mountShell('admin');
const view = $('#view');

const act = async (fn, okText) => { try { const r = await fn(); toast(okText ?? 'Готово'); return r; } catch (e) { toast(e.message, 'error'); return null; } };
const field = (label, input) => h('label', { class: 'field' }, label, input);
const btn = (text, onclick, cls = '') => h('button', { class: `btn btn-sm ${cls}`, onclick }, text);
const confirmed = (text, fn) => () => { if (confirm(text)) fn(); };

// ---------------- control ----------------
async function tabControl() {
  const m = await api('/monitor');
  const source = h('select', { class: 'select' }, ['auto', 'new_releases', 'finder'].map((v) => h('option', { value: v }, { auto: 'как обычно', new_releases: 'только New Releases', finder: 'только лента «новые»' }[v])));
  const limit = h('input', { class: 'input', type: 'number', min: 1, max: 100, placeholder: 'по умолчанию' });
  const offset = h('input', { class: 'input', type: 'number', min: 0, placeholder: 'с текущей позиции' });
  const dry = h('input', { type: 'checkbox' });
  const result = h('pre', { class: 'small muted' });
  const curSrc = h('select', { class: 'select' }, ['all', 'new_releases', 'finder'].map((v) => h('option', { value: v }, { all: 'всё за сегодня', new_releases: 'New Releases', finder: 'лента' }[v])));
  const curOff = h('input', { class: 'input', type: 'number', min: 0, placeholder: 'позиция ленты (необязательно)' });
  view.replaceChildren(
    h('div', { class: 'dash' },
      h('div', { class: 'panel' }, h('h2', {}, 'Планировщик'),
        h('p', {}, m.scheduler.paused ? h('span', { class: 'chip warn' }, 'на паузе') : h('span', { class: 'chip good' }, m.scheduler.state === 'running' ? 'идёт сбор' : 'работает')),
        h('div', { class: 'row' },
          btn('Пауза', () => act(() => api('/scheduler/pause', { method: 'POST' }).then(tabControl), 'Поставлено на паузу')),
          btn('Продолжить', () => act(() => api('/scheduler/resume', { method: 'POST' }).then(tabControl), 'Продолжаем')),
          btn('Отменить текущий прогон', () => act(() => api('/runs/current/cancel', { method: 'POST' }), 'Отмена запрошена'), 'btn-danger'))),
      h('div', { class: 'panel' }, h('h2', {}, 'Запуск вручную'),
        h('div', { class: 'form-grid one' }, field('Источник', source), field('Сколько игр', limit), field('Лента с позиции', offset), h('label', { class: 'check' }, dry, 'Пробный запуск (ничего не записывать, только показать)')),
        h('div', { class: 'mb' }),
        btn('Запустить', async () => {
          const body = { source: source.value, dryRun: dry.checked };
          if (limit.value) body.limit = Number(limit.value);
          if (offset.value) body.offset = Number(offset.value);
          const r = await act(() => api('/runs', { method: 'POST', body }), 'Запущено');
          if (r?.runId && dry.checked) { setTimeout(async () => { const run = await api(`/runs/${r.runId}`); result.textContent = run.note ?? run.status; }, 1500); }
        }, 'btn-primary'), result),
      h('div', { class: 'panel' }, h('h2', {}, 'Курсор дня'), h('p', { class: 'muted small' }, 'Сброс заставит сегодняшний выбор игр начаться заново (обработанные сегодня игры останутся обработанными).'),
        h('div', { class: 'form-grid one' }, field('Что сбросить', curSrc), field('Лента с позиции', curOff)), h('div', { class: 'mb' }),
        btn('Сбросить', confirmed('Сбросить выбор игр на сегодня?', () => act(() => api('/cursor/reset', { method: 'POST', body: { source: curSrc.value, offset: curOff.value ? Number(curOff.value) : null } }), 'Сброшено')))),
      h('div', { class: 'panel' }, h('h2', {}, 'Источник и резюме'),
        h('div', { class: 'row' },
          btn('Проверить источник', async () => { const r = await act(() => api('/source/check', { method: 'POST' })); if (r) toast(`${r.status}: ${r.detail} (${r.ms} мс)`, r.status === 'green' ? 'ok' : 'error'); }),
          btn('Пересчитать все резюме', confirmed('Поставить пересчёт резюме для всех игр? Это потратит лимиты ИИ.', () => act(() => api('/summaries/recompute', { method: 'POST' }), 'Поставлено в очередь')))))));
}

// ---------------- settings ----------------
async function tabSettings() {
  const { registry, values } = await api('/settings');
  const inputs = new Map();
  const mk = (d) => {
    const v = values[d.key];
    let el;
    if (d.type === 'bool') el = h('select', { class: 'select' }, [['true', 'включено'], ['false', 'выключено']].map(([x, t]) => h('option', { value: x, selected: String(v) === x }, t)));
    else if (d.type === 'enum') el = h('select', { class: 'select' }, d.values.map((x) => h('option', { value: x, selected: x === v }, x)));
    else if (d.type === 'int') el = h('input', { class: 'input', type: 'number', min: d.min, max: d.max, value: v });
    else if (d.type === 'providers') el = h('textarea', { class: 'input', rows: 8, spellcheck: 'false' }, JSON.stringify(v, null, 2));
    else el = h('input', { class: 'input', value: v });
    inputs.set(d.key, { el, def: d });
    return h('label', { class: 'field', style: null }, h('span', {}, d.key), el, h('span', { class: 'small muted' }, d.desc + (d.min !== undefined ? ` (${d.min}…${d.max})` : '')));
  };
  const read = ({ el, def }) => def.type === 'bool' ? el.value === 'true' : def.type === 'int' ? Number(el.value) : def.type === 'providers' ? JSON.parse(el.value) : el.value;
  view.replaceChildren(h('div', { class: 'panel' }, h('div', { class: 'form-grid' }, registry.map(mk)), h('div', { class: 'mb' }),
    h('div', { class: 'row' },
      btn('Сохранить изменения', async () => {
        try {
          const patch = {};
          for (const [key, i] of inputs) { const val = read(i); if (JSON.stringify(val) !== JSON.stringify(values[key])) patch[key] = val; }
          if (!Object.keys(patch).length) return toast('Изменений нет');
          await api('/settings', { method: 'PUT', body: patch });
          toast(`Сохранено: ${Object.keys(patch).join(', ')}`);
          tabSettings();
        } catch (e) { toast(e.message, 'error'); }
      }, 'btn-primary'),
      h('a', { class: 'btn btn-sm', href: '/api/v1/settings/export' }, 'Скачать настройки'),
      btn('Сбросить всё к умолчаниям', confirmed('Вернуть все настройки к значениям по умолчанию?', () => act(() => api('/settings/reset', { method: 'POST' }).then(tabSettings), 'Сброшено'))))));
}

// ---------------- providers ----------------
async function tabProviders() {
  const { providers } = await api('/providers');
  const names = { ok: 'готов', cooldown: 'охлаждение', budget: 'лимит дня', denied: 'доступ закрыт', no_key: 'нет ключа', off: 'выключен' };
  view.replaceChildren(h('div', { class: 'panel' }, h('h2', {}, 'Провайдеры нейросетей'), h('div', { class: 'scroll-x' }, h('table', { class: 't' },
    h('thead', {}, h('tr', {}, ['Провайдер', 'Состояние', 'Сегодня', 'Модели', 'Последняя ошибка', ''].map((c) => h('th', {}, c)))),
    h('tbody', {}, providers.map((p) => h('tr', {}, h('td', {}, p.id), h('td', {}, h('span', { class: `chip ${p.state === 'ok' ? 'good' : p.state === 'denied' ? 'bad' : 'warn'}` }, names[p.state] ?? p.state), p.breaker_until ? h('div', { class: 'small muted' }, `до ${fmtDate(p.breaker_until)}`) : null),
      h('td', {}, `${p.calls_today} / ${p.cap}`), h('td', { class: 'small' }, p.models.join(', ')), h('td', { class: 'small muted' }, p.last_error ?? '—'),
      h('td', {}, h('div', { class: 'row' },
        btn('Проверить ключ', async () => { const r = await act(() => api(`/providers/${p.id}/probe`, { method: 'POST' }), null); if (r) toast(r.ok ? `Работает: ${r.model}, ${r.ms} мс` : `Ошибка: ${r.error}`, r.ok ? 'ok' : 'error'); tabProviders(); }),
        btn(p.enabled ? 'Выключить' : 'Включить', () => act(() => api(`/providers/${p.id}`, { method: 'PATCH', body: { enabled: !p.enabled } }).then(tabProviders)))))))))),
    h('div', { class: 'mb' }), btn('Сбросить все охлаждения', () => act(() => api('/providers/reset', { method: 'POST' }).then(tabProviders), 'Охлаждения сброшены'))));
}

// ---------------- queue ----------------
async function tabQueue(status = '') {
  const { stats, jobs } = await api(`/jobs${status ? `?status=${status}` : ''}`);
  const filter = h('select', { class: 'select', onchange: (e) => tabQueue(e.target.value) }, [['', 'все'], ['pending', 'в очереди'], ['running', 'в работе'], ['failed', 'с ошибкой'], ['done', 'готовые'], ['skipped', 'пропущенные']].map(([v, t]) => h('option', { value: v, selected: v === status }, t)));
  view.replaceChildren(h('div', { class: 'panel' }, h('h2', {}, 'Очередь задач'),
    h('p', { class: 'muted' }, `В очереди ${stats.pending} · в работе ${stats.running} · с ошибкой ${stats.failed} · готово ${stats.done} · пропущено ${stats.skipped}`),
    h('div', { class: 'row' }, filter, btn('Повторить все с ошибкой', () => act(() => api('/jobs/retry-failed', { method: 'POST' }).then(() => tabQueue(status)), 'Поставлены заново'))),
    h('div', { class: 'mb' }),
    h('div', { class: 'scroll-x' }, h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['Игра', 'Тип', 'Статус', 'Попыток', 'Следующая', 'Ошибка', ''].map((c) => h('th', {}, c)))),
      h('tbody', {}, jobs.map((j) => h('tr', {}, h('td', {}, h('a', { href: `/game/${j.slug}` }, j.title)), h('td', {}, j.type), h('td', {}, j.status), h('td', {}, j.attempts), h('td', { class: 'small' }, fmtDate(j.next_at)), h('td', { class: 'small muted' }, j.error ?? ''),
        h('td', {}, h('div', { class: 'row' }, btn('Повторить', () => act(() => api(`/jobs/${j.id}/retry`, { method: 'POST' }).then(() => tabQueue(status)))), btn('Пропустить', () => act(() => api(`/jobs/${j.id}/skip`, { method: 'POST' }).then(() => tabQueue(status)))))))))))));
}

// ---------------- games ----------------
async function tabGames(q = '') {
  const { games } = await api(`/admin/games?q=${encodeURIComponent(q)}`);
  const search = h('input', { class: 'input', type: 'search', placeholder: 'название или slug', value: q });
  const add = h('input', { class: 'input', placeholder: 'ссылка на Metacritic или slug' });
  const flag = (g, k, on, off) => btn(g[k] ? on : off, () => act(() => api(`/games/${g.slug}`, { method: 'PATCH', body: { [k]: !g[k] } }).then(() => tabGames(q))));
  view.replaceChildren(h('div', { class: 'panel' }, h('h2', {}, 'Игры'),
    h('div', { class: 'toolbar' }, field('Поиск', search), btn('Найти', () => tabGames(search.value)), field('Добавить игру', add), btn('Добавить', () => act(() => api('/games', { method: 'POST', body: { url: add.value } }), 'Загрузка запущена'), 'btn-primary')),
    h('div', { class: 'scroll-x' }, h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['Игра', 'Обработана', 'Действия'].map((c) => h('th', {}, c)))),
      h('tbody', {}, games.map((g) => h('tr', {}, h('td', {}, h('a', { href: `/game/${g.slug}` }, g.title), h('div', { class: 'small muted' }, g.slug)), h('td', { class: 'small' }, g.processed_day ?? '—'),
        h('td', {}, h('div', { class: 'row' }, flag(g, 'hidden', 'Показать', 'Скрыть'), flag(g, 'blacklisted', 'Из чёрного списка', 'В чёрный список'), flag(g, 'pinned', 'Открепить', 'Закрепить'),
          btn('Обработать заново', () => act(() => api(`/games/${g.slug}/reprocess`, { method: 'POST', body: { stages: ['data', 'summary'] } }), 'Поставлено')),
          btn('Удалить', confirmed(`Удалить «${g.title}» из базы?`, () => act(() => api(`/games/${g.slug}`, { method: 'DELETE' }).then(() => tabGames(q)))), 'btn-danger'))))))))));
}

// ---------------- journal ----------------
async function tabJournal() {
  const [{ audit }, { events }] = await Promise.all([api('/audit?limit=50'), api('/events?limit=100')]);
  view.replaceChildren(h('div', { class: 'dash' },
    h('div', { class: 'panel' }, h('h2', {}, 'Действия администратора'), h('div', { class: 'log' }, audit.length ? audit.map((a) => h('div', {}, h('span', { class: 'time' }, fmtDate(a.at)), `${a.actor ?? '—'}: ${a.action} ${a.detail ?? ''}`)) : h('div', { class: 'muted' }, 'Пока пусто'))),
    h('div', { class: 'panel' }, h('h2', {}, 'События сервиса'), h('div', { class: 'log' }, events.map((e) => h('div', { class: e.level }, h('span', { class: 'time' }, fmtDate(e.at)), `[${e.scope}] ${e.message}`))))));
}

// ---------------- data ----------------
async function tabData() {
  const stats = await api('/ai/stats');
  view.replaceChildren(h('div', { class: 'dash' },
    h('div', { class: 'panel' }, h('h2', {}, 'Выгрузка и бэкап'), h('p', { class: 'muted small' }, 'Бэкап базы также делается автоматически раз в сутки.'),
      h('div', { class: 'row' }, h('a', { class: 'btn btn-sm', href: '/api/v1/export/games.json' }, 'Игры (JSON)'), h('a', { class: 'btn btn-sm', href: '/api/v1/export/games.csv' }, 'Игры (CSV)'), h('a', { class: 'btn btn-sm', href: '/api/v1/backup' }, 'Скачать базу данных'))),
    h('div', { class: 'panel' }, h('h2', {}, 'Работа ИИ'),
      h('p', {}, `За 24 часа: вызовов ${stats.last_24h.calls}, успешных ${stats.last_24h.ok}. Резюме: ${stats.summaries.ok}, пунктов принято ${stats.summaries.kept}, отброшено без подтверждения ${stats.summaries.dropped}.`),
      h('div', { class: 'scroll-x' }, h('table', { class: 't' }, h('thead', {}, h('tr', {}, ['Модель', 'Вызовов', 'Успешно', 'Среднее, мс', 'Токены'].map((c) => h('th', {}, c)))),
        h('tbody', {}, stats.by_model.map((m) => h('tr', {}, h('td', { class: 'small' }, `${m.provider}/${m.model}`), h('td', {}, m.calls), h('td', {}, m.ok), h('td', {}, m.avg_ms ?? '—'), h('td', { class: 'small' }, `${m.tokens_in ?? 0} → ${m.tokens_out ?? 0}`))))))),
    h('div', { class: 'panel' }, h('h2', {}, 'Последние вызовы ИИ'), h('div', { class: 'log' }, stats.recent.map((c) => h('div', { class: c.ok ? '' : 'warn' }, h('span', { class: 'time' }, fmtDate(c.at)), `${c.purpose} ${c.provider}/${(c.model ?? '').split('/').pop()} ${c.ok ? 'ок' : c.error ?? 'ошибка'} ${c.latency_ms ?? '?'} мс${c.slug ? ` · ${c.slug}` : ''}`))))));
}

const TABS = [['control', 'Управление', tabControl], ['settings', 'Настройки', tabSettings], ['providers', 'Нейросети', tabProviders], ['queue', 'Очередь', () => tabQueue()], ['games', 'Игры', () => tabGames()], ['journal', 'Журнал', tabJournal], ['data', 'Данные и ИИ', tabData]];
const tabs = $('#tabs');
function open(key) {
  const [, , fn] = TABS.find(([k]) => k === key) ?? TABS[0];
  tabs.replaceChildren(...TABS.map(([k, label]) => h('button', { class: k === key ? 'active' : '', role: 'tab', onclick: () => { history.replaceState(null, '', `#${k}`); open(k); } }, label)));
  Promise.resolve(fn()).catch((e) => view.replaceChildren(h('div', { class: 'empty' }, e.message)));
}
open(location.hash.slice(1) || 'control');
