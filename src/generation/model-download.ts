import { mkdir, rm, stat } from 'fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { defaultDownloadDirectory, getGenerationConfig } from './config.js';
import { downloadToFile, sha256File } from './downloader.js';
import {
  assertRepoId,
  catalogFileUrl,
  getCatalogModel,
  huggingFaceToken,
  type CatalogFile,
  type CatalogGating,
  type CatalogModelDetail,
  CatalogError,
} from './model-catalog.js';

export interface ModelDownloadFile {
  readonly url: string;
  readonly repoPath: string;
  readonly destination: string;
  readonly sizeBytes: number;
  readonly sha256?: string;
}

export interface ModelDownloadPlan {
  readonly repoId: string;
  readonly quant: string;
  readonly files: readonly ModelDownloadFile[];
  readonly totalBytes: number;
  readonly directory: string;
  /** The file llama.cpp should be pointed at (shard 1 for a sharded model). */
  readonly primaryPath: string;
  readonly gated: CatalogGating;
  readonly license?: string;
  readonly contextLength?: number;
  readonly requiresToken: boolean;
}

export type ModelDownloadProgress =
  | {
      readonly phase: 'downloading';
      readonly file: string;
      readonly fileIndex: number;
      readonly totalFiles: number;
      readonly downloadedBytes: number;
      readonly totalBytes: number;
    }
  | { readonly phase: 'verifying' | 'skipped'; readonly file: string }
  | { readonly phase: 'completed'; readonly primaryPath: string };

/** Turns `unsloth/Qwen3.5-4B-GGUF` into a flat, filesystem-safe folder name. */
export const modelFolderName = (repoId: string): string =>
  assertRepoId(repoId).replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '_');

const assertInside = (root: string, candidate: string): string => {
  const absolute = resolve(candidate);
  const rel = relative(resolve(root), absolute);
  // `isAbsolute` catches the cross-drive case, where `relative` returns a full
  // path that has no `..` prefix to detect.
  if (
    isAbsolute(rel) ||
    rel === '' ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    rel.includes('\0')
  ) {
    throw new CatalogError('Refusing to write a model file outside the download directory', 400);
  }
  return absolute;
};

/**
 * File names come from a remote API, so only a plain relative path of safe
 * segments is accepted before it is joined onto the download directory.
 */
const safeRepoPath = (repoPath: string): string => {
  const segments = repoPath.split('/').filter(Boolean);
  if (
    segments.length === 0 ||
    segments.length > 4 ||
    segments.some(
      (segment) => segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]{1,128}$/.test(segment),
    )
  ) {
    throw new CatalogError(`Unsafe model file path: ${repoPath}`, 400);
  }
  return segments.join('/');
};

export const resolveDownloadDirectory = async (): Promise<string> => {
  const config = await getGenerationConfig().catch(() => null);
  return config?.llamaCpp.downloadDirectory ?? defaultDownloadDirectory();
};

export const planModelDownload = async ({
  repoId,
  quant,
  includeProjector = false,
  directory,
  fetchImpl = fetch,
  detail,
}: {
  repoId: string;
  quant?: string;
  includeProjector?: boolean;
  directory?: string;
  fetchImpl?: typeof fetch;
  detail?: CatalogModelDetail;
}): Promise<ModelDownloadPlan> => {
  const id = assertRepoId(repoId);
  const model = detail ?? (await getCatalogModel(id, fetchImpl));
  const selected = quant
    ? model.quants.find((entry) => entry.label.toUpperCase() === quant.toUpperCase())
    : (model.quants.find((entry) => entry.recommended) ?? model.quants[0]);
  if (!selected) {
    throw new CatalogError(
      `${id} does not publish a "${quant}" quantisation`,
      404,
    );
  }

  const root = resolve(directory ?? (await resolveDownloadDirectory()));
  const folder = join(root, modelFolderName(id));
  const chosen: readonly CatalogFile[] = includeProjector
    ? [...selected.files, ...model.projectors]
    : selected.files;

  const files = chosen.map((file) => {
    const repoPath = safeRepoPath(file.path);
    return {
      url: catalogFileUrl(id, repoPath),
      repoPath,
      // Shards and projectors are flattened next to each other; llama.cpp finds
      // sibling shards by name, so the repository's folder layout is not needed.
      destination: assertInside(folder, join(folder, repoPath.split('/').pop() as string)),
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    };
  });

  const primary = files.find((file) => !/^mmproj/i.test(file.repoPath.split('/').pop() ?? ''));
  if (!primary) throw new CatalogError('Selected quantisation has no model file', 404);

  return {
    repoId: id,
    quant: selected.label,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    directory: folder,
    primaryPath: primary.destination,
    gated: model.gated,
    license: model.license,
    contextLength: model.contextLength,
    requiresToken: model.gated !== false && !huggingFaceToken(),
  };
};

const alreadyPresent = async (file: ModelDownloadFile): Promise<boolean> => {
  const info = await stat(file.destination).catch(() => null);
  if (!info?.isFile() || info.size !== file.sizeBytes) return false;
  if (!file.sha256) return true;
  return (await sha256File(file.destination)) === file.sha256;
};

/**
 * Cheap "is this model already on disk?" check for planning screens: name and
 * exact byte size only, no hashing. Re-reading 17 GB just to render a button
 * label is not worth it — `downloadModel` still verifies the digest before it
 * skips anything, so a size collision costs one re-download, not a bad model.
 */
export const modelFilesPresent = async (plan: ModelDownloadPlan): Promise<boolean> => {
  if (plan.files.length === 0) return false;
  for (const file of plan.files) {
    const info = await stat(file.destination).catch(() => null);
    if (!info?.isFile() || info.size !== file.sizeBytes) return false;
  }
  return true;
};

export const downloadModel = async (
  plan: ModelDownloadPlan,
  {
    onProgress,
    signal,
  }: {
    onProgress?: (progress: ModelDownloadProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ readonly primaryPath: string; readonly directory: string }> => {
  if (plan.requiresToken) {
    throw new CatalogError(
      `${plan.repoId} is a gated repository. Accept its licence on Hugging Face and set HF_TOKEN in the server .env.`,
      403,
    );
  }
  await mkdir(plan.directory, { recursive: true });

  const token = huggingFaceToken();
  let completedBytes = 0;

  for (const [index, file] of plan.files.entries()) {
    signal?.throwIfAborted();
    onProgress?.({ phase: 'verifying', file: file.repoPath });
    if (await alreadyPresent(file)) {
      completedBytes += file.sizeBytes;
      onProgress?.({ phase: 'skipped', file: file.repoPath });
      continue;
    }

    const baseline = completedBytes;
    try {
      await downloadToFile(file.url, file.destination, {
        sha256: file.sha256,
        expectedBytes: file.sizeBytes || undefined,
        signal,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        onProgress: (progress) =>
          onProgress?.({
            phase: 'downloading',
            file: file.repoPath,
            fileIndex: index + 1,
            totalFiles: plan.files.length,
            downloadedBytes: baseline + progress.downloadedBytes,
            totalBytes: plan.totalBytes,
          }),
      });
    } catch (error) {
      // Cancelling is not a fault: keep the partial file so pressing Download
      // again resumes with a Range request instead of starting over. Any other
      // failure drops it, because a partial shard that llama.cpp would try to
      // load is worse than no shard at all.
      if (!(error instanceof Error && error.name === 'AbortError')) {
        await rm(`${file.destination}.part`, { force: true }).catch(() => undefined);
      }
      throw error;
    }
    completedBytes += file.sizeBytes;
  }

  onProgress?.({ phase: 'completed', primaryPath: plan.primaryPath });
  return { primaryPath: plan.primaryPath, directory: plan.directory };
};
