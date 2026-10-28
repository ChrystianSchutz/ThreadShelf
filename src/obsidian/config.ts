import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataPath } from '../paths.js';

export interface VaultConfig {
  readonly vaultPath: string;
  readonly allowWrites: boolean;
}

/** A vault is read-only until the user explicitly enables writes. */
export const DEFAULT_VAULT_CONFIG: VaultConfig = { vaultPath: '', allowWrites: false };
const MAX_VAULT_PATH = 4096;

const configPath = (): string => process.env.OBSIDIAN_CONFIG_PATH || dataPath('obsidianConfig');
let configQueue: Promise<unknown> = Promise.resolve();

/** Serializes read-modify-write config changes within this process. */
const queued = <T>(fn: () => Promise<T>): Promise<T> => {
  const operation = configQueue.then(fn);
  configQueue = operation.catch(() => undefined);
  return operation;
};

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

export const getVaultConfig = async (): Promise<VaultConfig> => {
  try {
    const raw = JSON.parse(await readFile(configPath(), 'utf8')) as Partial<VaultConfig> | null;
    if (!raw || typeof raw.vaultPath !== 'string' || typeof raw.allowWrites !== 'boolean') {
      throw new Error('Invalid vault configuration');
    }
    return { vaultPath: raw.vaultPath, allowWrites: raw.allowWrites };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_VAULT_CONFIG;
    throw new Error('Cannot read Obsidian configuration', { cause: error });
  }
};

/** Toggle policy without trusting a potentially stale browser copy of the vault path. */
export const setVaultWritePermission = async (allowWrites: unknown): Promise<VaultConfig> => {
  if (typeof allowWrites !== 'boolean') throw new Error('allowWrites must be a boolean');
  return queued(async () => {
    const next = { ...(await getVaultConfig()), allowWrites };
    await writeConfig(next);
    return next;
  });
};

/** Win32 device namespaces bypass normal path parsing and are never valid vault roots. */
const DEVICE_NAMESPACE = /^[\\/]{2}[?.][\\/]/;

/** Reject junctions/symlinks, including ancestors of the chosen root. */
export const canonicalVaultRoot = async (root: string): Promise<string> => {
  if (!root || !isAbsolute(root) || root.length > MAX_VAULT_PATH || root.includes('\0')) {
    throw new Error('Choose an absolute vault directory');
  }
  if (DEVICE_NAMESPACE.test(root)) throw new Error('Device paths cannot be used as a vault');
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

/**
 * Saves the vault path. `allowWrites` is optional: when omitted, the current
 * choice is kept for the same vault, and a newly connected vault is read-only.
 */
export const saveVaultConfig = async (input: unknown): Promise<VaultConfig> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('vaultPath is required');
  }
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== 'vaultPath' && key !== 'allowWrites')) {
    throw new Error('Only vaultPath and allowWrites can be saved');
  }
  if (typeof raw.vaultPath !== 'string') throw new Error('vaultPath is required');
  if (raw.allowWrites !== undefined && typeof raw.allowWrites !== 'boolean') {
    throw new Error('allowWrites must be a boolean');
  }
  const trimmed = raw.vaultPath.trim();
  const vaultPath = trimmed ? await canonicalVaultRoot(trimmed) : '';
  return queued(async () => {
    // A corrupt file is replaced by a valid read-only configuration, never trusted.
    const current = await getVaultConfig().catch(() => DEFAULT_VAULT_CONFIG);
    const allowWrites =
      typeof raw.allowWrites === 'boolean'
        ? raw.allowWrites
        : current.vaultPath === vaultPath && current.allowWrites;
    const next = { vaultPath, allowWrites };
    await writeConfig(next);
    return next;
  });
};
