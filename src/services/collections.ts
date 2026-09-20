import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { dataPath } from '../paths.js';
import { listCollections, dropCollection } from '../store.js';

// Overridable so test servers with an isolated LanceDB do not share (and
// pollute) the real registry file in the repo/app directory.
const COLLECTIONS_FILE = process.env.COLLECTIONS_PATH || dataPath('collections');

export const readManualCollections = async (): Promise<string[]> => {
  try {
    const raw = await readFile(COLLECTIONS_FILE, 'utf-8');
    const data = JSON.parse(raw) as { collections?: unknown };
    return Array.isArray(data.collections) ? (data.collections as string[]) : [];
  } catch {
    return [];
  }
};

export const writeManualCollections = async (collections: string[]): Promise<void> => {
  await writeFile(COLLECTIONS_FILE, JSON.stringify({ collections }, null, 2));
};

export const getAllCollections = async (): Promise<string[]> => {
  const [tableCollections, manualCollections] = await Promise.all([
    listCollections(),
    readManualCollections(),
  ]);
  return [...new Set([...tableCollections, ...manualCollections, 'chunks'])].sort();
};

export const addManualCollection = async (name: string): Promise<void> => {
  const collections = await readManualCollections();
  if (!collections.includes(name)) {
    collections.push(name);
    collections.sort();
    await writeManualCollections(collections);
  }
};

export const removeManualCollection = async (name: string): Promise<void> => {
  const collections = await readManualCollections();
  const filtered = collections.filter((c) => c !== name);
  if (filtered.length !== collections.length) {
    await writeManualCollections(filtered);
  }
};

export const ensureCollectionExists = async (name: string): Promise<void> => {
  const all = await getAllCollections();
  if (!all.includes(name)) {
    await addManualCollection(name);
  }
};

export const deleteCollectionFull = async (name: string, uploadsDir: string): Promise<void> => {
  const { existsSync } = await import('fs');
  const { rm } = await import('fs/promises');

  await dropCollection(name);
  await removeManualCollection(name);

  const uploadDir = join(uploadsDir, name);
  if (existsSync(uploadDir)) {
    await rm(uploadDir, { recursive: true, force: true });
  }
};
