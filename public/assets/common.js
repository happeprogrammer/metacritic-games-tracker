// Shared UI helpers. Everything from the outside world is inserted as text, never as HTML.
export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/v1${path}`, {
    method, credentials: 'same-origin',
    headers: { 'x-requested-with': 'fetch', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (res.status === 401 && !location.pathname.startsWith('/login')) { location.href = '/login'; throw new Error('нужен вход'); }
  if (!res.ok) { const err = new Error(data?.error ?? data?.reason ?? `Ошибка ${res.status}`); err.status = res.status; err.data = data; throw err; }
  return data;
}

const PLAT = { 'playstation-5': 'PS5', 'playstation-4': 'PS4', 'xbox-series-x': 'XSX', 'xbox-one': 'XB1', 'nintendo-switch': 'NS', 'nintendo-switch-2': 'NS2', pc: 'PC', ios: 'iOS', android: 'Android', 'playstation-vita': 'Vita', 'meta-quest': 'Quest' };
export const platShort = (p) => PLAT[p.slug] ?? p.name;

export const ASPECT_RU = { gameplay: 'геймплей', story: 'сюжет', visuals_audio: 'графика и звук', performance: 'оптимизация', controls: 'управление', multiplayer: 'мультиплеер', price: 'цена' };

/** scale: 100 for critics (Metascore), 10 for players. */
export function scoreEl(value, scale, user = false) {
  const v = value == null ? null : scale === 10 ? value * 10 : value;
  const cls = v == null ? 'none' : v >= 75 ? 'high' : v >= 50 ? 'mid' : 'low';
  return h('span', { class: `score ${cls}${user ? ' user' : ''}`, title: user ? 'Оценка игроков (0–10)' : 'Метаскор критиков (0–100)' }, value == null ? '—' : String(value));
}

const dt = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
export const fmtDate = (iso) => (iso ? dt.format(new Date(iso)) : '—');
const rtf = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' });
export function ago(iso) {
  if (!iso) return '—';
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const a = Math.abs(s);
  if (a < 60) return rtf.format(Math.round(s), 'second');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}
export function clock(sec) {
  if (sec == null || sec < 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m} мин ${String(s).padStart(2, '0')} с`;
}

export function toast(message, kind = 'ok') {
  let host = $('.toast-host');
  if (!host) { host = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' }); document.body.append(host); }
  const t = h('div', { class: `toast ${kind}` }, message);
  host.append(t);
  setTimeout(() => t.remove(), 5000);
}

/** Header, navigation and the "test assignment" banner. Returns the current user's role. */
export async function mountShell(active) {
  const me = await api('/me');
  const link = (href, label, key) => h('a', { href, class: key === active ? 'active' : '' }, label);
  const header = h('header', { class: 'topbar' }, h('div', { class: 'container' },
    h('a', { class: 'brand', href: '/' }, h('span', { class: 'brand-mark' }, 'G'), 'Games Tracker'),
    h('nav', { class: 'nav' }, link('/', 'Игры', 'games'), link('/monitor', 'Монитор', 'monitor'), link('/about', 'О проекте', 'about'), me.role === 'admin' ? link('/admin', 'Управление', 'admin') : null),
    h('div', { class: 'userbox' }, h('span', { class: 'chip' }, me.role === 'admin' ? 'администратор' : 'проверяющий'),
      h('button', { class: 'btn btn-sm', onclick: async () => { await api('/auth/logout', { method: 'POST' }); location.href = '/login'; } }, 'Выйти'))));
  const banner = h('div', { class: 'banner' }, h('div', { class: 'container' },
    h('b', {}, 'Тестовое задание на позицию AI Automation Engineer.'),
    h('span', {}, 'Демо-стенд, не коммерческий сервис. Данные Metacritic принадлежат их владельцам и показаны для демонстрации.'),
    h('a', { href: '/about' }, 'Как это работает')));
  document.body.prepend(header, banner);
  return me;
}

export const cover = (url, title) => {
  const box = h('div', { class: 'cover' });
  if (url) {
    const img = h('img', { src: url, alt: `Обложка: ${title}`, loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => { img.remove(); box.textContent = title.slice(0, 1).toUpperCase(); });
    box.append(img);
  } else box.textContent = title.slice(0, 1).toUpperCase();
  return box;
};
