import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, scoreQuery, summarize } from '../scripts/search-benchmark-metrics.js';

test('scores unique conversations rather than repeated chunks', () => {
  assert.deepEqual(scoreQuery(['wrong', 'wrong', 'target', 'other'], ['target']), {
    recall1: 0,
    recall5: 1,
    recall10: 1,
    mrr: 0.5,
  });
  assert.deepEqual(scoreQuery(['a', 'b'], ['a', 'c']), {
    recall1: 0.5,
    recall5: 0.5,
    recall10: 0.5,
    mrr: 1,
  });
  assert.equal(scoreQuery(['wrong'], ['target']).mrr, 0);
  assert.throws(() => scoreQuery([], []), /expected conversation/);
});

test('summarizes relevance and nearest-rank latency percentiles', () => {
  const rows = [
    { category: 'example', latencyMs: 5, ...scoreQuery(['a'], ['a']) },
    { category: 'example', latencyMs: 15, ...scoreQuery(['x', 'b'], ['b']) },
    { category: 'example', latencyMs: 100, ...scoreQuery([], ['c']) },
  ];
  const summary = summarize(rows);
  assert.equal(summary.queries, 3);
  assert.equal(summary.recall1, 1 / 3);
  assert.equal(summary.recall5, 2 / 3);
  assert.equal(summary.mrr, 0.5);
  assert.equal(summary.p50Ms, 15);
  assert.equal(summary.p95Ms, 100);
  assert.equal(percentile([100, 5, 15], 0.95), 100);
  assert.throws(() => summarize([]), /zero queries/);
});
