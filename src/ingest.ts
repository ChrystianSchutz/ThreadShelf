import { readdir, readFile } from 'fs/promises';
import { join, relative, resolve } from 'path';
import { parseConversationGroups, detectProvider } from './parser.js';
import { replaceImportedFiles, type ImportedFile } from './store.js';

interface DirEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly fullPath: string;
}

const SKIP_FILES = new Set(
  [
    'users.json',
    'projects.json',
    'user.json',
    'message_feedback.json',
    'shared_conversations.json',
    'sora.json',
    'applet_access_history.json',
  ].map((n) => n.toLowerCase()),
);

// Name-level filter shared with watch mode (which only has a path, no dirent).
export const isExportFileName = (name: string): boolean => {
  const lowerName = name.toLowerCase();
  if (SKIP_FILES.has(lowerName)) return false;
  if (!lowerName.endsWith('.json') && /^file[-_]/.test(lowerName)) return false;
  return lowerName.endsWith('.json') || !name.includes('.');
};

const isPotentialExportFile = (entry: { name: string; isFile: () => boolean }): boolean => {
  return entry.isFile() && isExportFileName(entry.name);
};

const getCanonicalExportKey = (fileName: string): string => {
  const lower = fileName.replace(/\\/g, '/').toLowerCase();
  return lower.endsWith('.json') ? lower.slice(0, -5) : lower;
};

const collectExportEntries = async (folderPath: string): Promise<DirEntry[]> => {
  const entries: DirEntry[] = [];

  const walk = async (currentDir: string): Promise<void> => {
    const dirEntries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (isPotentialExportFile(entry)) {
        entries.push({
          name: entry.name,
          relativePath: relative(folderPath, fullPath),
          fullPath,
        });
      }
    }
  };

  await walk(folderPath);
  return entries;
};

const chooseExportFiles = (entries: DirEntry[]): string[] => {
  const byKey = new Map<string, DirEntry>();

  for (const entry of entries) {
    const key = getCanonicalExportKey(entry.relativePath || entry.name);
    const existing = byKey.get(key);
    const isJson = entry.name.toLowerCase().endsWith('.json');

    if (!existing || (isJson && !existing.name.toLowerCase().endsWith('.json'))) {
      byKey.set(key, entry);
    }
  }

  return [...byKey.values()].map((entry) => entry.fullPath);
};

export const listExportFiles = async (folderPath: string): Promise<string[]> => {
  const resolved = resolve(folderPath);
  const entries = await collectExportEntries(resolved);
  return chooseExportFiles(entries);
};

export interface ProgressEvent {
  readonly status: string;
  readonly phase?: string;
  readonly progressPercent?: number;
  readonly embeddingDone?: number;
  readonly embeddingTotal?: number;
  readonly totalFiles: number;
  readonly processedFiles: number;
  readonly currentFile?: string;
  readonly totalChunks: number;
  readonly totalTokens: number;
  readonly elapsedMs: number;
  readonly errorsCount?: number;
  readonly providers?: Record<string, number>;
}

export interface IngestResult {
  readonly conversations: number;
  readonly ingested: number;
  readonly totalTokens: number;
  readonly files: string[];
  readonly errors: string[];
  readonly skippedFiles?: readonly string[];
  readonly replacementSkipped?: boolean;
  readonly providers: Record<string, number>;
  readonly elapsedMs: number;
}

export interface IngestOptions {
  readonly clearFirst?: boolean;
  readonly onProgress?: (data: ProgressEvent) => void;
  readonly signal?: AbortSignal;
}

export const ingestFolder = async (
  collection: string,
  folderPath: string,
  opts: IngestOptions = {},
): Promise<IngestResult> => {
  const resolved = resolve(folderPath);
  opts.signal?.throwIfAborted();

  let entries: DirEntry[];
  try {
    entries = await collectExportEntries(resolved);
  } catch (e) {
    return {
      conversations: 0,
      ingested: 0,
      totalTokens: 0,
      files: [],
      errors: [`Folder error: ${(e as Error).message}`],
      providers: {},
      elapsedMs: 0,
    };
  }

  const files = chooseExportFiles(entries);

  return ingestFilesInternal(collection, files, opts, opts.clearFirst === true);
};

// Ingest an explicit list of export files (watch mode re-indexes just the
// files that changed). `clearFirst` is intentionally ignored here — clearing
// belongs to whole-folder ingests.
export const ingestFiles = async (
  collection: string,
  files: readonly string[],
  opts: IngestOptions = {},
): Promise<IngestResult> => ingestFilesInternal(collection, files, opts, false);

const ingestFilesInternal = async (
  collection: string,
  files: readonly string[],
  opts: IngestOptions,
  clearFirst: boolean,
): Promise<IngestResult> => {
  const { onProgress = () => {} } = opts;
  opts.signal?.throwIfAborted();
  const errors: string[] = [];
  const totalFiles = files.length;
  let processedFiles = 0;
  let totalChunks = 0;
  let totalTokens = 0;
  let totalConversations = 0;
  const ingestedFiles: string[] = [];
  const stagedFiles: ImportedFile[] = [];
  const skippedFiles: string[] = [];
  const providers: Record<string, number> = {};
  const startTime = Date.now();

  onProgress({
    status: 'starting',
    totalFiles,
    processedFiles: 0,
    totalChunks: 0,
    totalTokens: 0,
    elapsedMs: 0,
  });

  for (const filePath of files) {
    opts.signal?.throwIfAborted();
    try {
      onProgress({
        status: 'progress',
        phase: 'reading',
        totalFiles,
        processedFiles,
        currentFile: filePath,
        totalChunks,
        totalTokens,
        elapsedMs: Date.now() - startTime,
        errorsCount: errors.length,
        providers,
      });

      const raw = await readFile(filePath, 'utf-8');
      opts.signal?.throwIfAborted();

      // Parse once, use for both detection and extraction
      let jsonData: unknown;
      try {
        jsonData = JSON.parse(raw);
      } catch {
        errors.push(`${filePath}: Invalid JSON`);
        processedFiles++;
        continue;
      }

      const provider = detectProvider(jsonData);
      providers[provider] = (providers[provider] || 0) + 1;

      const parsed = parseConversationGroups(jsonData as string | object);

      if (parsed.error) {
        errors.push(`${filePath}: ${parsed.error}`);
        processedFiles++;
        continue;
      }

      if (parsed.conversations.length === 0) {
        skippedFiles.push(filePath);
        processedFiles++;
        continue;
      }

      totalConversations += parsed.conversations.length;

      onProgress({
        status: 'progress',
        phase: clearFirst ? 'reading' : 'embedding',
        progressPercent: clearFirst ? (20 * processedFiles) / Math.max(totalFiles, 1) : undefined,
        totalFiles,
        processedFiles,
        currentFile: filePath,
        totalChunks,
        totalTokens,
        elapsedMs: Date.now() - startTime,
        errorsCount: errors.length,
        providers,
      });

      const imported = { sourceFile: filePath, provider, conversations: parsed.conversations };
      if (clearFirst) stagedFiles.push(imported);
      else {
        const previousTokens = totalTokens;
        totalChunks += await replaceImportedFiles(collection, [imported], {
          signal: opts.signal,
          onEmbeddingProgress: (done, total, tokens) => {
            totalTokens = previousTokens + tokens;
            onProgress({
              status: 'progress',
              phase: 'embedding',
              totalFiles,
              processedFiles,
              currentFile: filePath,
              totalChunks,
              totalTokens,
              elapsedMs: Date.now() - startTime,
              embeddingDone: done,
              embeddingTotal: total,
              progressPercent:
                (95 * (processedFiles + done / Math.max(total, 1))) / Math.max(totalFiles, 1),
            });
          },
        });
        ingestedFiles.push(filePath);
      }
    } catch (e) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      errors.push(`${filePath}: ${(e as Error).message}`);
    }

    processedFiles++;
    onProgress({
      status: 'progress',
      phase: clearFirst ? 'reading' : undefined,
      progressPercent: ((clearFirst ? 20 : 95) * processedFiles) / Math.max(totalFiles, 1),
      totalFiles,
      processedFiles,
      currentFile: filePath,
      totalChunks,
      totalTokens,
      elapsedMs: Date.now() - startTime,
      errorsCount: errors.length,
      providers,
    });
  }

  const replacementSkipped =
    clearFirst && (errors.length > 0 || skippedFiles.length > 0 || stagedFiles.length === 0);
  if (clearFirst && !replacementSkipped) {
    try {
      totalChunks = await replaceImportedFiles(collection, stagedFiles, {
        clearFirst: true,
        signal: opts.signal,
        onEmbeddingProgress: (done, total, tokens) => {
          totalTokens = tokens;
          onProgress({
            status: 'progress',
            phase: 'embedding',
            totalFiles,
            processedFiles,
            totalChunks: done,
            totalTokens,
            elapsedMs: Date.now() - startTime,
            embeddingDone: done,
            embeddingTotal: total,
            progressPercent: 20 + (75 * done) / Math.max(total, 1),
          });
        },
      });
      ingestedFiles.push(...stagedFiles.map((file) => file.sourceFile));
    } catch (error) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      errors.push(`Collection replacement: ${(error as Error).message}`);
    }
  }

  return {
    conversations: replacementSkipped ? 0 : totalConversations,
    ingested: totalChunks,
    totalTokens,
    files: ingestedFiles,
    errors,
    ...(skippedFiles.length ? { skippedFiles } : {}),
    ...(replacementSkipped ? { replacementSkipped: true } : {}),
    providers,
    elapsedMs: Date.now() - startTime,
  };
};
