import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalVaultRoot, getVaultConfig } from './config.js';

const MAX_NOTE_BYTES = 512 * 1024;
const MAX_FILES = 20_000;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const requestRoot = new AsyncLocalStorage<string>();
export const inVault = <T>(root: string, fn: () => Promise<T>): Promise<T> =>
  requestRoot.run(root, fn);
export interface VaultNote {
  readonly path: string;
  readonly content: string;
  readonly revision: string;
}
export interface VaultHit {
  readonly path: string;
  readonly title: string;
  readonly snippet: string;
  readonly line: number;
}
export const notePath = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 1024 || !value.toLowerCase().endsWith('.md')) {
    throw new Error('A relative .md note path is required');
  }
  const parts = value.replace(/\\/g, '/').split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part.startsWith('.') ||
        [...part].some((character) => character.charCodeAt(0) < 32) ||
        /[<>:"|?*]/.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  ) {
    throw new Error('Unsafe note path: hidden paths, traversal and reserved names are forbidden');
  }
  return parts.join('/');
};
const hash = (content: string): string => createHash('sha256').update(content).digest('hex');
const rootNow = async (write = false, expectedRoot?: string): Promise<string> => {
  const config = await getVaultConfig();
  if (!config.vaultPath) throw new Error('Connect an Obsidian vault in Settings first');
  if (write && !config.allowWrites) throw new Error('Vault is read-only: writing is disabled');
  const root = await canonicalVaultRoot(config.vaultPath);
  if (
    (expectedRoot && root !== expectedRoot) ||
    (requestRoot.getStore() && root !== requestRoot.getStore())
  )
    throw new Error('Vault changed; start a new request');
  return root;
};
const inside = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};
const safeTarget = async (root: string, path: string, missing = false): Promise<string> => {
  const parts = notePath(path).split('/');
  let target = root;
  for (let i = 0; i < parts.length; i++) {
    target = join(target, parts[i]!);
    const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (missing && i === parts.length - 1 && error.code === 'ENOENT') return undefined;
      throw new Error('Note or parent directory is unavailable');
    });
    if (!stat) break;
    if (
      stat.isSymbolicLink() ||
      (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink > 1)
    ) {
      throw new Error('Only regular Markdown files inside the vault are allowed');
    }
    if (!inside(root, await realpath(target))) throw new Error('Path escapes the vault');
  }
  if (!inside(root, target)) throw new Error('Path escapes the vault');
  return target;
};
const readAt = async (root: string, path: string): Promise<VaultNote> => {
  const target = await safeTarget(root, path);
  const before = await lstat(target);
  const file = await open(
    target,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  ).catch(() => {
    throw new Error('Cannot open note');
  });
  try {
    const stat = await file.stat();
    if (before.ino !== stat.ino || before.dev !== stat.dev)
      throw new Error('Note changed while opening it');
    if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_NOTE_BYTES)
      throw new Error('Note is too large or is not a regular file');
    // Bounded read also covers files growing after the stat call.
    const buffer = Buffer.alloc(MAX_NOTE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_NOTE_BYTES) throw new Error('Note exceeds the 512 KiB limit');
    await safeTarget(root, path);
    const after = await lstat(target);
    if (
      after.ino !== stat.ino ||
      after.dev !== stat.dev ||
      after.size !== size ||
      after.mtimeMs !== stat.mtimeMs
    )
      throw new Error('Note changed while reading it; retry');
    const content = buffer.subarray(0, size).toString('utf8');
    return { path: notePath(path), content, revision: hash(content) };
  } finally {
    await file.close();
  }
};
export const readVaultNote = async (path: unknown): Promise<VaultNote> =>
  readAt(await rootNow(), notePath(path));
const contentValue = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) > MAX_NOTE_BYTES ||
    value.includes('\0')
  ) {
    throw new Error('Markdown content must be text of at most 512 KiB');
  }
  return value;
};

/** Cross-process exclusion for ThreadShelf writers; never auto-remove another writer's lock. */
const withWrite = async <T>(
  fn: (root: string) => Promise<T>,
  expectedRoot?: string,
): Promise<T> => {
  const root = await rootNow(true, expectedRoot);
  const lock = join(root, '.threadshelf-write-lock');
  try {
    await mkdir(lock);
  } catch {
    throw new Error('Vault is busy; retry after the current write completes');
  }
  try {
    await rootNow(true, root);
    return await fn(root);
  } finally {
    await rmdir(lock);
  }
};
export const createVaultNote = async (path: unknown, content: unknown): Promise<VaultNote> => {
  const name = notePath(path);
  const text = contentValue(content);
  return withWrite(async (root) => {
    const target = await safeTarget(root, name, true);
    const file = await open(target, 'wx', 0o600).catch(() => {
      throw new Error('Note already exists or cannot be created');
    });
    try {
      await file.writeFile(text, 'utf8');
    } finally {
      await file.close();
    }
    return { path: name, content: text, revision: hash(text) };
  });
};
export const editVaultNote = async (
  path: unknown,
  content: unknown,
  revision: unknown,
): Promise<VaultNote> => {
  const name = notePath(path);
  const text = contentValue(content);
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))
    throw new Error('Read the note first and provide its revision');
  return withWrite(async (root) => {
    const before = await readAt(root, name);
    if (before.revision !== revision) throw new Error('Note changed; read it again before editing');
    const target = await safeTarget(root, name);
    const temporary = join(dirname(target), `.threadshelf-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(text, 'utf8');
      } finally {
        await file.close();
      }
      if ((await readAt(root, name)).revision !== revision)
        throw new Error('Note changed during editing');
      await rootNow(true, root);
      await safeTarget(root, name);
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return { path: name, content: text, revision: hash(text) };
  });
};

export interface DeleteSnapshot {
  readonly root: string;
  readonly files: readonly { path: string; revision: string }[];
}
export const prepareVaultDelete = async (paths: unknown): Promise<DeleteSnapshot> => {
  if (!Array.isArray(paths) || !paths.length || paths.length > 20)
    throw new Error('Choose 1–20 Markdown notes');
  const names = [...new Set(paths.map(notePath))];
  const root = await rootNow(true);
  const files = [];
  for (const path of names) {
    const note = await readAt(root, path);
    files.push({ path, revision: note.revision });
  }
  return { root, files };
};
/** Called only by the approval manager, never an HTTP/MCP/model tool. */
export const executeApprovedDelete = async (
  snapshot: DeleteSnapshot,
  signal?: AbortSignal,
): Promise<{ deleted: string[]; trash: string }> =>
  withWrite(async (root) => {
    signal?.throwIfAborted();
    for (const file of snapshot.files) {
      if ((await readAt(root, file.path)).revision !== file.revision)
        throw new Error('A note changed since the deletion request; request confirmation again');
    }
    const trash = join(root, '.trash');
    await mkdir(trash, { recursive: true });
    if ((await lstat(trash)).isSymbolicLink() || (await realpath(trash)) !== trash)
      throw new Error('Unsafe trash directory');
    const batch = join(trash, `threadshelf-${randomUUID()}`);
    await mkdir(batch);
    const deleted: string[] = [];
    try {
      for (let i = 0; i < snapshot.files.length; i++) {
        signal?.throwIfAborted();
        const file = snapshot.files[i]!;
        await rootNow(true, root);
        const target = await safeTarget(root, file.path);
        if ((await readAt(root, file.path)).revision !== file.revision)
          throw new Error('Note changed before deletion');
        await rename(target, join(batch, `${i}-${basename(file.path)}`));
        deleted.push(file.path);
      }
    } catch {
      throw new Error(`Deletion stopped. Notes already moved to trash: ${JSON.stringify(deleted)}`);
    }
    return { deleted, trash: relative(root, batch).replace(/\\/g, '/') };
  }, snapshot.root);

export const searchVault = async (
  query: unknown,
  limit: unknown = 10,
  signal?: AbortSignal,
): Promise<{ hits: VaultHit[]; scanned: number; truncated: boolean }> => {
  if (typeof query !== 'string' || !query.trim() || query.length > 1000)
    throw new Error('Search query must contain 1–1000 characters');
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 30)
    throw new Error('Search limit must be 1–30');
  const root = await rootNow();
  const terms = [...new Set(query.toLocaleLowerCase().trim().split(/\s+/))];
  const hits: (VaultHit & { score: number })[] = [];
  let scanned = 0;
  let bytes = 0;
  let truncated = false;
  let entries = 0;
  const visit = async (directory: string): Promise<void> => {
    signal?.throwIfAborted();
    await rootNow(false, root);
    const listing = await readdir(directory, { withFileTypes: true });
    for (const entry of listing) {
      signal?.throwIfAborted();
      if (++entries > MAX_FILES || bytes > MAX_SCAN_BYTES) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const target = join(directory, entry.name);
      if (entry.isDirectory()) {
        const stat = await lstat(target).catch(() => undefined);
        if (stat?.isDirectory() && !stat.isSymbolicLink() && inside(root, await realpath(target)))
          await visit(target);
        if (truncated) return;
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        let note: VaultNote;
        try {
          note = await readAt(root, relative(root, target));
        } catch {
          continue;
        }
        scanned++;
        bytes += Buffer.byteLength(note.content);
        const lower = note.content.toLocaleLowerCase();
        const name = note.path.toLocaleLowerCase();
        const score = terms.reduce(
          (sum, term) => sum + (name.includes(term) ? 5 : 0) + (lower.includes(term) ? 1 : 0),
          0,
        );
        if (!terms.every((term) => name.includes(term) || lower.includes(term))) continue;
        const lines = note.content.split(/\r?\n/);
        const index = Math.max(
          0,
          lines.findIndex((line) => terms.some((term) => line.toLocaleLowerCase().includes(term))),
        );
        const title =
          lines
            .find((line) => /^#\s+/.test(line))
            ?.replace(/^#\s+/, '')
            .slice(0, 200) || basename(note.path, '.md');
        hits.push({
          path: note.path,
          title,
          line: index + 1,
          snippet: lines
            .slice(index, index + 4)
            .join('\n')
            .slice(0, 800),
          score,
        });
        hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
        if (hits.length > (limit as number)) hits.pop();
      }
    }
  };
  await visit(root);
  return { hits: hits.map(({ score: _score, ...hit }) => hit), scanned, truncated };
};
