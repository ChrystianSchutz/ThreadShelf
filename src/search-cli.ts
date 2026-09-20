#!/usr/bin/env tsx
import { invocation } from './paths.js';
import { searchAcrossCollections } from './services/search.js';
import { recoverPendingIndexes } from './store.js';
import {
  normalizeCollectionSelector,
  normalizeCount,
  normalizeDateRange,
  normalizeOptionalString,
  normalizeQuery,
  normalizeRoles,
  normalizeSearchMode,
} from './validation.js';

const USAGE = `Usage: ${invocation('search')} "<query>" -- [options]

Options:
  --collection <name>   Collection to search, or "all" (default: all)
  --mode <mode>         "semantic" (default) or "keyword" (exact substring)
  --roles <list>        Comma list of user,thinking,ai
  --model <text>        Only results whose model contains this text
  --from <date>         Inclusive ISO/YYYY-MM-DD lower bound
  --to <date>           Inclusive ISO/YYYY-MM-DD upper bound
  --n <count>           Max results, 1-50 (default: 10)
  --json                Print raw JSON instead of readable output`;

const args = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
let json = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === '--') {
    continue;
  } else if (arg === '--json') {
    json = true;
  } else if (arg.startsWith('--')) {
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      console.error(`Missing value for ${arg}\n\n${USAGE}`);
      process.exit(1);
    }
    flags.set(arg.slice(2), value);
    i++;
  } else {
    positional.push(arg);
  }
}

if (positional.length !== 1) {
  console.error(USAGE);
  process.exit(1);
}

try {
  const query = normalizeQuery(positional[0], { field: 'query' });
  const collection = normalizeCollectionSelector(flags.get('collection'), {
    defaultValue: 'all',
  });
  const mode = normalizeSearchMode(flags.get('mode'));
  const roles = normalizeRoles(flags.get('roles'));
  const model = normalizeOptionalString(flags.get('model'), { field: 'model' });
  const { from, to } = normalizeDateRange(flags.get('from'), flags.get('to'));
  const n = normalizeCount(flags.get('n'), { defaultValue: 10 });

  await recoverPendingIndexes({ collection });
  const results = await searchAcrossCollections(query, collection, {
    n,
    mode,
    roles: roles ?? undefined,
    model,
    from,
    to,
    keywordBoost: mode === 'semantic',
  });

  if (json) {
    console.log(JSON.stringify({ query, collection, mode, results }, null, 2));
    process.exit(0);
  }

  if (results.length === 0) {
    console.log(`No results for "${query}" in ${collection}.`);
    process.exit(0);
  }

  for (const [index, result] of results.entries()) {
    const meta = result.metadata;
    const score = result.distance != null ? ` score=${(1 - result.distance).toFixed(3)}` : '';
    const modelLabel = meta.model ? ` model=${meta.model}` : '';
    const dateLabel = meta.createdAt ? ` date=${meta.createdAt.slice(0, 10)}` : '';
    const collectionLabel = meta.collection ? `${meta.collection} · ` : '';
    const snippet = result.document.replace(/\s+/g, ' ').trim();
    const preview = snippet.length > 240 ? `${snippet.slice(0, 237)}...` : snippet;

    console.log(`${index + 1}. [${meta.role}]${score}${modelLabel}${dateLabel}`);
    console.log(`   ${collectionLabel}${meta.sourceFile}`);
    if (meta.title) console.log(`   "${meta.title}"`);
    console.log(`   ${preview}`);
    console.log('');
  }
  process.exit(0);
} catch (e) {
  console.error(`[search] ${(e as Error).message}`);
  process.exit(1);
}
