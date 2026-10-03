import { mkdir, readFile, rename, writeFile, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, parse, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataPath } from '../paths.js';
import { unlink } from 'node:fs/promises';

export interface VaultConfig {
  readonly vaultPath: string;
  readonly allowWrites: boolean;
}
const configPath = (): string => process.env.OBSIDIAN_CONFIG_PATH || dataPath('obsidianConfig');
let configQueue = Promise.resolve();

const writeConfig = async (next: VaultConfig): Promise<void> => {
  const destination = configPath();
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
};

/** Toggle policy without trusting a potentially stale browser copy of the vault path. */
export const setVaultWritePermission = async (allowWrites: unknown): Promise<VaultConfig> => {
  if (typeof allowWrites !== 'boolean') throw new Error('allowWrites must be a boolean');
  const operation = configQueue.then(async () => {
    const current = await getVaultConfig();
    const next = { ...current, allowWrites };
    await writeConfig(next);
    return next;
  });
  configQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
};

export const getVaultConfig = async (): Promise<VaultConfig> => {
  try {
    const raw = JSON.parse(await readFile(configPath(), 'utf8')) as Partial<VaultConfig>;
    if (typeof raw.vaultPath !== 'string' || typeof raw.allowWrites !== 'boolean') {
      throw new Error('Invalid vault configuration');
    }
    return { vaultPath: raw.vaultPath, allowWrites: raw.allowWrites };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { vaultPath: '', allowWrites: true };
    }
    throw new Error('Cannot read Obsidian configuration', { cause: error });
  }
};

/** Reject junctions/symlinks, including ancestors of the chosen root. */
export const canonicalVaultRoot = async (root: string): Promise<string> => {
  if (!root || !isAbsolute(root)) throw new Error('Choose an absolute vault directory');
  const absolute = resolve(root);
  let current = parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    const stat = await lstat(current).catch(() => undefined);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Vault directories must exist and cannot be symbolic links or junctions');
    }
  }
  return realpath(absolute);
};

export const saveVaultConfig = async (input: unknown): Promise<VaultConfig> => {
  const raw = input as Partial<VaultConfig> | null;
  if (!raw || typeof raw.vaultPath !== 'string' || typeof raw.allowWrites !== 'boolean') {
    throw new Error('vaultPath and allowWrites are required');
  }
  const next = {
    vaultPath: raw.vaultPath.trim() ? await canonicalVaultRoot(raw.vaultPath.trim()) : '',
    allowWrites: raw.allowWrites,
  };
  const operation = configQueue.then(() => writeConfig(next));
  configQueue = operation.catch(() => undefined);
  await operation;
  return next;
};
