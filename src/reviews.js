// Pick a balanced, clean sample of reviews: positive/mixed/negative buckets, newest first, no spoilers or duplicates.

const MIN_LEN = { critics: 20, users: 40 };
const MAX_QUOTE = 500;

function bucketOf(kind, score) {
  const [hi, mid] = kind === 'critics' ? [75, 50] : [8, 5];
  if (score === null || score === undefined) return 'mixed';
  return score >= hi ? 'positive' : score >= mid ? 'mixed' : 'negative';
}

/** How many to take from each non-empty bucket: at least ~20% of cap each (if available), the rest proportional. */
function allocate(sizes, cap) {
  const keys = Object.keys(sizes).filter((k) => sizes[k] > 0);
  const total = keys.reduce((a, k) => a + sizes[k], 0);
  if (total <= cap) return Object.fromEntries(keys.map((k) => [k, sizes[k]]));
  const floor = Math.max(1, Math.floor(cap * 0.2));
  const q = Object.fromEntries(keys.map((k) => [k, Math.min(sizes[k], floor)]));
  let left = cap - keys.reduce((a, k) => a + q[k], 0);
  while (left > 0) {
    const open = keys.filter((k) => q[k] < sizes[k]);
    if (open.length === 0) break;
    const room = open.reduce((a, k) => a + (sizes[k] - q[k]), 0);
    let given = 0;
    for (const k of open) {
      const add = Math.min(sizes[k] - q[k], Math.floor((left * (sizes[k] - q[k])) / room));
      q[k] += add;
      given += add;
    }
    if (given === 0) { // rounding left a remainder: hand out one at a time to the roomiest bucket
      open.sort((a, b) => (sizes[b] - q[b]) - (sizes[a] - q[a]));
      q[open[0]]++;
      given = 1;
    }
    left -= given;
  }
  return q;
}

export function sampleReviews(items, { kind, cap }) {
  const seen = new Set();
  const buckets = { positive: [], mixed: [], negative: [] };
  for (const r of items) {
    const quote = String(r.quote ?? '').trim().slice(0, MAX_QUOTE);
    const key = quote.toLowerCase();
    if (r.spoiler || quote.length < MIN_LEN[kind] || seen.has(key)) continue;
    seen.add(key);
    const bucket = bucketOf(kind, r.score);
    buckets[bucket].push({ ...r, quote, bucket });
  }
  const newestFirst = (a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''));
  const sizes = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));
  const take = allocate(sizes, cap);
  return Object.entries(buckets).flatMap(([k, list]) => list.sort(newestFirst).slice(0, take[k] ?? 0));
}
