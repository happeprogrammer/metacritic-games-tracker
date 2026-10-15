import { $, h, api, mountShell, fmtDate, ago, clock, toast } from './common.js';

await mountShell('monitor');
const dash = $('#dash');
let snap = null;

const STATE = { running: ['good', 'работает'], idle: ['', 'ждёт задач'], waiting: ['info', 'ждёт запуска'], paused: ['warn', 'на паузе'], error: ['bad', 'ошибка'] };
const PSTATE = { ok: ['good', 'готов'], cooldown: ['warn', 'охлаждение'], budget: ['warn', 'лимит дня'], denied: ['bad', 'доступ закрыт'], no_key: ['', 'нет ключа'], off: ['', 'выключен'] };
const WNAME = { scheduler: 'Планировщик', fetcher: 'Сборщик (Metacritic)', summarizer: 'ИИ-резюме', letsplay: 'Летсплеи', housekeeper: 'Уборка и бэкап' };
const GATE = { busy: 'Сбор уже идёт', paused: 'Сбор на паузе', disabled: 'Кнопка отключена', daily_cap: 'Суточный лимит ручных запусков исчерпан' };
const chip = (pair) => h('span', { class: `chip ${pair[0]}` }, pair[1]);
const sec = (iso) => (iso ? Math.round((new Date(iso).getTime() - Date.now()) / 1000) : null);

const logPanel = h('div', { class: 'panel wide', id: 'log-panel' }, h('h2', {}, 'Журнал событий (живой)'), h('div', { class: 'log', id: 'log' }));
dash.append(logPanel);
const logLine = (e) => h('div', { class: e.level }, h('span', { class: 'time' }, new Date(e.at).toLocaleTimeString('ru-RU')), e.message);

const runBtn = h('button', { class: 'btn btn-primary', onclick: async () => {
  runBtn.disabled = true;
  try { await api('/runs', { method: 'POST', body: {} }); toast('Сбор запущен'); } catch (e) { toast(e.data?.reason === 'cooldown' ? `Подождите ${e.data.retry_in_s} с` : (GATE[e.data?.reason] ?? e.message), 'error'); }
} }, 'Запустить сбор сейчас');
const nextIn = h('span', {}, '—');

/** Cheap per-second update: countdown to the next run and the button's cooldown. */
function tick() {
  if (!snap) return;
  const s = snap;
  const next = sec(s.scheduler.next_run_at);
  nextIn.textContent = s.scheduler.paused ? '—' : next == null ? 'после старта' : next > 0 ? `через ${clock(next)}` : 'вот-вот';
  const m = s.manual_run;
  const left = m.reason === 'cooldown' ? Math.max(0, m.cooldown_left_s - Math.floor((Date.now() - s._at) / 1000)) : 0;
  const blocked = !m.allowed && !(m.reason === 'cooldown' && left === 0);
  runBtn.disabled = blocked;
  runBtn.textContent = !blocked ? 'Запустить сбор сейчас' : m.reason === 'cooldown' ? `Подождите ${left} с` : GATE[m.reason] ?? 'Недоступно';
}

function render() {
  const s = snap;
  const lr = s.scheduler.last_run;
  const done = s.run ? s.run.done + s.run.failed : 0;
  const bar = h('div', { class: 'progress' }, h('span'));
  bar.firstChild.style.width = `${s.run && s.run.picked ? Math.round((done / s.run.picked) * 100) : 0}%`;
  const panels = [
    h('div', { class: 'panel rerender' }, h('h2', {}, 'Планировщик'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Состояние'), h('dd', {}, s.scheduler.paused ? chip(['warn', 'на паузе']) : s.scheduler.state === 'running' ? chip(['good', 'идёт сбор']) : chip(['info', 'ожидает'])),
        h('dt', {}, 'Следующий запуск'), h('dd', {}, nextIn),
        h('dt', {}, 'Последний прогон'), h('dd', {}, lr ? `№${lr.id}: ${lr.status}, готово ${lr.ok}, ошибок ${lr.failed}, ${ago(lr.finished_at)}` : 'ещё не было')),
      h('div', { class: 'mb' }), runBtn,
      h('p', { class: 'muted small' }, `Ручных запусков сегодня: ${s.manual_run.used_today} из ${s.manual_run.cap}. Между нажатиями нужна пауза.`)),
    h('div', { class: 'panel rerender' }, h('h2', {}, 'Текущий прогон'),
      s.run ? [h('p', {}, `Прогон №${s.run.id} (${s.run.trigger}): ${done} из ${s.run.picked}, ошибок ${s.run.failed}`), bar,
        h('div', { class: 'row' }, s.run.items.map((i) => h('span', { class: `chip ${i.status === 'done' ? 'good' : i.status === 'failed' ? 'bad' : i.status === 'running' ? 'info' : ''}`, title: i.status }, i.slug)))]
        : h('p', { class: 'muted' }, 'Сейчас прогона нет. Следующий запустится по расписанию или по кнопке.')),
    h('div', { class: 'panel rerender wide' }, h('h2', {}, 'Воркеры'), h('div', { class: 'scroll-x' }, h('table', { class: 't' },
      h('thead', {}, h('tr', {}, ['Воркер', 'Состояние', 'Сейчас', 'Сегодня', 'Ошибки', 'Последняя ошибка'].map((c) => h('th', {}, c)))),
      h('tbody', {}, s.workers.map((w) => h('tr', {}, h('td', {}, WNAME[w.id] ?? w.id), h('td', {}, chip(STATE[w.state] ?? ['', w.state])), h('td', { class: 'small' }, w.current ?? '—'),
        h('td', {}, w.processed_today ?? '—'), h('td', {}, w.errors_today ?? '—'), h('td', { class: 'small muted' }, w.last_error ? w.last_error.slice(0, 80) : '—'))))))),
    h('div', { class: 'panel rerender wide' }, h('h2', {}, 'Нейросети (бесплатные тарифы)'), h('div', { class: 'scroll-x' }, h('table', { class: 't' },
      h('thead', {}, h('tr', {}, ['Провайдер', 'Состояние', 'Вызовов сегодня', 'Модели', 'Последняя ошибка'].map((c) => h('th', {}, c)))),
      h('tbody', {}, s.providers.map((p) => h('tr', {}, h('td', {}, p.id), h('td', {}, chip(PSTATE[p.state] ?? ['', p.state]), p.breaker_until ? h('div', { class: 'muted small' }, `до ${fmtDate(p.breaker_until)}`) : null),
        h('td', {}, `${p.calls_today} / ${p.cap}`), h('td', { class: 'small' }, p.models.map((m) => m.split('/').pop()).join(', ')), h('td', { class: 'small muted' }, p.last_error ? p.last_error.slice(0, 90) : '—'))))))),
    h('div', { class: 'panel rerender' }, h('h2', {}, 'Очередь и источник'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Задач ИИ в очереди'), h('dd', {}, `${s.queue.pending} (в работе ${s.queue.running}, с ошибкой ${s.queue.failed}, готово ${s.queue.done})`),
        h('dt', {}, 'Источник Metacritic'), h('dd', {}, h('span', { class: `dot ${s.source.status === 'unknown' ? '' : s.source.status}` }), { green: 'в порядке', yellow: 'работает с ограничениями', red: 'недоступен', unknown: 'ещё не проверялся' }[s.source.status], s.source.error ? h('div', { class: 'muted small' }, s.source.error) : null))),
    h('div', { class: 'panel rerender' }, h('h2', {}, 'Счётчики'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Игр в базе'), h('dd', {}, s.counters.games_total), h('dt', {}, 'Обработано сегодня'), h('dd', {}, s.counters.games_today),
        h('dt', {}, 'С ИИ-резюме'), h('dd', {}, s.counters.summaries_ok), h('dt', {}, 'Резюме в ожидании'), h('dd', {}, s.counters.summaries_waiting),
        h('dt', {}, 'С летсплеем'), h('dd', {}, s.counters.letsplay_ok), h('dt', {}, 'База данных'), h('dd', {}, `${s.db.size_mb} МБ`),
        h('dt', {}, 'Работает'), h('dd', {}, clock(s.uptime_s)))),
  ];
  for (const old of dash.querySelectorAll(':scope > .rerender')) old.remove();
  dash.prepend(...panels);
  tick();
}

function connect() {
  const es = new EventSource('/api/v1/stream');
  es.addEventListener('snapshot', (ev) => {
    snap = JSON.parse(ev.data);
    snap._at = Date.now();
    $('#conn').textContent = `Подключено · обновлено ${new Date().toLocaleTimeString('ru-RU')}`;
    render();
  });
  es.addEventListener('log', (ev) => {
    const box = $('#log');
    box.prepend(logLine(JSON.parse(ev.data)));
    while (box.childElementCount > 200) box.lastChild.remove();
  });
  es.onerror = () => { $('#conn').textContent = 'Связь потеряна, переподключаюсь…'; };
}
connect();
setInterval(tick, 1000);
