// "Similar games": TF-IDF over description + review points + genres, mixed with genre overlap, developer and aspect profile.
const STOP = new Set(('the a an and or of to in on for with is are was were be been it its this that these those as at by from but not no so if '
  + 'game games player players play playing you your their they them his her has have had will can more most very just also than then into out up '
  + 'и в во не на с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну '
  + 'это игра игры игрок игроки').split(/\s+/));
const ASPECTS = ['gameplay', 'story', 'visuals_audio', 'performance', 'controls', 'multiplayer', 'price'];
const ASPECT_NAMES = { gameplay: 'геймплей', story: 'сюжет', visuals_audio: 'графику и звук', performance: 'оптимизацию', controls: 'управление', multiplayer: 'мультиплеер', price: 'цену' };
const SIGN = { praise: 1, criticism: -1, mixed: 0, none: 0 };

const tokens = (text) => String(text ?? '').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w));

export function createSimilar(db) {
  let cache = null;

  const versionKey = () => {
    const g = db.prepare('SELECT COUNT(*) AS c, MAX(last_fetched_at) AS m FROM games WHERE hidden = 0').get();
    const s = db.prepare('SELECT COUNT(*) AS c, MAX(created_at) AS m FROM summaries').get();
    return `${g.c}|${g.m}|${s.c}|${s.m}`;
  };

  function build() {
    const games = db.prepare('SELECT id, slug, title, description, developer, genres FROM games WHERE hidden = 0 AND blacklisted = 0').all().map((g) => ({ ...g }));
    const sums = new Map();
    for (const r of db.prepare("SELECT game_id, likes, dislikes, aspects FROM summaries WHERE status = 'ok'").all()) {
      const e = sums.get(r.game_id) ?? { text: [], vec: new Array(ASPECTS.length).fill(0) };
      for (const p of [...JSON.parse(r.likes ?? '[]'), ...JSON.parse(r.dislikes ?? '[]')]) e.text.push(p.text);
      const a = JSON.parse(r.aspects ?? '{}');
      ASPECTS.forEach((k, i) => { e.vec[i] += SIGN[a[k]] ?? 0; });
      sums.set(r.game_id, e);
    }
    const docs = games.map((g) => {
      const genres = JSON.parse(g.genres ?? '[]');
      const s = sums.get(g.id);
      const tf = new Map();
      for (const t of tokens(`${g.description ?? ''} ${(s?.text ?? []).join(' ')} ${genres.join(' ')}`)) tf.set(t, (tf.get(t) ?? 0) + 1);
      return { ...g, genres, tf, vec: s?.vec ?? null };
    });
    const df = new Map();
    for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    for (const d of docs) {
      let norm = 0;
      for (const [t, f] of d.tf) { const w = (1 + Math.log(f)) * Math.log(1 + docs.length / df.get(t)); d.tf.set(t, w); norm += w * w; }
      d.norm = Math.sqrt(norm) || 1;
    }
    return docs;
  }

  const cosine = (a, b) => {
    let dot = 0;
    const [small, big] = a.tf.size <= b.tf.size ? [a, b] : [b, a];
    for (const [t, w] of small.tf) { const o = big.tf.get(t); if (o) dot += w * o; }
    return dot / (a.norm * b.norm);
  };
  const vecCos = (a, b) => {
    if (!a || !b) return 0;
    const dot = a.reduce((s, x, i) => s + x * b[i], 0);
    const na = Math.hypot(...a), nb = Math.hypot(...b);
    return na && nb ? dot / (na * nb) : 0;
  };

  /** Up to `limit` games most like the given slug, each with a human reason. */
  function similarTo(slug, limit = 6) {
    const key = versionKey();
    if (!cache || cache.key !== key) cache = { key, docs: build() };
    const me = cache.docs.find((d) => d.slug === slug);
    if (!me) return [];
    const out = [];
    for (const d of cache.docs) {
      if (d.id === me.id) continue;
      const shared = d.genres.filter((g) => me.genres.includes(g));
      const union = new Set([...d.genres, ...me.genres]).size || 1;
      const sameDev = Boolean(me.developer && d.developer === me.developer);
      const av = vecCos(me.vec, d.vec);
      const score = 0.45 * cosine(me, d) + 0.30 * (shared.length / union) + 0.10 * (sameDev ? 1 : 0) + 0.15 * Math.max(0, av);
      if (score <= 0.05) continue;
      const praisedTogether = me.vec && d.vec ? ASPECTS.filter((_, i) => me.vec[i] > 0 && d.vec[i] > 0).map((k) => ASPECT_NAMES[k]) : [];
      const reasons = [];
      if (shared.length) reasons.push(`жанр: ${shared.join(', ')}`);
      if (sameDev) reasons.push(`разработчик: ${d.developer}`);
      if (praisedTogether.length) reasons.push(`в обоих хвалят: ${praisedTogether.slice(0, 3).join(', ')}`);
      if (!reasons.length) reasons.push('похожее описание');
      out.push({ slug: d.slug, title: d.title, score: Math.round(score * 1000) / 1000, reasons });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  return { similarTo };
}
