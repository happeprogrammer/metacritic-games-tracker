// One batch: choose games, fetch and save each. Run bookkeeping (runs, run_items, events) hooks in from the scheduler.
import { pickBatch } from './selection.js';
import { fetchGame, persistGame } from './pipeline.js';

/**
 * hooks (all optional): onPicked(batch), onStart(item), onDone(item, info), onFail(item, err), onWarn(msg), shouldStop().
 * dryRun only reports what would be taken. One failing game never stops the others.
 */
export async function collectBatch({ db, client, settings, day, n, now = () => new Date(), hooks = {}, dryRun = false }) {
  const batch = await pickBatch({
    db, day, n,
    maxPages: settings.max_finder_pages_per_day,
    persist: !dryRun,
    newReleases: async () => {
      try {
        const slugs = await client.newReleases();
        if (slugs.length === 0) throw new Error('блок New Releases не найден на странице');
        return slugs;
      } catch (e) {
        hooks.onWarn?.(`New Releases недоступен, берём ленту: ${e.message}`);
        return null;
      }
    },
    finderPage: (offset, limit) => client.finderPage(offset, limit),
  });
  hooks.onPicked?.(batch);
  if (dryRun) return { picked: batch, results: [] };

  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < batch.length && !hooks.shouldStop?.()) {
      const item = batch[next++];
      hooks.onStart?.(item);
      try {
        const data = await fetchGame(client, item.slug, settings);
        const info = persistGame(db, data, { day, now, source: item.source === 'retry' ? 'finder' : item.source,
          sample: { critic: settings.review_sample_critic, user: settings.review_sample_user } });
        results.push({ slug: item.slug, ok: true, ...info });
        hooks.onDone?.(item, info);
      } catch (err) {
        results.push({ slug: item.slug, ok: false, error: `${err.kind ?? 'error'}: ${err.message}` });
        hooks.onFail?.(item, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(settings.fetch_concurrency, batch.length) }, worker));
  return { picked: batch, results };
}
