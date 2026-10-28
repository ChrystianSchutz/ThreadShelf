import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { renderHeatmap } from './search-benchmark-html.js';
import {
  scoreQuery,
  summarize,
  type MeasuredQuery,
  type MetricSummary,
} from './search-benchmark-metrics.js';

interface BenchmarkQuery {
  readonly id: string;
  readonly category: string;
  readonly query: string;
  readonly expectedConversationKeys: string[];
  readonly roles?: string[];
  readonly model?: string;
}

interface QueryResult extends MeasuredQuery {
  readonly id: string;
  readonly query: string;
  readonly expectedConversationKeys: readonly string[];
  readonly returnedConversationKeys: readonly string[];
}

interface ModeReport {
  readonly overall: MetricSummary;
  readonly categories: Record<string, MetricSummary>;
  readonly queries: QueryResult[];
}

interface Baseline {
  readonly schemaVersion: 1;
  readonly corpusSha256: string;
  readonly queryCount: number;
  readonly tolerance: number;
  readonly modes: Record<string, Pick<ModeReport, 'overall' | 'categories'>>;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const benchmarkDir = join(root, 'benchmarks', 'search');
const corpusDir = join(benchmarkDir, 'corpus');
const outputDir = join(root, '.benchmark-output', 'search');
const baselinePath = join(benchmarkDir, 'baseline.json');
const collection = 'search_benchmark';
const tolerance = 0.1; // Absolute metric points, applied to every mode and category.
const modes = ['semantic', 'keyword', 'keyword-boost'] as const;

const round = (value: number): number => Number(value.toFixed(4));
const sha256 = (parts: readonly string[]): string =>
  createHash('sha256').update(parts.join('\n')).digest('hex');

const readCorpus = async (): Promise<{ queries: BenchmarkQuery[]; digest: string }> => {
  const files = (await readdir(corpusDir)).filter((name) => name.endsWith('.json')).sort();
  if (files.length === 0) throw new Error('The benchmark corpus is empty');
  const queryText = await readFile(join(benchmarkDir, 'queries.json'), 'utf8');
  const queries = JSON.parse(queryText) as BenchmarkQuery[];
  if (!Array.isArray(queries) || queries.length === 0) throw new Error('No benchmark queries');
  const ids = new Set<string>();
  const keys = new Set<string>();
  const { parseConversationGroups } = await import('../src/parser.js');
  const digestParts = [queryText];
  for (const name of files) {
    const contents = await readFile(join(corpusDir, name), 'utf8');
    digestParts.push(name, contents);
    const parsed = parseConversationGroups(contents);
    if (parsed.error || parsed.conversations.length === 0) {
      throw new Error(`Invalid corpus file ${name}: ${parsed.error ?? 'no conversations'}`);
    }
    for (const conversation of parsed.conversations) {
      if (keys.has(conversation.key))
        throw new Error(`Duplicate conversation key: ${conversation.key}`);
      keys.add(conversation.key);
    }
  }
  for (const entry of queries) {
    if (!entry.id || !entry.category || !entry.query || !entry.expectedConversationKeys?.length) {
      throw new Error('Every query needs an id, category, text, and expected conversation keys');
    }
    if (ids.has(entry.id)) throw new Error(`Duplicate query id: ${entry.id}`);
    ids.add(entry.id);
    for (const key of entry.expectedConversationKeys) {
      if (!keys.has(key)) throw new Error(`Query ${entry.id} expects missing conversation ${key}`);
    }
  }
  return { queries, digest: sha256(digestParts) };
};

const reportMode = (results: QueryResult[]): ModeReport => {
  const categories: Record<string, MetricSummary> = {};
  for (const category of [...new Set(results.map((row) => row.category))].sort()) {
    categories[category] = summarize(results.filter((row) => row.category === category));
  }
  return { overall: summarize(results), categories, queries: results };
};

const baselineFrom = (
  reports: Record<string, ModeReport>,
  digest: string,
  count: number,
): Baseline => ({
  schemaVersion: 1,
  corpusSha256: digest,
  queryCount: count,
  tolerance,
  modes: Object.fromEntries(
    Object.entries(reports).map(([mode, report]) => [
      mode,
      {
        overall: report.overall,
        categories: report.categories,
      },
    ]),
  ),
});

const checkBaseline = (baseline: Baseline, current: Baseline): string[] => {
  if (
    baseline.schemaVersion !== 1 ||
    baseline.corpusSha256 !== current.corpusSha256 ||
    baseline.queryCount !== current.queryCount ||
    baseline.tolerance !== tolerance
  ) {
    return ['Baseline corpus or query set differs; review the data and run --write-baseline.'];
  }
  const failures: string[] = [];
  for (const mode of modes) {
    const oldMode = baseline.modes[mode];
    const newMode = current.modes[mode];
    if (!oldMode || !newMode) {
      failures.push(`Missing mode ${mode} in baseline or current run`);
      continue;
    }
    const pairs: [string, MetricSummary | undefined, MetricSummary | undefined][] = [
      ['overall', oldMode.overall, newMode.overall],
      ...Object.keys(newMode.categories).map(
        (category) =>
          [category, oldMode.categories[category], newMode.categories[category]] as [
            string,
            MetricSummary | undefined,
            MetricSummary | undefined,
          ],
      ),
    ];
    for (const [category, oldMetrics, newMetrics] of pairs) {
      if (!oldMetrics || !newMetrics || oldMetrics.queries !== newMetrics.queries) {
        failures.push(`${mode}/${category}: missing or changed query count`);
        continue;
      }
      for (const metric of ['recall5', 'mrr'] as const) {
        if (newMetrics[metric] + tolerance + 1e-9 < oldMetrics[metric]) {
          failures.push(
            `${mode}/${category} ${metric}: ${round(newMetrics[metric])} < ${round(oldMetrics[metric])} - ${tolerance}`,
          );
        }
      }
    }
  }
  return failures;
};

const printTable = (reports: Record<string, ModeReport>): void => {
  const rows = Object.entries(reports).flatMap(([mode, report]) => [
    { mode, category: 'ALL', ...report.overall },
    ...Object.entries(report.categories).map(([category, metrics]) => ({
      mode,
      category,
      ...metrics,
    })),
  ]);
  console.table(
    rows.map((row) => ({
      mode: row.mode,
      category: row.category,
      queries: row.queries,
      'Recall@1': round(row.recall1),
      'Recall@5': round(row.recall5),
      'Recall@10': round(row.recall10),
      MRR: round(row.mrr),
      'p50 ms': Math.round(row.p50Ms),
      'p95 ms': Math.round(row.p95Ms),
    })),
  );
};

const run = async (): Promise<void> => {
  const args = new Set(process.argv.slice(2));
  if (
    [...args].some((arg) => !['--check', '--write-baseline'].includes(arg)) ||
    (args.has('--check') && args.has('--write-baseline'))
  ) {
    throw new Error('Usage: npm run bench:search -- [--check | --write-baseline]');
  }
  const { queries, digest } = await readCorpus();
  const temp = await mkdtemp(join(tmpdir(), 'threadshelf-search-bench-'));
  try {
    // store.ts captures LANCEDB_PATH at import time. Set every state path first.
    process.env.LANCEDB_PATH = join(temp, 'lancedb');
    process.env.THREADSHELF_DATA_DIR = temp;
    process.env.COLLECTIONS_PATH = join(temp, 'collections.json');
    process.env.UPLOADS_DIR = join(temp, 'uploads');
    process.env.THREADSHELF_MODEL_CACHE = join(root, '.benchmark-output', 'model-cache');
    const [{ ingestFolder }, { searchAcrossCollections }, { embedOne }] = await Promise.all([
      import('../src/ingest.js'),
      import('../src/services/search.js'),
      import('../src/embedding.js'),
    ]);
    console.log(
      `Ingesting ${queries.length} queries' synthetic corpus into an isolated database...`,
    );
    const ingest = await ingestFolder(collection, corpusDir);
    if (ingest.errors.length || ingest.skippedFiles?.length || ingest.conversations === 0) {
      throw new Error(
        `Benchmark ingest failed: ${JSON.stringify({ errors: ingest.errors, skipped: ingest.skippedFiles })}`,
      );
    }
    console.log(
      `Indexed ${ingest.conversations} conversations and ${ingest.ingested} chunks in ${ingest.elapsedMs} ms.`,
    );
    await embedOne('benchmark warmup');
    const reports: Record<string, ModeReport> = {};
    for (const mode of modes) {
      const results: QueryResult[] = [];
      for (const entry of queries) {
        const started = performance.now();
        const rows = await searchAcrossCollections(entry.query, collection, {
          n: 100,
          mode: mode === 'keyword' ? 'keyword' : 'semantic',
          keywordBoost: mode === 'keyword-boost',
          roles: entry.roles,
          model: entry.model,
        });
        const latencyMs = performance.now() - started;
        const rankedKeys = [
          ...new Set(
            rows.map((row) => row.metadata.conversationKey).filter((key): key is string => !!key),
          ),
        ];
        results.push({
          id: entry.id,
          category: entry.category,
          query: entry.query,
          expectedConversationKeys: entry.expectedConversationKeys,
          returnedConversationKeys: rankedKeys.slice(0, 10),
          latencyMs: round(latencyMs),
          ...scoreQuery(rankedKeys, entry.expectedConversationKeys),
        });
      }
      reports[mode] = reportMode(results);
    }
    const current = baselineFrom(reports, digest, queries.length);
    await mkdir(outputDir, { recursive: true });
    const outputPath = join(outputDir, 'latest.json');
    const htmlPath = join(outputDir, 'latest.html');
    await writeFile(
      outputPath,
      `${JSON.stringify(
        {
          ...current,
          generatedAt: new Date().toISOString(),
          ingestion: {
            conversations: ingest.conversations,
            chunks: ingest.ingested,
            elapsedMs: ingest.elapsedMs,
          },
          reports,
        },
        null,
        2,
      )}\n`,
    );
    printTable(reports);
    console.log(`Detailed results: ${outputPath}`);
    const html = renderHeatmap(reports, ingest.conversations);
    let writtenHtmlPath = htmlPath;
    try {
      await writeFile(htmlPath, html);
    } catch (error) {
      // Windows can deny replacement while the previous report is open in a browser.
      if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      writtenHtmlPath = join(outputDir, `report-${Date.now()}.html`);
      await writeFile(writtenHtmlPath, html);
    }
    console.log(`Heatmap report: ${writtenHtmlPath}`);
    if (args.has('--write-baseline')) {
      await writeFile(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
      console.log(`Baseline written: ${baselinePath}`);
    }
    if (args.has('--check')) {
      const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Baseline;
      const failures = checkBaseline(baseline, current);
      if (failures.length) throw new Error(`Search quality regression:\n${failures.join('\n')}`);
      console.log(`Baseline check passed (maximum allowed drop: ${baseline.tolerance} points).`);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
};

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
