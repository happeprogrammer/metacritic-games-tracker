import { $, h, api, mountShell, scoreEl, cover, ASPECT_RU, fmtDate, ago } from './common.js';

await mountShell('games');
const app = $('#app');
const slug = decodeURIComponent(location.pathname.split('/').pop());
const SVG = 'http://www.w3.org/2000/svg';

let g;
try { g = await api(`/games/${encodeURIComponent(slug)}`); } catch (e) {
  app.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, e.status === 404 ? 'Игра не найдена' : 'Ошибка'), h('p', {}, e.message), h('a', { class: 'btn', href: '/' }, '← К списку')));
  throw e;
}
document.title = `${g.title} — Games Tracker`;

function sparkline() {
  const keys = Object.keys(g.history).sort((a, b) => g.history[b].length - g.history[a].length);
  const pts = keys.length ? g.history[keys[0]] : [];
  if (pts.length < 2) return h('p', { class: 'muted small' }, 'Пока одно измерение: график появится, когда оценки изменятся при следующих обходах.');
  const W = 400, H = 90, pad = 6;
  const x = (i) => pad + (i * (W - 2 * pad)) / (pts.length - 1);
  const y = (v) => H - pad - (v / 100) * (H - 2 * pad);
  const line = (cls, get) => {
    const path = pts.map((p, i) => ({ v: get(p), i })).filter((p) => p.v != null);
    if (path.length < 2) return null;
    const el = document.createElementNS(SVG, 'polyline');
    el.setAttribute('class', cls);
    el.setAttribute('points', path.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' '));
    return el;
  };
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'spark');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Изменение оценок со временем');
  for (const v of [25, 50, 75]) { const l = document.createElementNS(SVG, 'line'); l.setAttribute('class', 'grid-line'); l.setAttribute('x1', 0); l.setAttribute('x2', W); l.setAttribute('y1', y(v)); l.setAttribute('y2', y(v)); svg.append(l); }
  for (const l of [line('l-critic', (p) => p.critic), line('l-user', (p) => (p.user == null ? null : p.user * 10))]) if (l) svg.append(l);
  const name = g.platforms.find((p) => p.slug === keys[0])?.name ?? keys[0];
  return h('div', {}, svg, h('div', { class: 'row small muted' }, h('span', { class: 'chip info' }, 'критики'), h('span', { class: 'chip', title: '' }, 'игроки ×10'), `платформа: ${name}, измерений: ${pts.length}`));
}

function video() {
  if (!g.video) return h('p', { class: 'muted small' }, 'Видео для этой игры на Metacritic пока нет (у новинок его часто ещё не публикуют).');
  const box = h('div', { class: 'row' });
  const play = h('button', { class: 'btn', onclick: () => { play.replaceWith(h('iframe', { class: 'video-box', src: g.video.url, title: g.video.title ?? 'Видео', allowfullscreen: true, loading: 'lazy', referrerpolicy: 'no-referrer' })); } }, '▶ Смотреть видео');
  box.append(play, h('a', { class: 'btn', href: g.video.url, target: '_blank', rel: 'noopener noreferrer' }, 'Открыть отдельно ↗'), g.video.title ? h('span', { class: 'muted small' }, g.video.title) : null);
  return box;
}

const points = (list, neg) => h('ul', { class: `points${neg ? ' neg' : ''}` }, list.map((p) => h('li', {},
  h('details', {}, h('summary', {}, p.text, ' ', h('span', { class: 'muted small' }, '· цитата')), h('blockquote', {}, p.evidence)))));

function summaryBlock(kind, title) {
  const s = g.summaries[kind];
  const head = h('h3', {}, title);
  if (!s || s.status === 'pending') return h('div', { class: 'panel' }, head, h('p', { class: 'muted' }, 'Резюме в очереди: бесплатные лимиты ИИ ограничены, игры с наибольшим числом отзывов обрабатываются первыми.'));
  if (s.status === 'insufficient') return h('div', { class: 'panel' }, head, h('p', { class: 'muted' }, `Слишком мало отзывов для резюме (всего ${s.reviews_total ?? 0}). Проверим при следующем обходе.`));
  const aspects = Object.entries(s.aspects).filter(([, v]) => v !== 'none');
  return h('div', { class: 'panel' }, head,
    h('h3', { class: 'small muted' }, 'Нравится'), s.likes.length ? points(s.likes, false) : h('p', { class: 'muted small' }, 'Подтверждённых пунктов нет.'),
    h('h3', { class: 'small muted' }, 'Не нравится'), s.dislikes.length ? points(s.dislikes, true) : h('p', { class: 'muted small' }, 'Подтверждённых пунктов нет.'),
    aspects.length ? h('div', { class: 'row' }, aspects.map(([k, v]) => h('span', { class: `chip ${v === 'praise' ? 'good' : v === 'criticism' ? 'bad' : 'warn'}` }, `${v === 'praise' ? '+' : v === 'criticism' ? '−' : '±'} ${ASPECT_RU[k]}`))) : null,
    h('p', { class: 'muted small' }, `Резюме сделано моделью ${s.model} (${s.provider}) по ${s.reviews_used} из ${s.reviews_total} отзывов · пунктов без подтверждения цитатой отброшено: ${s.dropped_points} · ${fmtDate(s.created_at)}`));
}

function letsplay() {
  const l = g.letsplay;
  if (!l) return h('div', { class: 'panel' }, h('h2', {}, 'Летсплей и заключение'), h('p', { class: 'muted' }, 'Пока не искали: поиск идёт после первого обхода, только для вышедших игр, у которых есть оценки. Если лимит нейросетей на сегодня исчерпан, игра ждёт в очереди.'));
  if (l.status === 'disabled') return null;
  const body = [];
  if (l.status === 'ok') {
    body.push(h('p', {}, h('a', { href: l.video_url, target: '_blank', rel: 'noopener noreferrer' }, l.video_title ?? 'Ролик'), h('span', { class: 'muted small' }, ` · ${l.channel ?? ''} · ${l.views?.toLocaleString('ru-RU') ?? '?'} просмотров`)));
    const c = l.conclusion;
    if (c) {
      body.push(h('p', {}, c.summary), c.pros?.length ? h('ul', {}, c.pros.map((x) => h('li', {}, `+ ${x}`))) : null, c.cons?.length ? h('ul', {}, c.cons.map((x) => h('li', {}, `− ${x}`))) : null, c.verdict ? h('p', {}, h('b', {}, `Вывод: ${c.verdict}`)) : null);
    }
    if (l.transcript) body.push(h('details', {}, h('summary', {}, `Речь блогера в текст (${l.transcript_source === 'captions' ? 'из субтитров' : 'распознано нейросетью'})`), h('p', { class: 'muted small' }, l.transcript)));
  } else body.push(h('p', { class: 'muted' }, { pending: 'Ищем самый популярный летсплей…', not_found: 'Подходящий летсплей пока не найден, поищем снова.', no_transcript: 'Ролик найден, но текст речи получить не удалось, попробуем позже.', failed: 'Не удалось обработать, попробуем позже.' }[l.status] ?? ''));
  return h('div', { class: 'panel' }, h('h2', {}, 'Летсплей и заключение'), body);
}

const platTable = h('div', { class: 'scroll-x' }, h('table', { class: 't' },
  h('thead', {}, h('tr', {}, h('th', {}, 'Платформа'), h('th', {}, 'Критики'), h('th', {}, 'Игроки'))),
  h('tbody', {}, g.platforms.map((p) => h('tr', {}, h('td', {}, p.name, p.is_lead ? h('span', { class: 'chip' }, 'основная') : null),
    h('td', {}, scoreEl(p.critic_score, 100), h('span', { class: 'muted small' }, p.critic_count ? ` ${p.critic_count} рецензий` : ' нет оценки')),
    h('td', {}, scoreEl(p.user_score, 10, true), h('span', { class: 'muted small' }, p.user_count ? ` ${p.user_count.toLocaleString('ru-RU')} оценок` : ' нет оценки')))))));

app.replaceChildren(...[
  h('p', {}, h('a', { href: '/' }, '← К списку')),
  h('div', { class: 'hero' },
    cover(g.cover_url, g.title),
    h('div', {},
      h('h1', {}, g.title),
      h('div', { class: 'row' }, g.genres.map((x) => h('span', { class: 'chip info' }, x)), g.esrb ? h('span', { class: 'chip' }, `ESRB ${g.esrb}`) : null,
        g.gap != null && g.gap >= 1.5 ? h('span', { class: 'chip warn', title: 'Не доказательство накрутки' }, `критики и игроки спорят (разрыв ${g.gap})`) : null),
      h('dl', { class: 'kv' }, h('dt', {}, 'Разработчик'), h('dd', {}, g.developer ?? '—'), h('dt', {}, 'Издатель'), h('dd', {}, g.publishers.join(', ') || '—'),
        h('dt', {}, 'Выход'), h('dd', {}, g.release_date ?? '—'), h('dt', {}, 'Источник'), h('dd', {}, h('a', { href: g.metacritic_url, target: '_blank', rel: 'noopener noreferrer' }, 'страница на Metacritic ↗'))),
      h('p', {}, g.description ?? h('span', { class: 'muted' }, 'Описание на Metacritic пока не заполнено.')),
      video())),
  h('div', { class: 'two' }, h('div', { class: 'panel' }, h('h2', {}, 'Оценки по платформам'), platTable), h('div', { class: 'panel' }, h('h2', {}, 'Динамика оценок'), sparkline())),
  h('h2', {}, 'Что нравится и не нравится'),
  h('div', { class: 'two' }, summaryBlock('critics', 'По мнению критиков'), summaryBlock('users', 'По мнению игроков')),
  letsplay(),
  h('div', { class: 'panel' }, h('h2', {}, 'Похожие игры'),
    g.similar.length
      ? h('div', { class: 'row' }, g.similar.map((s) => h('a', { class: 'card', href: `/game/${encodeURIComponent(s.slug)}` }, h('div', { class: 'card-body' }, h('b', {}, s.title), h('div', { class: 'row' }, s.reasons.map((r) => h('span', { class: 'chip' }, r)))))))
      : h('p', { class: 'muted' }, 'В базе пока мало игр для сравнения: подборка появится по мере сбора.')),
  h('p', { class: 'muted small' }, `Данные обновлены ${ago(g.freshness.last_fetched_at)} (${fmtDate(g.freshness.last_fetched_at)}); впервые увидели ${fmtDate(g.freshness.first_seen_at)}.`),
].filter(Boolean));
