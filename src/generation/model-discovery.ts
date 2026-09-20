import { readdir, stat } from 'fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'path';
import type { GenerationModel } from './types.js';

const MAX_MODELS = 10_000;
const MAX_DEPTH = 8;

export const localGgufModelName = (modelPath: string): string =>
  basename(modelPath, extname(modelPath));

const isInside = (path: string, root: string): boolean => {
  const rel = relative(resolve(root), resolve(path));
  // Across Windows drives `relative` yields an absolute path, which carries no
  // `..` prefix and would otherwise read as "inside" — silently dropping every
  // model root that lives on a different drive than the first one.
  if (isAbsolute(rel)) return false;
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.includes('\0'));
};

export const discoverGgufModels = async (
  directories: readonly string[],
  { maxModels = MAX_MODELS, maxDepth = MAX_DEPTH }: { maxModels?: number; maxDepth?: number } = {},
): Promise<GenerationModel[]> => {
  const models: GenerationModel[] = [];
  const seen = new Set<string>();
  const roots = [...new Set(directories.map((directory) => resolve(directory)))]
    .sort((a, b) => a.length - b.length)
    .filter((root, index, all) => !all.slice(0, index).some((parent) => isInside(root, parent)));

  const walk = async (root: string, directory: string, depth: number): Promise<void> => {
    if (depth > maxDepth || models.length >= maxModels || !isInside(directory, root)) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (models.length >= maxModels) break;
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(root, path, depth + 1);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.gguf') {
        const lowerName = entry.name.toLowerCase();
        if (lowerName.startsWith('mmproj')) continue;
        const shard = lowerName.match(/-(\d{5})-of-\d{5}\.gguf$/);
        if (shard && shard[1] !== '00001') continue;
        const absolute = resolve(path);
        if (seen.has(absolute)) continue;
        seen.add(absolute);
        const fileStat = await stat(absolute).catch(() => null);
        models.push({
          id: absolute,
          name: localGgufModelName(absolute),
          provider: 'llama-cpp',
          path: absolute,
          sizeBytes: fileStat?.size,
        });
      }
    }
  };

  for (const root of roots) {
    await walk(root, root, 0);
    if (models.length >= maxModels) break;
  }
  return models.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
};
