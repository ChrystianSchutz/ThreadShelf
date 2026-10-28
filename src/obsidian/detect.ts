import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

/** A Markdown folder found on this machine that the user can connect with one click. */
export interface DetectedNoteFolder {
  readonly source: 'Obsidian' | 'OpenClaw';
  readonly name: string;
  readonly path: string;
}

interface DetectOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
}

/** Where the Obsidian desktop app keeps its vault list (obsidian.json). */
export const obsidianRegistryPath = ({
  env = process.env,
  platform = process.platform,
  home = homedir(),
}: DetectOptions = {}): string => {
  if (platform === 'win32') {
    return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'obsidian', 'obsidian.json');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  }
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'obsidian', 'obsidian.json');
};

const isDirectory = async (path: string): Promise<boolean> =>
  (await stat(path).catch(() => undefined))?.isDirectory() ?? false;

const obsidianVaults = async (options: DetectOptions): Promise<DetectedNoteFolder[]> => {
  const raw = await readFile(obsidianRegistryPath(options), 'utf8').catch(() => '');
  if (!raw) return [];
  let vaults: unknown;
  try {
    vaults = (JSON.parse(raw) as { vaults?: unknown }).vaults;
  } catch {
    return [];
  }
  if (!vaults || typeof vaults !== 'object') return [];
  const found: DetectedNoteFolder[] = [];
  for (const entry of Object.values(vaults as Record<string, unknown>)) {
    const path = (entry as { path?: unknown } | null)?.path;
    if (typeof path === 'string' && path && (await isDirectory(path))) {
      found.push({ source: 'Obsidian', name: basename(path), path });
    }
  }
  return found;
};

/** OpenClaw keeps its agent memory (MEMORY.md, memory/*.md) in ~/.openclaw/workspace. */
const openClawWorkspace = async ({
  home = homedir(),
}: DetectOptions): Promise<DetectedNoteFolder[]> => {
  const path = join(home, '.openclaw', 'workspace');
  return (await isDirectory(path)) ? [{ source: 'OpenClaw', name: 'OpenClaw workspace', path }] : [];
};

/** Lists known Markdown note folders; unreadable or missing sources are skipped. */
export const detectNoteFolders = async (
  options: DetectOptions = {},
): Promise<DetectedNoteFolder[]> => {
  const all = [...(await obsidianVaults(options)), ...(await openClawWorkspace(options))];
  const seen = new Set<string>();
  return all.filter((folder) => {
    const key = folder.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
