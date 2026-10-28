import { afterEach, beforeEach } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveVaultConfig } from '../../src/obsidian/config.js';

/**
 * Isolated vault + Obsidian config per test. Never touches a developer's real
 * vault: OBSIDIAN_CONFIG_PATH always points into a fresh temp directory.
 */
export const useTempVault = ({ allowWrites = true } = {}) => {
  const ctx = { temporary: '', vault: '' };
  let previous;
  beforeEach(async () => {
    previous = process.env.OBSIDIAN_CONFIG_PATH;
    ctx.temporary = await mkdtemp(join(tmpdir(), 'threadshelf-vault-unit-'));
    ctx.vault = join(ctx.temporary, 'vault');
    await mkdir(join(ctx.vault, 'Projects'), { recursive: true });
    process.env.OBSIDIAN_CONFIG_PATH = join(ctx.temporary, 'config.json');
    await saveVaultConfig({ vaultPath: ctx.vault, allowWrites });
  });
  afterEach(async () => {
    if (previous === undefined) delete process.env.OBSIDIAN_CONFIG_PATH;
    else process.env.OBSIDIAN_CONFIG_PATH = previous;
    await rm(ctx.temporary, { recursive: true, force: true });
  });
  return ctx;
};

/** True when `name` and an upper-cased variant resolve to the same entry (Windows, macOS). */
export const caseInsensitiveFs = async (directory) => {
  const probe = join(directory, 'case-probe.tmp');
  await writeFile(probe, '');
  try {
    return !!(await lstat(join(directory, 'CASE-PROBE.TMP')).catch(() => undefined));
  } finally {
    await rm(probe, { force: true });
  }
};

/** Creates a symlink, or returns false where the OS/user may not (Windows without dev mode). */
export const trySymlink = async (target, path, type) => {
  try {
    const { symlink } = await import('node:fs/promises');
    await symlink(target, path, type);
    return true;
  } catch {
    return false;
  }
};

/** Names of ThreadShelf lock artefacts (lock, tombstones, reclaim markers) left in a directory. */
export const lockArtefacts = async (directory) =>
  (await readdir(directory)).filter((name) => name.startsWith('.threadshelf-write-lock'));

export const posixOnly = process.platform === 'win32' ? 'POSIX file modes and names' : false;
