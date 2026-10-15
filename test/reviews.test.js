import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleReviews } from '../src/reviews.js';

const long = (s) => `${s} `.repeat(10).trim();
const mk = (i, score, extra = {}) => ({ id: i, quote: long(`review number ${i}`), score, date: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`, spoiler: false, ...extra });
const count = (list, b) => list.filter((r) => r.bucket === b).length;

test('spoilers, short texts and duplicates are dropped', () => {
  const items = [mk(1, 9, { spoiler: true }), mk(2, 9, { quote: 'too short' }), mk(3, 9), mk(4, 9, { quote: mk(3, 9).quote.toUpperCase() }), mk(5, 3)];
  const out = sampleReviews(items, { kind: 'users', cap: 40 });
  assert.deepEqual(out.map((r) => r.id).sort(), [3, 5]);
});

test('fewer reviews than the cap are all kept', () => {
  const items = Array.from({ length: 12 }, (_, i) => mk(i, 9));
  assert.equal(sampleReviews(items, { kind: 'users', cap: 40 }).length, 12);
});

test('the sample respects the cap and keeps every bucket represented', () => {
  const items = [
    ...Array.from({ length: 60 }, (_, i) => mk(i, 10)),
    ...Array.from({ length: 10 }, (_, i) => mk(100 + i, 6)),
    ...Array.from({ length: 30 }, (_, i) => mk(200 + i, 1)),
  ];
  const out = sampleReviews(items, { kind: 'users', cap: 20 });
  assert.equal(out.length, 20);
  assert.ok(count(out, 'positive') >= 4 && count(out, 'mixed') >= 4 && count(out, 'negative') >= 4, JSON.stringify([count(out, 'positive'), count(out, 'mixed'), count(out, 'negative')]));
  assert.ok(count(out, 'positive') > count(out, 'mixed'), 'larger buckets get more');
});

test('a bucket smaller than its floor gives back its room to the others', () => {
  const items = [...Array.from({ length: 50 }, (_, i) => mk(i, 10)), mk(900, 1), mk(901, 1)];
  const out = sampleReviews(items, { kind: 'users', cap: 20 });
  assert.equal(out.length, 20);
  assert.equal(count(out, 'negative'), 2);
});

test('within a bucket the newest reviews win', () => {
  const items = Array.from({ length: 10 }, (_, i) => mk(i, 10, { date: `2026-09-${String(10 + i)}` }));
  const out = sampleReviews(items, { kind: 'users', cap: 5 });
  assert.deepEqual(out.map((r) => r.id).sort((a, b) => a - b), [5, 6, 7, 8, 9]);
});

test('critics use a 0-100 scale and users 0-10 for the buckets', () => {
  const critic = sampleReviews([mk(1, 90), mk(2, 60), mk(3, 20)], { kind: 'critics', cap: 40 });
  assert.deepEqual(critic.map((r) => r.bucket).sort(), ['mixed', 'negative', 'positive']);
  const user = sampleReviews([mk(1, 9), mk(2, 6), mk(3, 2)], { kind: 'users', cap: 40 });
  assert.deepEqual(user.map((r) => r.bucket).sort(), ['mixed', 'negative', 'positive']);
});

test('quotes are trimmed to 500 characters', () => {
  const out = sampleReviews([mk(1, 9, { quote: 'x'.repeat(2000) })], { kind: 'users', cap: 5 });
  assert.equal(out[0].quote.length, 500);
});
