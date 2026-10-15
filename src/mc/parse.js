// Metacritic responses -> plain objects. Pure functions; any unexpected shape throws McError('schema').
import { McError } from './errors.js';

const asNum = (v) => (Number.isFinite(v) ? v : null);
const asInt = (v) => (Number.isFinite(v) ? Math.round(v) : null);
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const coverFrom = (img) => (img?.bucketType && img?.bucketPath ? `https://www.metacritic.com/a/img/${img.bucketType}${img.bucketPath}` : null);
const clean = (s) => (typeof s === 'string' && s.trim() ? s.trim() : null);

/** Slugs of the "New Releases" block on the Games home page, in page order (normally 20). */
export function parseNewReleases(html) {
  const start = html.indexOf('New Releases');
  if (start < 0) return [];
  const next = html.indexOf('global-header-title', start + 300); // the next block's heading ends our block
  const segment = html.slice(start, next > 0 ? next : start + 60000);
  return [...new Set([...segment.matchAll(/href="\/game\/([a-z0-9][a-z0-9-]*)\/"/g)].map((m) => m[1]))];
}

export function parseFinder(json) {
  const d = json?.data;
  if (!d || !Array.isArray(d.items)) throw new McError('schema', 'finder: нет data.items');
  return {
    total: asInt(d.totalResults) ?? d.items.length,
    items: d.items.filter((i) => i?.slug).map((i) => ({
      slug: i.slug,
      title: i.title ?? i.slug,
      releaseDate: i.releaseDate ?? null,
      coverUrl: coverFrom(i.image),
    })),
  };
}

export function parseProduct(json) {
  const it = json?.data?.item;
  if (!it || typeof it.title !== 'string' || !it.title) throw new McError('schema', 'product: нет data.item.title');
  const companies = it.production?.companies ?? [];
  const names = (typeId) => [...new Set(companies.filter((c) => c?.typeId === typeId).map((c) => c.name).filter(Boolean))];
  const images = it.images ?? [];
  const main = images.find((i) => i?.typeName === 'mainImage') ?? images[0];

  let platforms = (it.platforms ?? []).filter((p) => p?.name).map((p) => ({
    slug: p.slug || slugify(p.name),
    name: p.name,
    isLead: Boolean(p.isLead),
    releaseDate: p.releaseDate ?? null,
    criticScore: asInt(p.criticScoreSummary?.score),
    criticCount: asInt(p.criticScoreSummary?.reviewCount),
  }));
  if (platforms.length === 0 && it.platform) {
    platforms = [{ slug: slugify(it.platform), name: it.platform, isLead: true, releaseDate: it.releaseDate ?? null,
      criticScore: asInt(it.criticScoreSummary?.score), criticCount: asInt(it.criticScoreSummary?.reviewCount) }];
  }
  if (platforms.length && !platforms.some((p) => p.isLead)) {
    (platforms.find((p) => p.name === it.platform) ?? platforms[0]).isLead = true;
  }
  platforms.sort((a, b) => Number(b.isLead) - Number(a.isLead));

  return {
    game: {
      slug: it.slug ?? null,
      title: it.title,
      description: clean(it.description),
      releaseDate: it.releaseDate ?? null,
      esrb: clean(it.rating),
      genres: (it.genres ?? []).map((g) => g?.name).filter(Boolean),
      developer: names(1)[0] ?? null,
      publishers: names(2),
      coverUrl: coverFrom(main),
      videoUrl: clean(it.video?.embedUrl),
      videoTitle: clean(it.video?.title) ?? clean(it.video?.videoTitle),
    },
    platforms,
    raw: json,
  };
}

/** Player score for one platform. Metacritic answers score 0 with 0 reviews for "no score yet": that is null here. */
export function parseUserStats(json) {
  const it = json?.data?.item;
  if (!it) throw new McError('schema', 'user stats: нет data.item');
  const count = asInt(it.reviewCount) ?? 0;
  return { score: count > 0 ? asNum(it.score) : null, count };
}

export function parseReviews(json, kind) {
  const d = json?.data;
  if (!d || !Array.isArray(d.items)) throw new McError('schema', `${kind} reviews: нет data.items`);
  return {
    total: asInt(d.totalResults) ?? d.items.length,
    items: d.items.map((r) => ({
      id: r.id ?? null,
      quote: String(r.quote ?? '').replace(/\s+/g, ' ').trim(),
      score: asNum(r.score),
      date: r.date ?? null,
      who: kind === 'critics' ? (r.publicationName ?? null) : (r.author ?? null),
      spoiler: Boolean(r.spoiler),
    })),
  };
}
