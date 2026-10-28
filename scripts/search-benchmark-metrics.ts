export interface QueryScore {
  readonly recall1: number;
  readonly recall5: number;
  readonly recall10: number;
  readonly mrr: number;
}

export interface MeasuredQuery extends QueryScore {
  readonly category: string;
  readonly latencyMs: number;
}

export interface MetricSummary extends QueryScore {
  readonly queries: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

// Search returns chunks; evaluate unique conversations in first-occurrence order.
export const scoreQuery = (
  returnedKeys: readonly string[],
  expectedKeys: readonly string[],
): QueryScore => {
  if (expectedKeys.length === 0)
    throw new Error('A benchmark query needs an expected conversation');
  const ranked = [...new Set(returnedKeys)];
  const expected = new Set(expectedKeys);
  const recall = (k: number): number =>
    ranked.slice(0, k).filter((key) => expected.has(key)).length / expected.size;
  const firstRelevant = ranked.findIndex((key) => expected.has(key));
  return {
    recall1: recall(1),
    recall5: recall(5),
    recall10: recall(10),
    mrr: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
  };
};

export const percentile = (values: readonly number[], fraction: number): number => {
  if (values.length === 0) throw new Error('Cannot calculate a percentile from no values');
  if (fraction < 0 || fraction > 1) throw new Error('Percentile must be between 0 and 1');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
};

export const summarize = (queries: readonly MeasuredQuery[]): MetricSummary => {
  if (queries.length === 0) throw new Error('Cannot summarize zero queries');
  const mean = (field: keyof QueryScore): number =>
    queries.reduce((sum, query) => sum + query[field], 0) / queries.length;
  const latencies = queries.map((query) => query.latencyMs);
  return {
    queries: queries.length,
    recall1: mean('recall1'),
    recall5: mean('recall5'),
    recall10: mean('recall10'),
    mrr: mean('mrr'),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
  };
};
