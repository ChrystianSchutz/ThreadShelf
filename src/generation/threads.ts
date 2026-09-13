import { randomUUID } from 'node:crypto';
import {
  getStoredThreads,
  listThreadSummaries,
  deleteStoredFile,
  replaceThreadsForFile,
  StoredThreadWriteError,
  updateStoredThread,
  updateStoredThreadFromCurrent,
  renameStoredThread,
  indexStoredFile,
  type StoredThreadRow,
} from '../store.js';
import { validateTurns, ValidationError, type Turn } from '../validation.js';
import type { ChatResponse } from './types.js';
import { addManualCollection } from '../services/collections.js';
import { portableModelLabel } from '../model-label.js';

export const THREADSHELF_CHAT_COLLECTION = 'threadshelf_conversations';
const LEGACY_THREADSHELF_CHAT_COLLECTION = '__threadshelf_chats';
const THREADSHELF_CHAT_SOURCE_PREFIX = 'threadshelf://chat/';
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Longest chat title we persist, for both auto-derived and user-set names.
export const CHAT_TITLE_MAX = 200;

export interface ThreadShelfChatSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turnCount: number;
  readonly model?: string;
  readonly createdInThreadShelf: true;
}

export interface ThreadShelfChat extends ThreadShelfChatSummary {
  readonly turns: Turn[];
}

export interface GenerationPersistenceStatus {
  readonly saved: boolean;
  readonly indexed: boolean;
  readonly indexedChunks: number;
  readonly warning?: string;
}

export interface PersistedChatExchange {
  readonly chat: ThreadShelfChat;
  readonly persistence: GenerationPersistenceStatus;
}

export class ThreadShelfChatNotFoundError extends Error {
  constructor() {
    super('ThreadShelf chat not found');
    this.name = 'ThreadShelfChatNotFoundError';
  }
}

export class ThreadShelfChatBusyError extends Error {
  constructor() {
    super('This ThreadShelf chat is already generating a response');
    this.name = 'ThreadShelfChatBusyError';
  }
}

const activeChats = new Set<string>();

const acquireGenerationKey = (key: string): (() => void) => {
  if (activeChats.has(key)) throw new ThreadShelfChatBusyError();
  activeChats.add(key);
  return () => activeChats.delete(key);
};

export const acquireThreadShelfChat = (id: unknown): (() => void) => {
  const normalized = assertThreadShelfChatId(id);
  return acquireGenerationKey(`chat\0${normalized}`);
};

export const assertThreadShelfChatId = (value: unknown): string => {
  if (typeof value !== 'string' || !THREAD_ID_PATTERN.test(value)) {
    throw new ThreadShelfChatNotFoundError();
  }
  return value.toLowerCase();
};

const sourceFileForId = (id: string): string => `${THREADSHELF_CHAT_SOURCE_PREFIX}${id}`;

const idFromSourceFile = (sourceFile: string): string | null => {
  if (!sourceFile.startsWith(THREADSHELF_CHAT_SOURCE_PREFIX)) return null;
  const id = sourceFile.slice(THREADSHELF_CHAT_SOURCE_PREFIX.length);
  return THREAD_ID_PATTERN.test(id) ? id.toLowerCase() : null;
};

const parseTurns = (row: StoredThreadRow): Turn[] => {
  return validateTurns(JSON.parse(row.turnsJson));
};

const markCreatedChatTurns = (turns: readonly Turn[]): Turn[] =>
  turns.map((turn) => ({
    ...turn,
    ...(turn.model ? { model: portableModelLabel(turn.model) } : {}),
    createdInThreadShelf: true,
  }));

const toChat = (row: StoredThreadRow): ThreadShelfChat => {
  const id = idFromSourceFile(row.sourceFile);
  if (!id || !row.createdInThreadShelf) throw new ThreadShelfChatNotFoundError();
  const createdAt = row.threadCreatedAt || row.ingestedAt;
  return {
    id,
    title: row.title || 'New chat',
    createdAt,
    updatedAt: row.lastTurnAt || row.ingestedAt || createdAt,
    turnCount: row.turnCount,
    model:
      portableModelLabel(row.lastModel) ||
      portableModelLabel([...parseTurns(row)].reverse().find((turn) => turn.model)?.model) ||
      undefined,
    createdInThreadShelf: true,
    turns: markCreatedChatTurns(parseTurns(row)),
  };
};

const conversationFromChat = (chat: ThreadShelfChat) => ({
  key: chat.id,
  title: chat.title,
  turns: chat.turns,
  createdInThreadShelf: true,
  threadCreatedAt: chat.createdAt,
});

const insertChat = async (chat: ThreadShelfChat): Promise<void> => {
  await replaceThreadsForFile(
    THREADSHELF_CHAT_COLLECTION,
    sourceFileForId(chat.id),
    'threadshelf',
    [conversationFromChat(chat)],
  );
};

const updateChat = async (chat: ThreadShelfChat): Promise<void> => {
  await updateStoredThread(
    THREADSHELF_CHAT_COLLECTION,
    sourceFileForId(chat.id),
    'threadshelf',
    conversationFromChat(chat),
  );
};

const indexWithStatus = async (target: {
  readonly collection: string;
  readonly sourceFile: string;
}): Promise<GenerationPersistenceStatus> => {
  try {
    const indexedChunks = await indexStoredFile(target.collection, target.sourceFile);
    return { saved: true, indexed: true, indexedChunks };
  } catch (error) {
    const warning = `Conversation was saved, but semantic indexing failed and will be retried: ${error instanceof Error ? error.message : String(error)}`;
    console.warn('[generation:index]', warning);
    // The pending marker was written atomically with the turns. The server's
    // recovery worker retries it from current storage, including after restart.
    return { saved: true, indexed: false, indexedChunks: 0, warning };
  }
};

const migrateLegacyChat = async (row: StoredThreadRow): Promise<ThreadShelfChat> => {
  const chat = toChat(row);
  await addManualCollection(THREADSHELF_CHAT_COLLECTION);
  await insertChat(chat);
  await replaceThreadsForFile(
    LEGACY_THREADSHELF_CHAT_COLLECTION,
    row.sourceFile,
    'threadshelf',
    [],
  );
  await indexWithStatus({
    collection: THREADSHELF_CHAT_COLLECTION,
    sourceFile: row.sourceFile,
  });
  return chat;
};

// This title is persisted, so truncating here discards the text permanently.
// Keep it whole up to the same ceiling `renameChat` enforces; shortening for
// display is the UI's job (see `.r-title` in `_search.scss`).
export const titleFromPrompt = (prompt: string): string => {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  return compact.length > CHAT_TITLE_MAX ? `${compact.slice(0, CHAT_TITLE_MAX - 1)}…` : compact;
};

export const createThreadShelfChat = async (
  title = 'New chat',
  initialTurns: readonly Turn[] = [],
): Promise<ThreadShelfChat> => {
  const now = new Date().toISOString();
  const turns = markCreatedChatTurns(
    initialTurns.map((turn) => ({ ...turn, createdAt: turn.createdAt ?? now })),
  );
  const firstPrompt = turns.find((turn) => typeof turn.user === 'string')?.user;
  const model = [...turns].reverse().find((turn) => turn.model)?.model;
  const chat: ThreadShelfChat = {
    id: randomUUID(),
    title: title === 'New chat' && firstPrompt ? titleFromPrompt(firstPrompt) : title,
    createdAt: now,
    updatedAt: now,
    turnCount: turns.length,
    model,
    createdInThreadShelf: true,
    turns,
  };
  await addManualCollection(THREADSHELF_CHAT_COLLECTION);
  await insertChat(chat);
  if (turns.length) {
    await indexWithStatus({
      collection: THREADSHELF_CHAT_COLLECTION,
      sourceFile: sourceFileForId(chat.id),
    });
  }
  return chat;
};

export const renameThreadShelfChat = async (
  value: unknown,
  title: string,
): Promise<ThreadShelfChat> => {
  const trimmed = title.replace(/\s+/g, ' ').trim();
  // A bare Error would surface as a 502; an empty title is a client mistake.
  if (!trimmed) throw new ValidationError('A chat title cannot be empty', { field: 'title' });
  const chat = await getThreadShelfChat(value);
  return toChat(
    await renameStoredThread(
      THREADSHELF_CHAT_COLLECTION,
      sourceFileForId(chat.id),
      chat.id,
      trimmed.slice(0, CHAT_TITLE_MAX),
    ),
  );
};

export const deleteThreadShelfChat = async (value: unknown): Promise<void> => {
  const release = acquireThreadShelfChat(value);
  try {
    const chat = await getThreadShelfChat(value);
    // A crash during legacy migration can leave both copies. Remove the fallback
    // first so deleting the primary copy cannot make the legacy one reappear.
    await deleteStoredFile(LEGACY_THREADSHELF_CHAT_COLLECTION, sourceFileForId(chat.id));
    await deleteStoredFile(THREADSHELF_CHAT_COLLECTION, sourceFileForId(chat.id));
  } finally {
    release();
  }
};

export const getThreadShelfChat = async (value: unknown): Promise<ThreadShelfChat> => {
  const id = assertThreadShelfChatId(value);
  const sourceFile = sourceFileForId(id);
  const rows = await getStoredThreads(THREADSHELF_CHAT_COLLECTION, sourceFile);
  const row = rows.find((candidate) => candidate.conversationKey === id);
  if (row) {
    const chat = toChat(row);
    if (parseTurns(row).some((turn) => turn.createdInThreadShelf !== true)) {
      await updateChat(chat);
      await indexWithStatus({
        collection: THREADSHELF_CHAT_COLLECTION,
        sourceFile,
      });
    }
    return chat;
  }

  const legacyRows = await getStoredThreads(LEGACY_THREADSHELF_CHAT_COLLECTION, sourceFile);
  const legacy = legacyRows.find((candidate) => candidate.conversationKey === id);
  if (!legacy) throw new ThreadShelfChatNotFoundError();
  return migrateLegacyChat(legacy);
};

export const listThreadShelfChats = async (): Promise<ThreadShelfChatSummary[]> => {
  const [legacyRows, rows] = await Promise.all([
    listThreadSummaries(LEGACY_THREADSHELF_CHAT_COLLECTION),
    listThreadSummaries(THREADSHELF_CHAT_COLLECTION),
  ]);
  const chats = new Map<string, ThreadShelfChatSummary>();
  for (const row of [...legacyRows, ...rows]) {
    const id = idFromSourceFile(row.sourceFile);
    if (!id || !row.createdInThreadShelf) continue;
    const createdAt = row.threadCreatedAt;
    chats.set(id, {
      id,
      title: row.title || 'New chat',
      createdAt,
      updatedAt: row.lastTurnAt || createdAt,
      turnCount: row.turnCount,
      model: portableModelLabel(row.lastModel) || undefined,
      createdInThreadShelf: true,
    });
  }
  return [...chats.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

export const appendThreadShelfChatExchange = async (
  value: unknown,
  prompt: string,
  response: ChatResponse,
): Promise<PersistedChatExchange> => {
  const chat = await getThreadShelfChat(value);
  const now = new Date().toISOString();
  const provenance = {
    createdAt: now,
    createdInThreadShelf: true,
    generationProvider: response.provider,
  } as const;
  await updateStoredThreadFromCurrent(
    THREADSHELF_CHAT_COLLECTION,
    sourceFileForId(chat.id),
    chat.id,
    (current) => {
      const turns: Turn[] = [
        ...parseTurns(current),
        { user: prompt, model: response.model, ...provenance },
      ];
      if (response.reasoning?.trim())
        turns.push({ thinking: response.reasoning, model: response.model, ...provenance });
      turns.push({ ai: response.content, model: response.model, ...provenance });
      return {
        provider: 'threadshelf',
        conversation: {
          key: current.conversationKey,
          title:
            current.turnCount === 0 && current.title === 'New chat'
              ? titleFromPrompt(prompt)
              : current.title,
          turns,
          createdInThreadShelf: true,
          threadCreatedAt: current.threadCreatedAt,
        },
      };
    },
  );
  const persistence = await indexWithStatus({
    collection: THREADSHELF_CHAT_COLLECTION,
    sourceFile: sourceFileForId(chat.id),
  });
  const updated = await getThreadShelfChat(chat.id);
  return { chat: updated, persistence };
};

export interface StoredThreadGenerationTarget {
  readonly collection: string;
  readonly sourceFile: string;
  readonly conversationKey: string;
  readonly title: string;
  readonly provider: string;
  readonly createdInThreadShelf: boolean;
  readonly threadCreatedAt: string;
  readonly turns: Turn[];
}

export const acquireStoredThreadGeneration = (
  target: StoredThreadGenerationTarget,
): (() => void) =>
  target.collection === THREADSHELF_CHAT_COLLECTION && idFromSourceFile(target.sourceFile)
    ? acquireThreadShelfChat(idFromSourceFile(target.sourceFile))
    : acquireGenerationKey(
        `stored\0${target.collection}\0${target.sourceFile}\0${target.conversationKey}`,
      );

export const resolveStoredThreadGenerationTarget = async (
  collection: string,
  sourceFile: string,
  conversationKey?: string,
): Promise<StoredThreadGenerationTarget | null> => {
  const rows = await getStoredThreads(collection === 'all' ? null : collection, sourceFile);
  const candidates = conversationKey
    ? rows.filter((row) => row.conversationKey === conversationKey)
    : rows;
  const row = [...candidates].sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt))[0];
  if (!row) return null;
  return {
    collection: row.collection,
    sourceFile: row.sourceFile,
    conversationKey: row.conversationKey,
    title: row.title,
    provider: row.provider,
    createdInThreadShelf: row.createdInThreadShelf,
    threadCreatedAt: row.threadCreatedAt,
    turns: parseTurns(row),
  };
};

export const appendStoredThreadExchange = async (
  target: StoredThreadGenerationTarget,
  prompt: string,
  response: ChatResponse,
): Promise<GenerationPersistenceStatus> => {
  const now = new Date().toISOString();
  const provenance = {
    createdAt: now,
    createdInThreadShelf: true,
    generationProvider: response.provider,
  } as const;

  try {
    await updateStoredThreadFromCurrent(
      target.collection,
      target.sourceFile,
      target.conversationKey,
      (current) => {
        const currentTurns = parseTurns(current);
        const turns: Turn[] = [
          ...currentTurns,
          { user: prompt, model: response.model, ...provenance },
        ];
        if (response.reasoning?.trim()) {
          turns.push({ thinking: response.reasoning, model: response.model, ...provenance });
        }
        turns.push({ ai: response.content, model: response.model, ...provenance });
        return {
          provider: current.provider || target.provider,
          conversation: {
            key: current.conversationKey,
            title: current.title || target.title,
            turns,
            createdInThreadShelf: current.createdInThreadShelf,
            threadCreatedAt: current.threadCreatedAt,
          },
        };
      },
    );
  } catch (error) {
    if (!(error instanceof StoredThreadWriteError)) throw error;
    return {
      saved: false,
      indexed: false,
      indexedChunks: 0,
      warning: `${error.message}. The generated response remains available in this browser session but was not added to the archive.`,
    };
  }

  return indexWithStatus({
    collection: target.collection,
    sourceFile: target.sourceFile,
  });
};
