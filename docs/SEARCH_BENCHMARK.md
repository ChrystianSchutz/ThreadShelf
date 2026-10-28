# Local search-quality benchmark

`npm run bench:search` measures retrieval quality against a small, wholly synthetic
Anthropic-format export corpus in `benchmarks/search/corpus/`. The companion
`queries.json` gives each query's category and expected `conversationKey` values.
The corpus has 40 conversations and 105 indexed chunks, including three longer
conversations and 23 distractors. The distractors use near-duplicate topics,
shared vocabulary, and misleading titles while answering a different question.
It covers English, Polish, exact identifiers, a rare model label,
thinking turns, and assistant summaries of tool use. The parser intentionally
does not index raw tool-call payloads; the tool-use queries target indexed
assistant summaries.

```bash
npm run bench:search
npm run bench:search -- --check
```

The first run may download the existing multilingual embedding model into
`.benchmark-output/model-cache/`. Later runs reuse that cache. The runner uses a
new operating-system temporary directory for `LANCEDB_PATH`, data, uploads,
and the collection registry, then removes it. It never ingests an existing user
collection. The per-run JSON and local HTML heatmap are
`.benchmark-output/search/latest.json` and `latest.html` (ignored by Git).
Ingest time is reported separately from search latency; the query model
is warmed up before timing.

Each mode receives all 20 queries: semantic, exact-substring keyword, and
semantic with the existing keyword boost. The runner requests up to 100 chunk
hits and ranks **distinct conversations** by their first returned chunk. For a
query, Recall@k is the fraction of its expected conversation keys in the first
`k` unique conversations. MRR is the reciprocal rank of its first relevant
conversation, or zero if none was returned. Category and overall scores are
query averages. p50/p95 latency uses the nearest-rank percentile of wall-clock
query times, including embedding for semantic modes. Latency is informational;
it is not a regression gate and varies by machine and cache state.

The checked-in `benchmarks/search/baseline.json` records the current run's
scores. `--check` verifies that the corpus/query hash and query count match the
baseline, then fails if Recall@5 or MRR falls by more than **0.10 absolute
points** in any mode's overall score or any category. Intentional corpus or
query changes require inspecting the full report and refreshing the baseline:

```bash
npm run bench:search -- --write-baseline
```

The previous 17-conversation baseline gave semantic and keyword-boost Recall@5
of 1.00 and MRR of 0.975 overall. With distractors, semantic has Recall@5 of
0.95 and MRR of about 0.907; the resumable-download answer falls to rank seven.
Keyword search remains at 0.45 Recall@5 and falls from 0.45 to about 0.358 MRR,
because exact identifier matches now compete with nearby mentions. Keyword-boost
has Recall@5 of 0.95 and MRR of about 0.882: a misleading support-ticket label
contains an exact query phrase and outranks the actual cache answer. This is a
measured limitation for later ranking work, not a ranking change in this
benchmark. Keyword search still scores zero
Recall@5 and MRR on paraphrased English, Polish, long-conversation and
cross-topic queries.

The benchmark is kept outside `npm run check` because model setup and cache
state can make the first run take longer than a minute.
