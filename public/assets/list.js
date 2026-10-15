import { $, h, api, mountShell, scoreEl, platShort, cover, ASPECT_RU, ago, clock } from './common.js';

await mountShell('games');

const state = Object.fromEntries(new URLSearchParams(location.search));
state.page = Number(state.page) || 1;
let facets = null;
let timer = null;

const select = (name, label, options, current) => h('label', { class: 'field' }, label,
  h('select', { class: 'select', name, onchange: (e) => { state[name] = e.target.value; state.page = 1; load(); } },
    options.map(([value, text]) => h('option', { value, selected: value === (current ?? '') }, text))));

function buildToolbar() {
  const bar = $('#toolbar');
  bar.replaceChildren(
    h('label', { class: 'field grow' }, 'Поиск по названию и разработчику',
      h('input', { class: 'input', type: 'search', placeholder: 'например, Elden Ring', value: state.q ?? '', oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => { state.q = e.target.value; state.page = 1; load(); }, 300); } })),
    select('platform', 'Платформа', [['', 'Все платформы'], ...facets.platforms.map((p) => [p.slug, `${p.name} (${p.count})`])], state.platform),
    select('genre', 'Жанр', [['', 'Все жанры'], ...facets.genres.map((g) => [g.name, `${g.name} (${g.count})`])], state.genre),
    select('year', 'Год', [['', 'Любой'], ...facets.years.map((y) => [y.name, `${y.name} (${y.count})`])], state.year),
    select('media', 'Видео', [['', 'Любые'], ['video', 'Есть видео Metacritic'], ['letsplay', 'Есть заключение по летсплею']], state.media),
    select('aspect', 'Где хвалят / ругают', [['', 'Не важно'], ...facets.aspects.flatMap((a) => [[`praise:${a}`, `хвалят: ${ASPECT_RU[a]}`], [`criticism:${a}`, `ругают: ${ASPECT_RU[a]}`]])], state.aspect),
    select('sort', 'Сортировка', [['updated', 'Недавно обновлены'], ['critic', 'Оценка критиков'], ['user', 'Оценка игроков'], ['gap', 'Разрыв критики/игроки'], ['release', 'Дата выхода'], ['title', 'Название']], state.sort ?? 'updated'),
    select('dir', 'Порядок', [['desc', 'По убыванию'], ['asc', 'По возрастанию']], state.dir ?? 'desc'),
  );
}

const summaryChip = (s) => ({
  ok: h('span', { class: 'chip good', title: 'Есть ИИ-резюме отзывов' }, 'есть резюме'),
  pending: h('span', { class: 'chip warn', title: 'Резюме в очереди (лимит бесплатного тарифа ИИ)' }, 'резюме в очереди'),
  insufficient: h('span', { class: 'chip', title: 'Слишком мало отзывов для резюме' }, 'мало отзывов'),
}[s] ?? null);

function card(g) {
  const year = g.release_date?.slice(0, 4);
  return h('a', { class: 'card', href: `/game/${encodeURIComponent(g.slug)}` },
    cover(g.cover_url, g.title),
    h('div', { class: 'card-body' },
      h('h3', { class: 'card-title' }, g.title),
      h('div', { class: 'muted small' }, [g.developer, year].filter(Boolean).join(' · ') || '—'),
      h('div', { class: 'row' }, g.platforms.map((p) => h('span', { class: 'plat', title: p.name }, platShort(p), scoreEl(p.critic, 100), p.user != null ? scoreEl(p.user, 10, true) : null))),
      h('div', { class: 'row' }, summaryChip(g.summary_status),
        g.has_video ? h('span', { class: 'chip info', title: 'У игры есть видео на Metacritic: ссылка в карточке игры' }, '▶ видео') : null,
        g.has_letsplay ? h('span', { class: 'chip info', title: 'Есть летсплей и заключение по нему: в карточке игры' }, '▶ летсплей') : null,
        g.gap != null && g.gap >= 1.5 ? h('span', { class: 'chip warn', title: 'Разрыв между оценками критиков и игроков (не доказательство накрутки)' }, `критики и игроки спорят (${g.gap})`) : null,
        g.praise.map((a) => h('span', { class: 'chip good' }, `+ ${ASPECT_RU[a]}`)), g.criticism.map((a) => h('span', { class: 'chip bad' }, `− ${ASPECT_RU[a]}`))),
    ));
}

function syncUrl() {
  const p = new URLSearchParams();
  for (const k of ['q', 'platform', 'genre', 'year', 'media', 'aspect', 'sort', 'dir']) if (state[k]) p.set(k, state[k]);
  if (state.page > 1) p.set('page', state.page);
  history.replaceState(null, '', p.size ? `?${p}` : location.pathname);
}

async function load() {
  syncUrl();
  const list = $('#list');
  list.replaceChildren(h('div', { class: 'grid' }, [1, 2, 3, 4, 5, 6].map(() => h('div', { class: 'skeleton' }))));
  const p = new URLSearchParams({ per: 24, page: state.page });
  for (const k of ['q', 'platform', 'genre', 'year', 'aspect', 'sort', 'dir']) if (state[k]) p.set(k, state[k]);
  if (state.media === 'video') p.set('video', '1');
  if (state.media === 'letsplay') p.set('letsplay', '1');
  let data;
  try { data = await api(`/games?${p}`); } catch (e) { list.replaceChildren(h('div', { class: 'empty' }, `Не удалось загрузить: ${e.message}`)); return; }
  if (!facets) { facets = data.facets; buildToolbar(); }
  list.replaceChildren(data.items.length
    ? h('div', { class: 'grid' }, data.items.map(card))
    : h('div', { class: 'empty' }, h('h3', {}, 'Ничего не найдено'), h('p', {}, 'Сбросьте фильтры или подождите следующего обхода: сервис собирает новые игры каждый час.')));
  const pages = Math.max(1, Math.ceil(data.total / data.per));
  $('#pager').replaceChildren(
    h('button', { class: 'btn', disabled: state.page <= 1, onclick: () => { state.page--; load(); scrollTo(0, 0); } }, '← Назад'),
    h('span', { class: 'muted' }, `Страница ${state.page} из ${pages} · найдено ${data.total}`),
    h('button', { class: 'btn', disabled: state.page >= pages, onclick: () => { state.page++; load(); scrollTo(0, 0); } }, 'Вперёд →'));
}

async function status() {
  try {
    const m = await api('/monitor');
    const next = m.scheduler.next_run_at ? Math.round((new Date(m.scheduler.next_run_at).getTime() - Date.now()) / 1000) : null;
    $('#status').textContent = `В базе ${m.counters.games_total} игр · обработано сегодня ${m.counters.games_today} · с ИИ-резюме ${m.counters.summaries_ok} · `
      + (m.scheduler.paused ? 'сбор на паузе' : m.scheduler.state === 'running' ? 'идёт сбор…' : next != null ? (next > 0 ? `следующий обход через ${clock(next)}` : 'обход вот-вот начнётся') : 'первый обход скоро') + ` · данные обновлены ${ago(m.run?.started_at ?? m.scheduler.last_run?.finished_at)}`;
  } catch { $('#status').textContent = ''; }
}

await load();
status();
setInterval(status, 15000);
