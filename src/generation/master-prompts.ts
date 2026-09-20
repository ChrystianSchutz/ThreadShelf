import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { randomUUID } from 'crypto';
import { dataPath } from '../paths.js';
import { ValidationError } from '../validation.js';

/**
 * Master prompts: the user's own system prompts, one of which is prepended to
 * every generation request. They are written by hand and expected to survive a
 * browser reset, so they live on disk next to the other local generation state
 * rather than in browser storage. The file never leaves the machine; a prompt
 * only travels off-device if the user generates through OpenRouter.
 */
export interface MasterPrompt {
  readonly id: string;
  readonly name: string;
  readonly text: string;
  readonly updatedAt: string;
}

export interface MasterPromptCollection {
  readonly prompts: readonly MasterPrompt[];
  /** '' when no prompt is active. */
  readonly activeId: string;
}

export interface MasterPromptInput {
  readonly name?: unknown;
  readonly text?: unknown;
  readonly active?: unknown;
}

const MAX_PROMPTS = 50;
const MAX_NAME_CHARS = 60;
const MAX_TEXT_CHARS = 20_000;

export const masterPromptsPath = (): string =>
  resolve(
    process.env.MASTER_PROMPTS_PATH || dataPath('masterPrompts'),
  );

const isPrompt = (value: unknown): value is MasterPrompt =>
  Boolean(value) &&
  typeof value === 'object' &&
  typeof (value as MasterPrompt).id === 'string' &&
  typeof (value as MasterPrompt).name === 'string' &&
  typeof (value as MasterPrompt).text === 'string';

const read = async (): Promise<MasterPromptCollection> => {
  let raw: string;
  try {
    raw = await readFile(masterPromptsPath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { prompts: [], activeId: '' };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid master prompt JSON at ${masterPromptsPath()}`, { cause: error });
  }
  const stored = parsed as { prompts?: unknown; activeId?: unknown };
  const prompts = (Array.isArray(stored.prompts) ? stored.prompts : [])
    .filter(isPrompt)
    .slice(0, MAX_PROMPTS)
    .map((prompt) => ({
      id: prompt.id,
      name: prompt.name,
      text: prompt.text,
      updatedAt: typeof prompt.updatedAt === 'string' ? prompt.updatedAt : '',
    }));
  const activeId = typeof stored.activeId === 'string' ? stored.activeId : '';
  return {
    prompts,
    activeId: prompts.some((prompt) => prompt.id === activeId) ? activeId : '',
  };
};

const write = async (next: MasterPromptCollection): Promise<MasterPromptCollection> => {
  const path = masterPromptsPath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, path);
  return next;
};

// Writes are small but arrive from a chatty UI; serializing them keeps the
// read-modify-write cycle from dropping a concurrent edit.
let queue: Promise<unknown> = Promise.resolve();
const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = queue.then(operation, operation);
  queue = result.catch(() => undefined);
  return result;
};

const parseText = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new ValidationError('Invalid text: must be a string', { field: 'text' });
  }
  const trimmed = value.trim();
  if (!trimmed) throw new ValidationError('A master prompt cannot be empty', { field: 'text' });
  if (trimmed.length > MAX_TEXT_CHARS) {
    throw new ValidationError(`Invalid text: max ${MAX_TEXT_CHARS} chars`, { field: 'text' });
  }
  return trimmed;
};

const parseName = (value: unknown, fallback: string): string => {
  if (value === undefined || value === null || value === '') {
    return fallback.replace(/\s+/g, ' ').slice(0, 28);
  }
  if (typeof value !== 'string') {
    throw new ValidationError('Invalid name: must be a string', { field: 'name' });
  }
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return fallback.replace(/\s+/g, ' ').slice(0, 28);
  if (trimmed.length > MAX_NAME_CHARS) {
    throw new ValidationError(`Invalid name: max ${MAX_NAME_CHARS} chars`, { field: 'name' });
  }
  return trimmed;
};

// Route params arrive untyped from Express, so ids are validated here rather
// than trusted at the call site.
const parseId = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError('Invalid id', { field: 'id' });
  }
  return value;
};

export const listMasterPrompts = (): Promise<MasterPromptCollection> => read();

export const createMasterPrompt = (input: MasterPromptInput): Promise<MasterPromptCollection> =>
  serialize(async () => {
    const current = await read();
    if (current.prompts.length >= MAX_PROMPTS) {
      throw new ValidationError(`At most ${MAX_PROMPTS} master prompts can be stored`);
    }
    const text = parseText(input?.text);
    const prompt: MasterPrompt = {
      id: randomUUID(),
      name: parseName(input?.name, text),
      text,
      updatedAt: new Date().toISOString(),
    };
    // A freshly written prompt is the one the user means to use.
    return write({ prompts: [...current.prompts, prompt], activeId: prompt.id });
  });

export const updateMasterPrompt = (
  value: unknown,
  input: MasterPromptInput,
): Promise<MasterPromptCollection> =>
  serialize(async () => {
    const id = parseId(value);
    const current = await read();
    const existing = current.prompts.find((prompt) => prompt.id === id);
    if (!existing) throw new ValidationError('Master prompt not found', { field: 'id' });
    const text = input?.text === undefined ? existing.text : parseText(input.text);
    const updated: MasterPrompt = {
      ...existing,
      name: input?.name === undefined ? existing.name : parseName(input.name, text),
      text,
      updatedAt: new Date().toISOString(),
    };
    return write({
      prompts: current.prompts.map((prompt) => (prompt.id === id ? updated : prompt)),
      activeId: input?.active === false ? '' : id,
    });
  });

export const deleteMasterPrompt = (value: unknown): Promise<MasterPromptCollection> =>
  serialize(async () => {
    const id = parseId(value);
    const current = await read();
    const prompts = current.prompts.filter((prompt) => prompt.id !== id);
    if (prompts.length === current.prompts.length) {
      throw new ValidationError('Master prompt not found', { field: 'id' });
    }
    return write({ prompts, activeId: current.activeId === id ? '' : current.activeId });
  });

/** `id` of '' turns the master prompt off without deleting anything. */
export const setActiveMasterPrompt = (id: unknown): Promise<MasterPromptCollection> =>
  serialize(async () => {
    if (typeof id !== 'string') {
      throw new ValidationError('Invalid id: must be a string', { field: 'id' });
    }
    const current = await read();
    if (id && !current.prompts.some((prompt) => prompt.id === id)) {
      throw new ValidationError('Master prompt not found', { field: 'id' });
    }
    return write({ prompts: current.prompts, activeId: id });
  });
