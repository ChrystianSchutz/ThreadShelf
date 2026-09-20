import { connect, type Connection, type Table } from '@lancedb/lancedb';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { embed, embedOne } from './embedding.js';
import { chunkTurns, isIndexableText } from './chunking.js';
import { validateTurns } from './validation.js';
import type { Provider } from './parser.js';
import { createHash } from 'node:crypto';
import { portableModelLabel } from './model-label.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.LANCEDB_PATH || join(__dirname, '..', '.lancedb');
const EMBED_BATCH_SIZE = Math.max(1, Number(process.env.EMBED_BATCH_SIZE) || 25);

let db: Connection | null = null;
const tableCache = new Map<string, Table>();
const collectionWriteLocks = new Map<string, Promise<void>>();
const COLLECTION_STATS_CACHE_MS = 5_000;
const collectionStatsCache = new Map<
  string,
  { readonly expiresAt: number; readonly value: Promise<CollectionStats> }
>();

const invalidateCollectionStats = (collection: string): void => {
  collectionStatsCache.delete(collection);
};

const getDb = async (): Promise<Connection> => {
  if (!db) {
    try {
      // Server, MCP and CLI share one database. Cached table handles must see
      // each other's commits (pending index jobs, retry times, deletions).
      db = await connect(DB_PATH, { readConsistencyInterval: 0 });
    } catch (e) {
      const err = new Error((e as Error)?.message || 'LanceDB connect failed');
      err.cause = e;
      throw err;
    }
  }
  return db;
};

const openTable = async (collection: string): Promise<Table | null> => {
  const cached = tableCache.get(collection);
  if (cached) return cached;

  const database = await getDb();
  const names = await database.tableNames();
  if (!names.includes(collection)) return null;

  const opened = await database.openTable(collection);
  tableCache.set(collection, opened);
  return opened;
};

const escapeSqlString = (value: string): string => value.replace(/'/g, "''");

export interface ChunkRow {
  readonly id: string;
  readonly text: string;
  readonly sourceFile: string;
  readonly provider: string;
  readonly role: string;
  readonly turnIndex: number;
  readonly conversationKey?: string;
  readonly title?: string;
  readonly model?: string;
  readonly createdAt?: string;
  readonly createdInThreadShelf?: boolean;
  readonly generationProvider?: string;
}

interface ChunkWriteOptions {
  readonly signal?: AbortSignal;
  readonly onEmbeddingProgress?: (
    done: number,
    total: number,
    tokens: number,
  ) => void | Promise<void>;
}

interface EmbeddedChunkRow extends Record<string, unknown> {
  readonly id: string;
  readonly vector: number[];
  readonly document: string;
  readonly sourceFile: string;
  readonly provider: string;
  readonly conversationKey: string;
  readonly title: string;
  readonly role: string;
  readonly turnIndex: string;
  readonly model: string;
  readonly createdAt: string;
  readonly createdInThreadShelf: boolean;
  readonly generationProvider: string;
}

const ensureChunkMetadataSchema = async (tbl: Table): Promise<void> => {
  const schema = await tbl.schema();
  const existing = new Set(schema.fields.map((field) => field.name));
  const missing = [
    ...['provider', 'conversationKey', 'title', 'model', 'createdAt', 'generationProvider'].map(
      (name) => ({ name, valueSql: "''" }),
    ),
    { name: 'createdInThreadShelf', valueSql: 'false' },
  ].filter((column) => !existing.has(column.name));
  if (missing.length) await tbl.addColumns(missing);
};

// A merge is one LanceDB commit: an insertion failure cannot expose a delete.
const replaceEmbeddedRowsLocked = async (
  collection: string,
  where: string,
  rows: EmbeddedChunkRow[],
): Promise<void> => {
  const tbl = await openTable(collection);
  if (tbl) {
    await ensureChunkMetadataSchema(tbl);
    if (!rows.length) await tbl.delete(where);
    else
      await tbl
        .mergeInsert('id')
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .whenNotMatchedBySourceDelete({ where })
        .execute(rows);
  } else if (rows.length) {
    const created = await (await getDb()).createTable(collection, rows, { mode: 'create' });
    tableCache.set(collection, created);
  }
  invalidateCollectionStats(collection);
};

const embedChunks = async (
  chunks: ChunkRow[],
  signal?: AbortSignal,
  onProgress?: ChunkWriteOptions['onEmbeddingProgress'],
): Promise<EmbeddedChunkRow[]> => {
  const tokens = chunks.reduce((sum, chunk) => sum + Math.ceil(chunk.text.length / 4), 0);
  await onProgress?.(0, chunks.length, tokens);
  if (chunks.length === 0) return [];
  const rows: EmbeddedChunkRow[] = [];

  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    signal?.throwIfAborted();
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map((ch) => ch.text);
    const embeddings = await embed(texts);
    signal?.throwIfAborted();
    rows.push(
      ...batch.map((ch, j) => ({
        id: ch.id,
        vector: embeddings[j]!,
        document: ch.text,
        sourceFile: ch.sourceFile,
        provider: ch.provider,
        conversationKey: ch.conversationKey ?? '',
        title: ch.title ?? '',
        role: ch.role,
        turnIndex: String(ch.turnIndex),
        model: ch.model ?? '',
        createdAt: ch.createdAt ?? '',
        createdInThreadShelf: ch.createdInThreadShelf ?? false,
        generationProvider: ch.generationProvider ?? '',
      })),
    );
    await onProgress?.(rows.length, chunks.length, tokens);
  }
  return rows;
};

// --- Stored threads ---
//
// Normalized conversation turns are persisted at ingest time in a single
// internal table so the thread view no longer depends on the original export
// file staying in place (or unchanged — LM Studio rewrites its files). User
// collection names can never start with an underscore (normalizeCollectionName
// strips them), so the "__" prefix is reserved for internal tables.

const THREADS_TABLE = '__threads';

export interface ThreadConversationInput {
  readonly key: string;
  readonly title: string;
  readonly turns: readonly unknown[];
  readonly createdInThreadShelf?: boolean;
  readonly threadCreatedAt?: string;
}

export interface StoredThreadRow {
  readonly collection: string;
  readonly sourceFile: string;
  readonly conversationKey: string;
  readonly title: string;
  readonly provider: string;
  readonly ordinal: number;
  readonly turnCount: number;
  readonly turnsJson: string;
  readonly ingestedAt: string;
  readonly lastTurnAt: string;
  readonly lastModel: string;
  readonly createdInThreadShelf: boolean;
  readonly threadCreatedAt: string;
  readonly hasThreadShelfTurns: boolean;
  readonly indexPending: string;
}

export interface ThreadSummaryRow {
  readonly sourceFile: string;
  readonly conversationKey: string;
  readonly title: string;
  readonly provider: string;
  readonly ordinal: number;
  readonly turnCount: number;
  readonly lastTurnAt: string;
  readonly lastModel: string;
  readonly createdInThreadShelf: boolean;
  readonly threadCreatedAt: string;
  readonly hasThreadShelfTurns: boolean;
}

export class StoredThreadWriteError extends Error {
  constructor(message = 'Stored thread changed or disappeared before it could be saved') {
    super(message);
    this.name = 'StoredThreadWriteError';
  }
}

const storedThreadRow = (row: Record<string, unknown>): StoredThreadRow => ({
  collection: (row.collection as string) ?? '',
  sourceFile: (row.sourceFile as string) ?? '',
  conversationKey: (row.conversationKey as string) ?? '',
  title: (row.title as string) ?? '',
  provider: (row.provider as string) ?? '',
  ordinal: Number(row.ordinal) || 0,
  turnCount: Number(row.turnCount) || 0,
  turnsJson: (row.turnsJson as string) ?? '',
  ingestedAt: (row.ingestedAt as string) ?? '',
  lastTurnAt: (row.lastTurnAt as string) ?? '',
  lastModel: (row.lastModel as string) ?? '',
  createdInThreadShelf: Boolean(row.createdInThreadShelf),
  threadCreatedAt: (row.threadCreatedAt as string) ?? '',
  hasThreadShelfTurns: Boolean(row.hasThreadShelfTurns || row.createdInThreadShelf),
  indexPending: String(row.indexPending || ''),
});

// Latest turn timestamp in a conversation — powers "sort by recent" in the
// browse list without re-reading turnsJson at query time.
const latestTurnTimestamp = (turns: readonly unknown[]): string => {
  let latest = '';
  for (const turn of turns) {
    const createdAt = (turn as { createdAt?: unknown })?.createdAt;
    if (typeof createdAt === 'string' && createdAt > latest) latest = createdAt;
  }
  return latest;
};

const latestTurnModel = (turns: readonly unknown[]): string => {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const model = (turns[index] as { model?: unknown })?.model;
    if (typeof model === 'string' && model.trim()) return model.trim();
  }
  return '';
};

let threadsSchemaMigration: Promise<void> | null = null;

// Schema upgrades on the request path must remain additive and bounded. In
// particular, do not backfill metadata by materializing turnsJson for every
// archived conversation: large databases would make the first request appear
// empty or hung. Existing rows use their normal ingestedAt fallbacks and gain
// the metadata naturally the next time they are written.
const migrateThreadsSchema = async (tbl: Table): Promise<void> => {
  let schema = await tbl.schema();
  if (!schema.fields.some((field) => field.name === 'lastTurnAt')) {
    try {
      await tbl.addColumns([{ name: 'lastTurnAt', valueSql: "''" }]);
    } catch (e) {
      // Another process may have added the column concurrently.
      const refreshed = await tbl.schema();
      if (!refreshed.fields.some((field) => field.name === 'lastTurnAt')) throw e;
    }
  }

  schema = await tbl.schema();
  const metadataColumns = [
    { name: 'createdInThreadShelf', valueSql: 'false' },
    { name: 'threadCreatedAt', valueSql: "''" },
    { name: 'hasThreadShelfTurns', valueSql: 'false' },
    { name: 'lastModel', valueSql: "''" },
    { name: 'indexPending', valueSql: "''" },
    { name: 'indexAttempts', valueSql: '0.0' },
    { name: 'indexRetryAt', valueSql: '0.0' },
    { name: 'indexError', valueSql: "''" },
  ].filter((column) => !schema.fields.some((field) => field.name === column.name));
  if (metadataColumns.length) {
    try {
      await tbl.addColumns(metadataColumns);
    } catch (e) {
      // A second server/watch process may have performed the same additive
      // migration between our schema read and this write.
      const refreshed = await tbl.schema();
      if (metadataColumns.some((column) => !refreshed.fields.some((f) => f.name === column.name))) {
        throw e;
      }
    }
  }
};

const ensureThreadsSchema = async (tbl: Table): Promise<void> => {
  if (!threadsSchemaMigration) {
    threadsSchemaMigration = migrateThreadsSchema(tbl).catch((error) => {
      threadsSchemaMigration = null;
      throw error;
    });
  }
  await threadsSchemaMigration;
};

export const replaceThreadsForFile = async (
  collection: string,
  sourceFile: string,
  provider: string,
  conversations: readonly ThreadConversationInput[],
): Promise<void> => {
  return withCollectionWriteLock(THREADS_TABLE, async () => {
    const rows = threadRows(collection, sourceFile, provider, conversations, 'local');
    await replaceThreadRowsLocked(threadFileFilter(collection, sourceFile), rows);
    invalidateCollectionStats(collection);
  });
};

const threadFileFilter = (collection: string, sourceFile: string): string =>
  `collection = '${escapeSqlString(collection)}' AND sourceFile = '${escapeSqlString(sourceFile)}'`;

const threadRows = (
  collection: string,
  sourceFile: string,
  provider: string,
  conversations: readonly ThreadConversationInput[],
  indexPending: string,
): Record<string, unknown>[] => {
  const ingestedAt = new Date().toISOString();
  return conversations.map((conversation, ordinal) => ({
    collection,
    sourceFile,
    conversationKey: conversation.key ?? '',
    title: conversation.title ?? '',
    provider,
    ordinal,
    turnCount: conversation.turns.length,
    turnsJson: JSON.stringify(conversation.turns),
    ingestedAt,
    lastTurnAt: latestTurnTimestamp(conversation.turns),
    lastModel: latestTurnModel(conversation.turns),
    createdInThreadShelf: conversation.createdInThreadShelf ?? false,
    threadCreatedAt: conversation.threadCreatedAt ?? '',
    indexPending,
    indexAttempts: 0,
    indexRetryAt: 0,
    indexError: '',
    hasThreadShelfTurns:
      conversation.createdInThreadShelf === true ||
      conversation.turns.some(
        (turn) => (turn as { createdInThreadShelf?: unknown })?.createdInThreadShelf === true,
      ),
  }));
};

const replaceThreadRowsLocked = async (
  where: string,
  rows: Record<string, unknown>[],
): Promise<void> => {
  const tbl = await openTable(THREADS_TABLE);
  if (tbl) {
    await ensureThreadsSchema(tbl);
    // Tombstones are durable deletion jobs. They contain no conversation text.
    const oldRows = await tbl.query().where(where).limit(Number.MAX_SAFE_INTEGER).toArray();
    const keys = new Set(
      rows.map((row) => JSON.stringify([row.collection, row.sourceFile, row.conversationKey])),
    );
    const tombstones = oldRows
      .filter(
        (row) => !keys.has(JSON.stringify([row.collection, row.sourceFile, row.conversationKey])),
      )
      .map((row) => ({
        ...row,
        title: '',
        turnsJson: '[]',
        lastModel: '',
        turnCount: 0,
        indexPending: 'delete',
      }));
    const next = [...rows, ...tombstones];
    if (next.length)
      await tbl
        .mergeInsert(['collection', 'sourceFile', 'conversationKey'])
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .whenNotMatchedBySourceDelete({ where })
        .execute(next);
  } else if (rows.length) {
    const database = await getDb();
    const created = await database.createTable(THREADS_TABLE, rows, { mode: 'create' });
    tableCache.set(THREADS_TABLE, created);
  }
};

export const updateStoredThread = async (
  collection: string,
  sourceFile: string,
  provider: string,
  conversation: ThreadConversationInput,
): Promise<void> => {
  return withCollectionWriteLock(THREADS_TABLE, async () => {
    const tbl = await openTable(THREADS_TABLE);
    if (!tbl) throw new Error('Stored thread table is unavailable');
    await ensureThreadsSchema(tbl);
    const ingestedAt = new Date().toISOString();
    const where = [
      `collection = '${escapeSqlString(collection)}'`,
      `sourceFile = '${escapeSqlString(sourceFile)}'`,
      `conversationKey = '${escapeSqlString(conversation.key)}'`,
      "indexPending != 'delete'",
    ].join(' AND ');
    const current = await tbl.query().where(where).limit(1).toArray();
    const result = await tbl.update({
      where,
      values: {
        title: conversation.title,
        provider,
        turnCount: conversation.turns.length,
        turnsJson: JSON.stringify(conversation.turns),
        ingestedAt,
        indexPending: current[0]?.indexPending === 'all' ? 'all' : 'local',
        indexAttempts: 0,
        indexRetryAt: 0,
        indexError: '',
        lastTurnAt: latestTurnTimestamp(conversation.turns),
        lastModel: latestTurnModel(conversation.turns),
        createdInThreadShelf: conversation.createdInThreadShelf ?? false,
        threadCreatedAt: conversation.threadCreatedAt ?? '',
        hasThreadShelfTurns:
          conversation.createdInThreadShelf === true ||
          conversation.turns.some(
            (turn) => (turn as { createdInThreadShelf?: unknown })?.createdInThreadShelf === true,
          ),
      },
    });
    if (result.rowsUpdated !== 1) throw new StoredThreadWriteError();
    invalidateCollectionStats(collection);
  });
};

export const updateStoredThreadFromCurrent = async (
  collection: string,
  sourceFile: string,
  conversationKey: string,
  update: (current: StoredThreadRow) => {
    readonly provider: string;
    readonly conversation: ThreadConversationInput;
  },
): Promise<ThreadConversationInput> => {
  return withCollectionWriteLock(THREADS_TABLE, async () => {
    const tbl = await openTable(THREADS_TABLE);
    if (!tbl) throw new StoredThreadWriteError('Stored thread table is unavailable');
    await ensureThreadsSchema(tbl);
    const where = [
      `collection = '${escapeSqlString(collection)}'`,
      `sourceFile = '${escapeSqlString(sourceFile)}'`,
      `conversationKey = '${escapeSqlString(conversationKey)}'`,
      "indexPending != 'delete'",
    ].join(' AND ');
    const rows = await tbl.query().where(where).limit(2).toArray();
    if (rows.length !== 1) throw new StoredThreadWriteError();
    const next = update(storedThreadRow(rows[0] as Record<string, unknown>));
    const conversation = next.conversation;
    const result = await tbl.update({
      where,
      values: {
        title: conversation.title,
        provider: next.provider,
        turnCount: conversation.turns.length,
        turnsJson: JSON.stringify(conversation.turns),
        ingestedAt: new Date().toISOString(),
        indexPending: rows[0].indexPending === 'all' ? 'all' : 'local',
        indexAttempts: 0,
        indexRetryAt: 0,
        indexError: '',
        lastTurnAt: latestTurnTimestamp(conversation.turns),
        lastModel: latestTurnModel(conversation.turns),
        createdInThreadShelf: conversation.createdInThreadShelf ?? false,
        threadCreatedAt: conversation.threadCreatedAt ?? '',
        hasThreadShelfTurns:
          conversation.createdInThreadShelf === true ||
          conversation.turns.some(
            (turn) => (turn as { createdInThreadShelf?: unknown })?.createdInThreadShelf === true,
          ),
      },
    });
    if (result.rowsUpdated !== 1) throw new StoredThreadWriteError();
    invalidateCollectionStats(collection);
    return conversation;
  });
};

export const getStoredThreads = async (
  collection: string | null,
  sourceFile: string,
): Promise<StoredThreadRow[]> => {
  try {
    const tbl = await openTable(THREADS_TABLE);
    if (!tbl) return [];
    await ensureThreadsSchema(tbl);
    const fileFilter = `sourceFile = '${escapeSqlString(sourceFile)}' AND indexPending NOT IN ('delete', 'reset')`;
    const where = collection
      ? `collection = '${escapeSqlString(collection)}' AND ${fileFilter}`
      : fileFilter;
    const rows = await tbl.query().where(where).limit(Number.MAX_SAFE_INTEGER).toArray();
    return rows
      .map((row) => storedThreadRow(row as Record<string, unknown>))
      .sort((a, b) => a.ordinal - b.ordinal);
  } catch (error) {
    console.warn('[store:getStoredThreads]', error);
    return [];
  }
};

export const listThreadSummaries = async (collection: string): Promise<ThreadSummaryRow[]> => {
  try {
    const tbl = await openTable(THREADS_TABLE);
    if (!tbl) return [];
    await ensureThreadsSchema(tbl);
    const baseColumns = [
      'sourceFile',
      'conversationKey',
      'title',
      'provider',
      'ordinal',
      'turnCount',
      'createdInThreadShelf',
      'threadCreatedAt',
      'hasThreadShelfTurns',
      'lastModel',
    ];
    const fetch = (columns: string[]) =>
      tbl
        .query()
        .where(
          `collection = '${escapeSqlString(collection)}' AND indexPending NOT IN ('delete', 'reset')`,
        )
        .select(columns)
        .limit(Number.MAX_SAFE_INTEGER)
        .toArray();

    let rows: Record<string, unknown>[];
    try {
      rows = await fetch([...baseColumns, 'lastTurnAt']);
    } catch (e) {
      // __threads created before the lastTurnAt column existed.
      if (!String((e as Error)?.message || '').includes('lastTurnAt')) throw e;
      rows = await fetch(baseColumns);
    }
    return rows.map((row) => ({
      sourceFile: (row.sourceFile as string) ?? '',
      conversationKey: (row.conversationKey as string) ?? '',
      title: (row.title as string) ?? '',
      provider: (row.provider as string) ?? '',
      ordinal: Number(row.ordinal) || 0,
      turnCount: Number(row.turnCount) || 0,
      lastTurnAt: (row.lastTurnAt as string) ?? '',
      lastModel: (row.lastModel as string) ?? '',
      createdInThreadShelf: Boolean(row.createdInThreadShelf),
      threadCreatedAt: (row.threadCreatedAt as string) ?? '',
      hasThreadShelfTurns: Boolean(row.hasThreadShelfTurns || row.createdInThreadShelf),
    }));
  } catch (error) {
    console.warn('[store:listThreadSummaries]', error);
    return [];
  }
};

export const deleteThreadsForCollection = async (collection: string): Promise<void> => {
  return withCollectionWriteLock(THREADS_TABLE, async () => {
    const tbl = await openTable(THREADS_TABLE);
    if (!tbl) return;
    await ensureThreadsSchema(tbl);
    await tbl.delete(`collection = '${escapeSqlString(collection)}'`);
    invalidateCollectionStats(collection);
  });
};

export interface ImportedFile {
  readonly sourceFile: string;
  readonly provider: string;
  readonly conversations: readonly ThreadConversationInput[];
}

const conversationFromRow = (row: Record<string, unknown>): ThreadConversationInput | undefined => {
  try {
    return {
      key: String(row.conversationKey),
      title: String(row.title),
      turns: validateTurns(JSON.parse(String(row.turnsJson))),
      createdInThreadShelf: Boolean(row.createdInThreadShelf),
      threadCreatedAt: String(row.threadCreatedAt || ''),
    };
  } catch {
    return undefined;
  }
};

const chunksFromThreadRows = (
  rows: Record<string, unknown>[],
): { chunks: ChunkRow[]; invalid: Record<string, unknown>[] } => {
  const invalid: Record<string, unknown>[] = [];
  const chunks = rows.flatMap((row) => {
    if (row.indexPending === 'delete' || row.indexPending === 'reset') return [];
    const conversation = conversationFromRow(row);
    if (!conversation) {
      invalid.push(row);
      return [];
    }
    const turns = validateTurns(conversation.turns);
    return chunkTurns(turns, {
      sourceFile: String(row.sourceFile),
      provider: row.provider as Provider | 'threadshelf',
      conversationKey: String(row.conversationKey),
      title: String(row.title),
    }).map((chunk, index) => ({
      ...chunk,
      provider: chunk.createdInThreadShelf ? 'threadshelf' : chunk.provider,
      id: `${row.sourceFile}|${row.conversationKey}|${chunk.turnIndex}|${index}`,
    }));
  });
  return { chunks, invalid };
};

const readThreadScope = async (where: string): Promise<Record<string, unknown>[]> => {
  const tbl = await openTable(THREADS_TABLE);
  if (!tbl) return [];
  await ensureThreadsSchema(tbl);
  return tbl.query().where(where).limit(Number.MAX_SAFE_INTEGER).toArray();
};

const snapshotFingerprint = (rows: Record<string, unknown>[]): string =>
  createHash('sha256')
    .update(JSON.stringify(rows.map((row) => JSON.stringify(row)).sort()))
    .digest('hex');

// The archive is authoritative. A pending marker is committed WITH its turns;
// the index can always be rebuilt after an interrupted second-table write.
// clearFirst stages the entire folder before this single archive commit.
export const replaceImportedFiles = async (
  collection: string,
  files: readonly ImportedFile[],
  options: ChunkWriteOptions & { readonly clearFirst?: boolean } = {},
): Promise<number> =>
  withCollectionWriteLock(collection, async () => {
    const scope = options.clearFirst
      ? `collection = '${escapeSqlString(collection)}'`
      : files.map((file) => `(${threadFileFilter(collection, file.sourceFile)})`).join(' OR ');
    if (!scope) return 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      options.signal?.throwIfAborted();
      const previous = await withCollectionWriteLock(THREADS_TABLE, () => readThreadScope(scope));
      const previousByKey = new Map(
        previous.map((row) => [JSON.stringify([row.sourceFile, row.conversationKey]), row]),
      );
      const next: Record<string, unknown>[] = [];
      const matched = new Set<string>();
      for (const file of files) {
        const conversations = file.conversations.map((conversation) => {
          const old = previousByKey.get(JSON.stringify([file.sourceFile, conversation.key]));
          if (!old || old.indexPending === 'delete') return conversation;
          matched.add(JSON.stringify([file.sourceFile, conversation.key]));
          const oldConversation = conversationFromRow(old);
          if (!oldConversation) {
            const suffix = createHash('sha256')
              .update(String(old.turnsJson))
              .digest('hex')
              .slice(0, 16);
            next.push({
              ...old,
              conversationKey: `${conversation.key}:unreadable:${suffix}`,
              indexPending: 'invalid',
            });
            return conversation;
          }
          const oldTurns = oldConversation.turns;
          const localTurns = oldTurns.filter(
            (turn) => (turn as { createdInThreadShelf?: boolean }).createdInThreadShelf,
          );
          const importedTurns = oldTurns.filter(
            (turn) => !(turn as { createdInThreadShelf?: boolean }).createdInThreadShelf,
          );
          // Positional keys do not identify a conversation after a wholesale rewrite.
          const text = (turn: unknown) => {
            const t = turn as { user?: string; ai?: string; thinking?: string };
            return [t.user, t.ai, t.thinking];
          };
          const sharedPrefix =
            importedTurns.length > 0 &&
            conversation.turns.length > 0 &&
            importedTurns
              .slice(0, Math.min(importedTurns.length, conversation.turns.length))
              .every(
                (turn, index) =>
                  JSON.stringify(text(turn)) === JSON.stringify(text(conversation.turns[index])),
              );
          if (localTurns.length && /:\d+$/.test(conversation.key) && !sharedPrefix) {
            const suffix = createHash('sha256')
              .update(String(old.turnsJson))
              .digest('hex')
              .slice(0, 16);
            next.push({
              ...old,
              conversationKey: `${conversation.key}:threadshelf:${suffix}`,
              indexPending: 'all',
            });
            return conversation;
          }
          return { ...conversation, turns: [...conversation.turns, ...localTurns] };
        });
        next.push(...threadRows(collection, file.sourceFile, file.provider, conversations, 'all'));
      }
      // Missing/changed keys retain the full old branch if it has local authorship.
      for (const old of previous) {
        if (
          ['delete', 'reset'].includes(String(old.indexPending)) ||
          matched.has(JSON.stringify([old.sourceFile, old.conversationKey]))
        )
          continue;
        if (
          conversationFromRow(old) &&
          !conversationFromRow(old)!.turns.some(
            (turn) => (turn as { createdInThreadShelf?: boolean }).createdInThreadShelf,
          )
        )
          continue;
        next.push({ ...old, indexPending: 'all' });
      }
      const { chunks, invalid } = chunksFromThreadRows(next);
      const embedded = await embedChunks(chunks, options.signal, options.onEmbeddingProgress);
      options.signal?.throwIfAborted();
      const committed = await withCollectionWriteLock(THREADS_TABLE, async () => {
        if (snapshotFingerprint(previous) !== snapshotFingerprint(await readThreadScope(scope)))
          return false;
        options.signal?.throwIfAborted();
        const resetMarker = options.clearFirst
          ? threadRows(
              collection,
              'threadshelf://collection-reset',
              'threadshelf',
              [{ key: '__reset', title: '', turns: [] }],
              'reset',
            )
          : [];
        await replaceThreadRowsLocked(scope, [...next, ...resetMarker]);
        const chunkScope = options.clearFirst
          ? 'true'
          : files.map((file) => `sourceFile = '${escapeSqlString(file.sourceFile)}'`).join(' OR ');
        await replaceEmbeddedRowsLocked(collection, chunkScope, embedded);
        await acknowledgeIndexLocked(scope, invalid);
        return true;
      });
      if (committed) return chunks.length;
    }
    throw new StoredThreadWriteError(
      'Archive changed repeatedly while embedding; retry the import',
    );
  });

const acknowledgeIndexLocked = async (
  where: string,
  invalid: Record<string, unknown>[] = [],
): Promise<void> => {
  const tbl = await openTable(THREADS_TABLE);
  if (!tbl) return;
  for (const row of invalid) {
    await tbl.update({
      where: `${threadFileFilter(String(row.collection), String(row.sourceFile))} AND conversationKey = '${escapeSqlString(String(row.conversationKey))}'`,
      values: {
        indexPending: 'invalid',
        indexError: 'Stored turns could not be decoded; original data retained',
        indexAttempts: 1,
        indexRetryAt: 0,
      },
    });
  }
  if (invalid.length)
    console.error(
      `[index:recovery] Preserved ${invalid.length} unreadable archive row(s); healthy conversations remain searchable.`,
    );
  await tbl.delete(`(${where}) AND indexPending IN ('delete', 'reset')`);
  await tbl.update({
    where: `(${where}) AND indexPending NOT IN ('', 'invalid')`,
    values: { indexPending: '', indexAttempts: 0, indexRetryAt: 0, indexError: '' },
  });
};

const indexScope = async (collection: string, sourceFile: string) => {
  const collectionWhere = `collection = '${escapeSqlString(collection)}'`;
  const reset = (await readThreadScope(`${collectionWhere} AND indexPending = 'reset'`)).length > 0;
  const where = reset ? collectionWhere : threadFileFilter(collection, sourceFile);
  return { where, reset, rows: await readThreadScope(where) };
};

// Only snapshot validation and publication hold the archive lock. Model loading
// and inference never prevent unrelated chats from saving their answers.
export const indexStoredFile = async (
  collection: string,
  sourceFile: string,
  options: ChunkWriteOptions = {},
): Promise<number> =>
  withCollectionWriteLock(collection, async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await withCollectionWriteLock(THREADS_TABLE, () =>
        indexScope(collection, sourceFile),
      );
      const { where, reset, rows } = snapshot;
      if (!rows.some((row) => row.indexPending && row.indexPending !== 'invalid')) return 0;
      const full =
        reset || rows.some((row) => row.indexPending === 'all' || row.indexPending === 'delete');
      try {
        const prepared = chunksFromThreadRows(rows);
        const chunks = prepared.chunks.filter((chunk) => full || chunk.createdInThreadShelf);
        const embedded = await embedChunks(chunks, options.signal, options.onEmbeddingProgress);
        const committed = await withCollectionWriteLock(THREADS_TABLE, async () => {
          const current = await indexScope(collection, sourceFile);
          if (
            where !== current.where ||
            snapshotFingerprint(rows) !== snapshotFingerprint(current.rows)
          )
            return false;
          await replaceEmbeddedRowsLocked(
            collection,
            reset
              ? 'true'
              : `sourceFile = '${escapeSqlString(sourceFile)}'${full ? '' : ' AND createdInThreadShelf = true'}`,
            embedded,
          );
          await acknowledgeIndexLocked(where, prepared.invalid);
          return true;
        });
        if (committed) return chunks.length;
      } catch (error) {
        await withCollectionWriteLock(THREADS_TABLE, async () => {
          if (snapshotFingerprint(rows) !== snapshotFingerprint(await readThreadScope(where)))
            return;
          const attempts = Math.max(0, ...rows.map((row) => Number(row.indexAttempts) || 0)) + 1;
          const tbl = await openTable(THREADS_TABLE);
          await tbl?.update({
            where: `(${where}) AND indexPending NOT IN ('', 'invalid')`,
            values: {
              indexAttempts: attempts,
              indexRetryAt: Date.now() + Math.min(15_000 * 2 ** (attempts - 1), 3_600_000),
              indexError: (error instanceof Error ? error.message : 'Indexing failed').slice(
                0,
                500,
              ),
            },
          });
        });
        throw error;
      }
    }
    throw new StoredThreadWriteError(
      'Archive changed repeatedly while embedding; indexing remains pending',
    );
  });

export const deleteStoredFile = async (collection: string, sourceFile: string): Promise<void> =>
  withCollectionWriteLock(collection, () =>
    withCollectionWriteLock(THREADS_TABLE, async () => {
      const where = threadFileFilter(collection, sourceFile);
      await replaceThreadRowsLocked(where, []);
      await replaceEmbeddedRowsLocked(
        collection,
        `sourceFile = '${escapeSqlString(sourceFile)}'`,
        [],
      );
      await acknowledgeIndexLocked(where);
    }),
  );

let recoveringIndexes: Promise<void> | undefined;
export const recoverPendingIndexes = (
  options: { readonly collection?: string; readonly retryFailed?: boolean } = {},
): Promise<void> => {
  if (recoveringIndexes) return recoveringIndexes.then(() => recoverPendingIndexes(options));
  recoveringIndexes = (async () => {
    const tbl = await openTable(THREADS_TABLE);
    if (!tbl) return;
    await ensureThreadsSchema(tbl);
    const rows = await tbl
      .query()
      .where("indexPending NOT IN ('', 'invalid')")
      .select(['collection', 'sourceFile', 'indexPending', 'indexAttempts', 'indexRetryAt'])
      .limit(Number.MAX_SAFE_INTEGER)
      .toArray();
    const resets = new Set(
      rows.filter((row) => row.indexPending === 'reset').map((row) => row.collection),
    );
    const jobs = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      if (
        options.collection &&
        options.collection !== 'all' &&
        row.collection !== options.collection
      )
        continue;
      const key = JSON.stringify([
        row.collection,
        resets.has(row.collection) ? null : row.sourceFile,
      ]);
      jobs.set(key, [...(jobs.get(key) ?? []), row]);
    }
    for (const job of jobs.values()) {
      const attempts = Math.max(...job.map((row) => Number(row.indexAttempts) || 0));
      const retryAt = Math.max(...job.map((row) => Number(row.indexRetryAt) || 0));
      if (!options.retryFailed && (attempts >= 8 || retryAt > Date.now())) continue;
      const row = job[0]!;
      try {
        await indexStoredFile(String(row.collection), String(row.sourceFile));
      } catch (error) {
        console.error('[index:recovery]', error);
      }
    }
  })().finally(() => {
    recoveringIndexes = undefined;
  });
  return recoveringIndexes;
};

export const startIndexRecovery = (): (() => void) => {
  const run = () => {
    void recoverPendingIndexes().catch((error) => console.warn('[index:recovery]', error));
  };
  run();
  const timer = setInterval(run, 15_000);
  timer.unref();
  return () => clearInterval(timer);
};

export interface SearchResult {
  readonly id: string;
  readonly document: string;
  readonly metadata: {
    readonly sourceFile: string;
    readonly provider?: string;
    readonly conversationKey?: string;
    readonly title?: string;
    readonly role: string;
    readonly turnIndex: string;
    readonly model?: string;
    readonly createdAt?: string;
    readonly createdInThreadShelf?: boolean;
    readonly generationProvider?: string;
    readonly collection?: string;
  };
  readonly distance?: number;
}

// A pending full replacement may have different turn offsets from its old
// vectors. Hide those files until recovery publishes their matching index.
const readyIndexCache = new Map<string, { version: number; filter: string }>();
const readyIndexFilter = async (collection: string): Promise<string> => {
  const tbl = await openTable(THREADS_TABLE);
  if (!tbl) return '';
  await ensureThreadsSchema(tbl);
  const version = await tbl.version();
  const cached = readyIndexCache.get(collection);
  if (cached?.version === version) return cached.filter;
  const rows = await tbl
    .query()
    .where(
      `collection = '${escapeSqlString(collection)}' AND indexPending IN ('all', 'delete', 'reset', 'invalid')`,
    )
    .select(['sourceFile', 'conversationKey', 'indexPending'])
    .limit(Number.MAX_SAFE_INTEGER)
    .toArray();
  const excluded = rows.map((row) =>
    row.indexPending === 'invalid'
      ? `(sourceFile = '${escapeSqlString(String(row.sourceFile))}' AND conversationKey = '${escapeSqlString(String(row.conversationKey))}')`
      : `sourceFile = '${escapeSqlString(String(row.sourceFile))}'`,
  );
  const filter = rows.some((row) => row.indexPending === 'reset')
    ? 'false'
    : excluded.length
      ? `NOT (${[...new Set(excluded)].join(' OR ')})`
      : '';
  readyIndexCache.set(collection, { version, filter });
  return filter;
};

export const renameStoredThread = async (
  collection: string,
  sourceFile: string,
  conversationKey: string,
  title: string,
): Promise<StoredThreadRow> =>
  withCollectionWriteLock(THREADS_TABLE, async () => {
    const tbl = await openTable(THREADS_TABLE);
    if (!tbl) throw new StoredThreadWriteError();
    await ensureThreadsSchema(tbl);
    const where = `${threadFileFilter(collection, sourceFile)} AND conversationKey = '${escapeSqlString(conversationKey)}' AND indexPending NOT IN ('delete', 'reset')`;
    const result = await tbl.update({ where, values: { title } });
    if (result.rowsUpdated !== 1) throw new StoredThreadWriteError();
    invalidateCollectionStats(collection);
    const [row] = await tbl.query().where(where).limit(1).toArray();
    return storedThreadRow(row);
  });

export interface SearchOptions {
  readonly n?: number;
  readonly roles?: string[];
  readonly keywordBoost?: boolean;
  readonly model?: string;
  readonly from?: string;
  readonly to?: string;
  readonly origin?: 'threadshelf' | 'archive';
}

export const searchCollection = async (
  collection: string,
  query: string,
  opts: SearchOptions = {},
  queryEmbedding?: number[],
): Promise<SearchResult[]> => {
  const n = opts.n ?? 15;
  const roles = opts.roles?.length ? opts.roles : null;
  const modelFilter = normalizeModelFilter(opts.model);
  const dateFilter = buildCreatedAtFilter(opts.from, opts.to);
  const keywordBoost = opts.keywordBoost === true;
  const needsPostFilter = roles || modelFilter || keywordBoost;
  const limit = needsPostFilter ? Math.min(Math.max(n * 8, 80), 200) : n;
  const embedding = queryEmbedding ?? (await embedOne(query));

  const tbl = await openTable(collection);
  if (!tbl) return [];
  await ensureChunkMetadataSchema(tbl);

  const filters = [
    dateFilter,
    await readyIndexFilter(collection),
    opts.origin ? `createdInThreadShelf = ${opts.origin === 'threadshelf'}` : '',
  ].filter(Boolean);
  const results = await vectorSearchRows(tbl, embedding, limit, filters.join(' AND '));

  let rows: SearchResult[] = results.map((row) => ({
    id: row.id as string,
    document: (row.document as string) ?? '',
    metadata: {
      sourceFile: row.sourceFile as string,
      provider: (row.provider as string) || undefined,
      conversationKey: (row.conversationKey as string) || undefined,
      title: (row.title as string) || undefined,
      role: row.role as string,
      turnIndex: row.turnIndex as string,
      model: portableModelLabel((row.model as string) || undefined) || undefined,
      createdAt: (row.createdAt as string) || undefined,
      createdInThreadShelf: Boolean(row.createdInThreadShelf),
      generationProvider: (row.generationProvider as string) || undefined,
    },
    distance: row._distance as number | undefined,
  }));

  if (roles?.length) {
    const roleSet = new Set(roles);
    rows = rows.filter((r) => roleSet.has(r.metadata.role));
  }

  if (opts.origin) {
    const expected = opts.origin === 'threadshelf';
    rows = rows.filter((row) => row.metadata.createdInThreadShelf === expected);
  }

  rows = rows.filter((r) => isSearchableDocument(r.document));

  if (modelFilter) {
    rows = rows.filter((r) => normalizeModelFilter(r.metadata.model)?.includes(modelFilter));
  }

  if (keywordBoost && query.trim()) {
    const q = query.trim().toLowerCase();
    rows.sort((a, b) => {
      const aHas = a.document.toLowerCase().includes(q);
      const bHas = b.document.toLowerCase().includes(q);
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;
      return (a.distance ?? 0) - (b.distance ?? 0);
    });
  }

  return rows.slice(0, n);
};

// Exact-match (keyword) search: a case-insensitive substring scan pushed down
// to LanceDB as a LIKE filter. Complements vector search for identifiers,
// error strings, and code fragments the embedding model blurs away.

const escapeLikePattern = (value: string): string =>
  escapeSqlString(value).replace(/[\\%_]/g, '\\$&');

const countOccurrences = (haystack: string, needle: string): number => {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
};

export const keywordResultComparator =
  (query: string) =>
  (a: SearchResult, b: SearchResult): number => {
    const needle = query.trim().toLowerCase();
    const diff =
      countOccurrences(b.document.toLowerCase(), needle) -
      countOccurrences(a.document.toLowerCase(), needle);
    if (diff !== 0) return diff;
    return (b.metadata.createdAt ?? '').localeCompare(a.metadata.createdAt ?? '');
  };

export const keywordSearchCollection = async (
  collection: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchResult[]> => {
  const n = opts.n ?? 15;
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const tbl = await openTable(collection);
  if (!tbl) return [];
  await ensureChunkMetadataSchema(tbl);

  const clauses = [`lower(document) LIKE '%${escapeLikePattern(needle)}%'`];
  const ready = await readyIndexFilter(collection);
  if (ready) clauses.push(ready);
  if (opts.roles?.length) {
    clauses.push(`role IN (${opts.roles.map((role) => `'${escapeSqlString(role)}'`).join(', ')})`);
  }
  const dateFilter = buildCreatedAtFilter(opts.from, opts.to);
  if (dateFilter) clauses.push(dateFilter);
  if (opts.origin) clauses.push(`createdInThreadShelf = ${opts.origin === 'threadshelf'}`);

  // Cap the scan the same way post-filtered vector search does; ranking picks
  // the best n from that window.
  const limit = Math.min(Math.max(n * 8, 80), 200);

  let results: Record<string, unknown>[];
  try {
    results = await tbl.query().where(clauses.join(' AND ')).limit(limit).toArray();
  } catch (e) {
    if (dateFilter && String((e as Error)?.message || '').includes('createdAt')) return [];
    throw e;
  }

  const modelFilter = normalizeModelFilter(opts.model);
  let rows: SearchResult[] = results.map((row) => ({
    id: row.id as string,
    document: (row.document as string) ?? '',
    metadata: {
      sourceFile: row.sourceFile as string,
      provider: (row.provider as string) || undefined,
      conversationKey: (row.conversationKey as string) || undefined,
      title: (row.title as string) || undefined,
      role: row.role as string,
      turnIndex: row.turnIndex as string,
      model: portableModelLabel((row.model as string) || undefined) || undefined,
      createdAt: (row.createdAt as string) || undefined,
      createdInThreadShelf: Boolean(row.createdInThreadShelf),
      generationProvider: (row.generationProvider as string) || undefined,
    },
  }));

  rows = rows.filter((r) => isSearchableDocument(r.document));
  if (modelFilter) {
    rows = rows.filter((r) => normalizeModelFilter(r.metadata.model)?.includes(modelFilter));
  }

  rows.sort(keywordResultComparator(query));
  return rows.slice(0, n);
};

export interface ChunkMetaRow {
  readonly createdAt: string;
  readonly model: string;
  readonly role: string;
}

// Lightweight metadata scan powering the insights dashboard: three small
// string columns, no vectors and no document text.
export const scanChunkMeta = async (collection: string): Promise<ChunkMetaRow[]> => {
  try {
    const tbl = await openTable(collection);
    if (!tbl) return [];
    const fetch = (columns: string[]) =>
      tbl.query().select(columns).limit(Number.MAX_SAFE_INTEGER).toArray();

    let rows: Record<string, unknown>[];
    try {
      rows = await fetch(['createdAt', 'model', 'role']);
    } catch (e) {
      // Tables indexed before model/createdAt existed.
      if (!String((e as Error)?.message || '').includes('No field named')) throw e;
      rows = await fetch(['role']);
    }
    return rows.map((row) => ({
      createdAt: (row.createdAt as string) ?? '',
      model: portableModelLabel((row.model as string) ?? ''),
      role: (row.role as string) ?? '',
    }));
  } catch (error) {
    console.warn(`[store:scanChunkMeta:${collection}]`, error);
    return [];
  }
};

export const listSourceFilesInCollection = async (collection: string): Promise<string[]> => {
  try {
    const tbl = await openTable(collection);
    if (!tbl) return [];
    const rows = await tbl.query().select(['sourceFile']).limit(Number.MAX_SAFE_INTEGER).toArray();
    const files = new Set<string>();
    for (const row of rows) {
      if (row.sourceFile) files.add(row.sourceFile as string);
    }
    return [...files].sort();
  } catch (error) {
    console.warn(`[store:listSourceFiles:${collection}]`, error);
    return [];
  }
};

export interface CollectionStats {
  readonly collection: string;
  readonly files: number;
  readonly conversations: number;
  readonly chunks: number;
  readonly roles: { user: number; thinking: number; ai: number };
  readonly isEmpty: boolean;
}

const computeCollectionStats = async (collection: string): Promise<CollectionStats> => {
  try {
    const tbl = await openTable(collection);
    const conversations = (await listThreadSummaries(collection)).length;
    if (!tbl) {
      return {
        collection,
        files: 0,
        conversations,
        chunks: 0,
        roles: { user: 0, thinking: 0, ai: 0 },
        isEmpty: true,
      };
    }

    // Counts run natively in LanceDB; only the distinct-file scan materializes
    // rows (a single column) in JS.
    const [chunks, user, thinking, ai, sourceFiles] = await Promise.all([
      tbl.countRows(),
      tbl.countRows("role = 'user'"),
      tbl.countRows("role = 'thinking'"),
      tbl.countRows("role = 'ai'"),
      listSourceFilesInCollection(collection),
    ]);

    return {
      collection,
      files: sourceFiles.length,
      conversations,
      chunks,
      roles: { user, thinking, ai },
      isEmpty: chunks === 0,
    };
  } catch (error) {
    console.warn(`[store:getCollectionStats:${collection}]`, error);
    return {
      collection,
      files: 0,
      conversations: 0,
      chunks: 0,
      roles: { user: 0, thinking: 0, ai: 0 },
      isEmpty: true,
    };
  }
};

export const getCollectionStats = async (collection: string): Promise<CollectionStats> => {
  const cached = collectionStatsCache.get(collection);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = computeCollectionStats(collection).catch((error) => {
    collectionStatsCache.delete(collection);
    throw error;
  });
  collectionStatsCache.set(collection, {
    expiresAt: Date.now() + COLLECTION_STATS_CACHE_MS,
    value,
  });
  return value;
};

export const listCollections = async (): Promise<string[]> => {
  try {
    const database = await getDb();
    const names = await database.tableNames();
    // "__"-prefixed tables are internal (e.g. __threads), never user collections.
    return names.filter((name) => name !== 'Default' && !name.startsWith('__')).sort();
  } catch (error) {
    console.warn('[store:listCollections]', error);
    return [];
  }
};

// Drop runs under the per-collection write lock so a reset cannot interleave
// with a concurrent ingest's delete+add on the same collection.
export const dropCollection = async (name: string): Promise<void> => {
  return withCollectionWriteLock(name, async () => {
    const database = await getDb();
    try {
      await database.dropTable(name);
    } catch {
      // table may not exist
    }
    tableCache.delete(name);
    invalidateCollectionStats(name);
    await deleteThreadsForCollection(name);
  });
};

// --- internals ---

const vectorSearchRows = async (
  tbl: Table,
  queryEmbedding: number[],
  limit: number,
  rowFilter = '',
): Promise<Record<string, unknown>[]> => {
  const base = () => {
    const query = tbl.vectorSearch(queryEmbedding).distanceType('cosine');
    const filtered = rowFilter ? query.where(rowFilter) : query;
    return filtered.limit(limit);
  };

  try {
    return await base()
      .select([
        'id',
        'document',
        'sourceFile',
        'provider',
        'conversationKey',
        'title',
        'role',
        'turnIndex',
        'model',
        'createdAt',
        'createdInThreadShelf',
        'generationProvider',
        '_distance',
      ])
      .toArray();
  } catch (e) {
    if (rowFilter && String((e as Error)?.message || '').includes('createdAt')) return [];
    if (!String((e as Error)?.message || '').includes('No field named')) throw e;
    try {
      return await base()
        .select([
          'id',
          'document',
          'sourceFile',
          'provider',
          'conversationKey',
          'title',
          'role',
          'turnIndex',
          '_distance',
        ])
        .toArray();
    } catch (inner) {
      if (!String((inner as Error)?.message || '').includes('No field named')) throw inner;
      try {
        return await base()
          .select(['id', 'document', 'sourceFile', 'provider', 'role', 'turnIndex', '_distance'])
          .toArray();
      } catch (legacy) {
        if (!String((legacy as Error)?.message || '').includes('No field named')) throw legacy;
        return base()
          .select(['id', 'document', 'sourceFile', 'role', 'turnIndex', '_distance'])
          .toArray();
      }
    }
  }
};

const buildCreatedAtFilter = (from: string | undefined, to: string | undefined): string => {
  const clauses = ["createdAt != ''"];
  if (from) clauses.push(`createdAt >= '${escapeSqlString(from)}'`);
  if (to) clauses.push(`createdAt <= '${escapeSqlString(to)}'`);
  return clauses.length > 1 ? clauses.join(' AND ') : '';
};

const normalizeModelFilter = (value: string | undefined): string => {
  if (value === undefined || value === null) return '';
  return portableModelLabel(String(value)).toLowerCase();
};

const isSearchableDocument = (text: string): boolean => {
  if (!isIndexableText(text)) return false;
  return text.trim().length >= 8;
};

const withCollectionWriteLock = async <T>(collection: string, fn: () => Promise<T>): Promise<T> => {
  const previous = collectionWriteLocks.get(collection) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  collectionWriteLocks.set(collection, chained);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (collectionWriteLocks.get(collection) === chained) {
      collectionWriteLocks.delete(collection);
    }
  }
};
