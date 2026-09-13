#!/usr/bin/env tsx
import { basename, resolve } from 'path';
import { ingestFolder } from './ingest.js';
import { watchFolder } from './watch.js';
import { normalizeCollectionName } from './validation.js';
import { recoverPendingIndexes, startIndexRecovery } from './store.js';

const args = process.argv.slice(2);
const clearFirst = args.includes('--clear');
const watchMode = args.includes('--watch');

const readNumberFlag = (name: string, fallback: number): number => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${name} expects a non-negative number of milliseconds`);
    process.exit(1);
  }
  return value;
};

const debounceMs = readNumberFlag('--debounce', 2000);

const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === undefined || arg === '--' || arg === '--clear' || arg === '--watch') continue;
  if (arg === '--debounce') {
    i++;
    continue;
  }
  positional.push(arg);
}

const folder = positional[0];
const collectionArg = positional[1] ?? 'chunks';

if (!folder || positional.length > 2) {
  console.error(
    'Usage: npm run ingest -- <folder> [collection] -- [--clear] [--watch] [--debounce <ms>]',
  );
  process.exit(1);
}

let collection: string;
try {
  collection = normalizeCollectionName(collectionArg);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const startedAt = Date.now();
const resolvedFolder = resolve(folder);
let lastLoggedFile = '';

try {
  const result = await ingestFolder(collection, resolvedFolder, {
    clearFirst,
    onProgress: (event) => {
      const fileLabel = event.currentFile ? basename(event.currentFile) : '';
      if (fileLabel && fileLabel !== lastLoggedFile) {
        lastLoggedFile = fileLabel;
        console.error(`[ingest] ${event.processedFiles}/${event.totalFiles} ${fileLabel}`);
      }
      if (event.status === 'starting') {
        console.error(`[ingest] collection=${collection} folder=${resolvedFolder}`);
      }
    },
  });
  await recoverPendingIndexes({ collection });

  console.error(
    `[ingest] done files=${result.files.length} chunks=${result.ingested} errors=${result.errors.length} elapsedMs=${Date.now() - startedAt}`,
  );
  console.log(JSON.stringify({ collection, ...result }, null, 2));

  if (!watchMode) {
    process.exit(result.errors.length > 0 ? 2 : 0);
  }

  const stopRecovery = startIndexRecovery();
  const watcher = watchFolder(collection, resolvedFolder, {
    debounceMs,
    onBatch: (files, batchResult, error) => {
      if (error) {
        console.error(`[watch] re-index failed: ${error.message}`);
        return;
      }
      const names = files.map((file) => basename(file)).join(', ');
      console.error(
        `[watch] re-indexed ${files.length} file(s) (${names}) chunks=${batchResult?.ingested ?? 0} errors=${batchResult?.errors.length ?? 0}`,
      );
    },
  });

  console.error(`[watch] watching ${resolvedFolder} (debounce ${debounceMs}ms) — Ctrl+C to stop`);

  const shutdown = async () => {
    stopRecovery();
    console.error('[watch] stopping…');
    await watcher.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (e) {
  console.error(`[ingest] failed: ${(e as Error).message}`);
  process.exit(1);
}
