/**
 * Read-only browser for GGUF models published on the Hugging Face Hub.
 *
 * Everything here uses the public, unauthenticated API: search, download counts,
 * per-file sizes and the LFS `oid` that doubles as the file's SHA-256. A token is
 * only ever needed for *gated* repositories, which are detected up front so the
 * UI can say so instead of failing with a 401 halfway through a download.
 *
 * Only catalog metadata leaves the machine. No chat content is ever sent here.
 */

export const HUGGINGFACE_ORIGIN = 'https://huggingface.co';

export type CatalogSort = 'downloads' | 'likes' | 'trending' | 'recent';
export type CatalogGating = false | 'auto' | 'manual';

export interface CatalogModelSummary {
  readonly id: string;
  readonly author: string;
  readonly name: string;
  readonly downloads: number;
  readonly likes: number;
  readonly trendingScore?: number;
  readonly gated: CatalogGating;
  readonly updatedAt?: string;
  readonly architecture?: string;
  readonly contextLength?: number;
  readonly parameterCount?: number;
  readonly trustedPublisher: boolean;
}

export interface CatalogFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256?: string;
}

export interface CatalogQuant {
  /** Normalised quantisation label, e.g. `Q4_K_M` or `UD-Q4_K_XL`. */
  readonly label: string;
  readonly files: readonly CatalogFile[];
  readonly totalBytes: number;
  readonly shards: number;
  readonly recommended: boolean;
}

export interface CatalogModelDetail extends CatalogModelSummary {
  readonly quants: readonly CatalogQuant[];
  readonly projectors: readonly CatalogFile[];
  readonly license?: string;
}

export interface CatalogSearchResult {
  readonly models: readonly CatalogModelSummary[];
  readonly source: string;
  readonly tokenConfigured: boolean;
}

/**
 * Publishers whose GGUF repositories are consistently ungated and well-formed.
 * They are surfaced first and used as the pool for one-click setup, which is how
 * the common path avoids ever needing a Hugging Face login.
 */
export const TRUSTED_PUBLISHERS: readonly string[] = [
  'unsloth',
  'lmstudio-community',
  'bartowski',
  'ggml-org',
  'Qwen',
  'google',
  'mistralai',
];

const REPO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const CACHE_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_SEARCH_LIMIT = 50;

/**
 * Matches the quantisation suffix at the end of a GGUF file name: `Q4_K_M`,
 * `IQ3_XXS`, `UD-Q4_K_XL`, `BF16`, `MXFP4_MOE`, `TQ1_0`.
 */
const QUANT_SUFFIX =
  /(?:^|[-_.])((?:UD-)?(?:I?Q\d+[A-Z0-9_]*|TQ\d+[A-Z0-9_]*|MXFP4[A-Z0-9_]*|BF16|FP16|F16|FP32|F32))$/i;
const SHARD_SUFFIX = /-(\d{5})-of-(\d{5})$/;
const PREFERRED_QUANTS = ['UD-Q4_K_XL', 'Q4_K_M', 'Q4_K_S', 'IQ4_XS', 'Q5_K_M', 'Q8_0'];

/**
 * Quality tiers for automatic selection. Size alone is a bad proxy: a legacy
 * `Q4_1` and a modern `Q4_K_M` occupy the same space while the K-quant is
 * clearly better, and full-precision weights waste memory that the KV cache
 * needs. Higher is better; 0 means "never pick this automatically".
 */
export const quantQualityTier = (label: string): number => {
  const value = label.toUpperCase();
  if (/^(UD-)?(BF16|FP16|F16|FP32|F32)$/.test(value)) return 0;
  // Legacy non-K quantisations, kept usable but never preferred. Only the 4- and
  // 5-bit families are legacy; `Q8_0` shares the shape but is the best common
  // quantisation there is.
  if (/^(UD-)?Q[45]_[01]$/.test(value)) return 1;
  const bits = Number(value.match(/Q(\d+)/)?.[1] ?? 0);
  if (bits >= 8) return 6;
  if (bits >= 6) return 5;
  if (bits >= 5) return 4;
  if (bits >= 4) return 3;
  if (bits >= 3) return 2;
  return 1;
};

export class CatalogError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

export const assertRepoId = (value: unknown): string => {
  if (typeof value !== 'string' || !REPO_ID_PATTERN.test(value) || value.includes('..')) {
    throw new CatalogError('Invalid model id: expected "owner/name"', 400);
  }
  return value;
};

export const huggingFaceToken = (env: NodeJS.ProcessEnv = process.env): string =>
  (env.HF_TOKEN || env.HUGGING_FACE_HUB_TOKEN || '').trim();

const catalogHeaders = (): Record<string, string> => {
  const token = huggingFaceToken();
  return {
    Accept: 'application/json',
    'User-Agent': 'ThreadShelf-model-catalog',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};

interface CacheEntry {
  readonly at: number;
  readonly value: unknown;
}
const cache = new Map<string, CacheEntry>();

const cached = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  // The catalog is browsed interactively; a small bound keeps memory flat without
  // any eviction bookkeeping.
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  return value;
};

export const clearCatalogCacheForTests = (): void => cache.clear();

const catalogGet = async (path: string, fetchImpl: typeof fetch): Promise<unknown> => {
  const response = await fetchImpl(`${HUGGINGFACE_ORIGIN}${path}`, {
    headers: catalogHeaders(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw new CatalogError(
      'Hugging Face refused the request. Gated repositories need HF_TOKEN in the server .env.',
      response.status,
    );
  }
  if (response.status === 404) throw new CatalogError('Model not found on Hugging Face', 404);
  if (response.status === 429) {
    throw new CatalogError('Hugging Face rate limit reached. Try again shortly.', 429);
  }
  if (!response.ok) {
    throw new CatalogError(`Hugging Face request failed (${response.status})`, response.status);
  }
  return response.json();
};

const parseGating = (value: unknown): CatalogGating =>
  value === 'auto' || value === 'manual' ? value : false;

const HF_SORT_FIELD: Record<CatalogSort, string> = {
  downloads: 'downloads',
  likes: 'likes',
  trending: 'trendingScore',
  recent: 'lastModified',
};

interface RawModel {
  readonly id?: string;
  readonly modelId?: string;
  readonly downloads?: number;
  readonly likes?: number;
  readonly trendingScore?: number;
  readonly gated?: unknown;
  readonly lastModified?: string;
  readonly tags?: readonly string[];
  readonly gguf?: {
    readonly total?: number;
    readonly architecture?: string;
    readonly context_length?: number;
  };
  readonly cardData?: { readonly license?: string };
  readonly siblings?: readonly { readonly rfilename?: string }[];
}

const toSummary = (raw: RawModel): CatalogModelSummary | null => {
  const id = raw.id || raw.modelId;
  if (!id || !id.includes('/')) return null;
  const [author = '', ...rest] = id.split('/');
  return {
    id,
    author,
    name: rest.join('/'),
    downloads: Number(raw.downloads) || 0,
    likes: Number(raw.likes) || 0,
    trendingScore: typeof raw.trendingScore === 'number' ? raw.trendingScore : undefined,
    gated: parseGating(raw.gated),
    updatedAt: raw.lastModified,
    architecture: raw.gguf?.architecture,
    contextLength: raw.gguf?.context_length,
    parameterCount: raw.gguf?.total,
    trustedPublisher: TRUSTED_PUBLISHERS.some(
      (publisher) => publisher.toLowerCase() === author.toLowerCase(),
    ),
  };
};

export const searchCatalogModels = async ({
  query = '',
  sort = 'downloads',
  limit = 24,
  author,
  fetchImpl = fetch,
}: {
  query?: string;
  sort?: CatalogSort;
  limit?: number;
  author?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<CatalogSearchResult> => {
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit) || 24), MAX_SEARCH_LIMIT);
  const params = new URLSearchParams({
    filter: 'gguf',
    sort: HF_SORT_FIELD[sort] ?? 'downloads',
    direction: '-1',
    limit: String(safeLimit),
  });
  // The list endpoint omits `gated` unless it is explicitly expanded, so without
  // this the browser could never warn that a repository needs a Hugging Face
  // login. Expanding replaces the default field set, so every field the UI reads
  // has to be named here.
  for (const field of ['gated', 'downloads', 'likes', 'trendingScore', 'lastModified']) {
    params.append('expand[]', field);
  }
  const trimmed = query.trim().slice(0, 128);
  if (trimmed) params.set('search', trimmed);
  if (author) params.set('author', author);

  const path = `/api/models?${params.toString()}`;
  const payload = await cached(path, () => catalogGet(path, fetchImpl));
  const models = (Array.isArray(payload) ? payload : [])
    .map((entry) => toSummary(entry as RawModel))
    .filter((model): model is CatalogModelSummary => model !== null);

  return {
    models,
    source: HUGGINGFACE_ORIGIN,
    tokenConfigured: Boolean(huggingFaceToken()),
  };
};

/** Splits `Model-Q4_K_M-00001-of-00002.gguf` into its quant label and shard index. */
export const parseGgufFileName = (
  path: string,
): { readonly label: string | null; readonly shardIndex?: number; readonly shardTotal?: number } => {
  const segments = path.split('/');
  const fileName = segments[segments.length - 1] ?? path;
  let base = fileName.replace(/\.gguf$/i, '');

  let shardIndex: number | undefined;
  let shardTotal: number | undefined;
  const shard = base.match(SHARD_SUFFIX);
  if (shard) {
    shardIndex = Number(shard[1]);
    shardTotal = Number(shard[2]);
    base = base.slice(0, -shard[0].length);
  }

  const quant = base.match(QUANT_SUFFIX);
  if (quant?.[1]) return { label: quant[1].toUpperCase(), shardIndex, shardTotal };
  // Some repositories keep each quant in its own folder instead of encoding it in
  // the file name (`Q4_K_M/model-00001-of-00002.gguf`).
  if (segments.length > 1 && segments[0]) {
    return { label: segments[0].toUpperCase(), shardIndex, shardTotal };
  }
  return { label: null, shardIndex, shardTotal };
};

interface RawTreeEntry {
  readonly type?: string;
  readonly path?: string;
  readonly size?: number;
  readonly lfs?: { readonly oid?: string; readonly size?: number };
}

export const groupCatalogQuants = (
  entries: readonly RawTreeEntry[],
): { quants: CatalogQuant[]; projectors: CatalogFile[] } => {
  const projectors: CatalogFile[] = [];
  const groups = new Map<string, CatalogFile[]>();

  for (const entry of entries) {
    if (entry.type !== 'file' || !entry.path) continue;
    if (!/\.gguf$/i.test(entry.path)) continue;
    const file: CatalogFile = {
      path: entry.path,
      sizeBytes: Number(entry.lfs?.size ?? entry.size) || 0,
      // The LFS object id for a Hub file is its SHA-256, which lets a download be
      // verified with exactly the same guarantee as a llama.cpp release archive.
      sha256: /^[a-f0-9]{64}$/i.test(entry.lfs?.oid ?? '')
        ? entry.lfs!.oid!.toLowerCase()
        : undefined,
    };
    const fileName = entry.path.split('/').pop() ?? entry.path;
    if (/^mmproj/i.test(fileName)) {
      projectors.push(file);
      continue;
    }
    const { label } = parseGgufFileName(entry.path);
    const key = label ?? fileName.replace(/\.gguf$/i, '').toUpperCase();
    const bucket = groups.get(key);
    if (bucket) bucket.push(file);
    else groups.set(key, [file]);
  }

  const quants = [...groups.entries()]
    .map(([label, files]) => {
      const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
      return {
        label,
        files: ordered,
        totalBytes: ordered.reduce((sum, file) => sum + file.sizeBytes, 0),
        shards: ordered.length,
        recommended: false,
      };
    })
    .sort((a, b) => a.totalBytes - b.totalBytes);

  const preferred =
    PREFERRED_QUANTS.map((label) => quants.find((quant) => quant.label === label)).find(Boolean) ??
    quants[Math.floor(quants.length / 2)];

  return {
    quants: quants.map((quant) => ({ ...quant, recommended: quant === preferred })),
    projectors: projectors.sort((a, b) => a.path.localeCompare(b.path)),
  };
};

export const getCatalogModel = async (
  repoId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogModelDetail> => {
  const id = assertRepoId(repoId);
  const encoded = id.split('/').map(encodeURIComponent).join('/');
  const [info, tree] = await Promise.all([
    cached(`/api/models/${encoded}`, () => catalogGet(`/api/models/${encoded}`, fetchImpl)),
    cached(`/tree/${encoded}`, () =>
      catalogGet(`/api/models/${encoded}/tree/main?recursive=true`, fetchImpl),
    ),
  ]);

  const summary = toSummary({ ...(info as RawModel), id });
  if (!summary) throw new CatalogError('Hugging Face returned an unusable model payload', 502);
  const { quants, projectors } = groupCatalogQuants(
    Array.isArray(tree) ? (tree as RawTreeEntry[]) : [],
  );
  if (quants.length === 0) {
    throw new CatalogError(`${id} publishes no GGUF files`, 404);
  }
  return {
    ...summary,
    quants,
    projectors,
    license: (info as RawModel).cardData?.license,
  };
};

export const catalogFileUrl = (repoId: string, filePath: string): string => {
  const id = assertRepoId(repoId);
  const encodedRepo = id.split('/').map(encodeURIComponent).join('/');
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  return `${HUGGINGFACE_ORIGIN}/${encodedRepo}/resolve/main/${encodedPath}?download=true`;
};
