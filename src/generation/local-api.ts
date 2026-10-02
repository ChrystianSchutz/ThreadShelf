import { basename, dirname, resolve } from 'path';
import { createHash } from 'crypto';
import { getGenerationConfig } from './config.js';
import {
  LlamaModelBusyError,
  getLoadedLlamaModel,
  stopManagedLlamaServer,
  withLlamaRuntimeControl,
  withLlamaServer,
} from './llama-process.js';
import { getGenerationProvider } from './registry.js';
import type { GenerationModel } from './types.js';

/**
 * The model catalogue behind ThreadShelf's local inference API (`/v1`).
 *
 * Clients address models the way they do in LM Studio or Ollama: by a short
 * id (the GGUF file name without `.gguf`), never by a filesystem path. The id
 * maps back to the GGUF file, which the managed llama-server loads on demand.
 * When an existing llama-server URL is configured instead, its own model ids
 * are served unchanged.
 */
export interface LocalApiModel {
  /** Public id clients send as `model`. */
  readonly id: string;
  /** What the llama.cpp runtime loads: a GGUF path, or an external server's model id. */
  readonly target: string;
  /** The name llama-server knows the loaded model by (its `--alias`). */
  readonly upstreamModel: string;
  /** In memory now (or loading); an external server's models always count as loaded. */
  readonly loaded: boolean;
}

export type LocalApiErrorKind =
  | 'invalid_request'
  | 'model_not_found'
  | 'model_busy'
  | 'model_load_failed'
  | 'upstream_unavailable';

const STATUS: Readonly<Record<LocalApiErrorKind, number>> = {
  invalid_request: 400,
  model_not_found: 404,
  // Retryable: official SDKs back off and retry 503 on their own.
  model_busy: 503,
  model_load_failed: 500,
  upstream_unavailable: 502,
};

export class LocalApiError extends Error {
  readonly status: number;

  constructor(
    readonly kind: LocalApiErrorKind,
    message: string,
    readonly param?: string,
  ) {
    super(message);
    this.name = 'LocalApiError';
    this.status = STATUS[kind];
  }
}

const MAX_LISTED_IDS = 8;

const firstLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split('\n')[0]?.trim() ||
  'unknown error';

/**
 * File names are the natural ids, but two model folders may hold a file of the
 * same name. Only those collisions are qualified with their folder, so the
 * common case keeps the short id llama-server also reports back as `model`.
 */
const toLocalApiModels = (models: readonly GenerationModel[]): LocalApiModel[] => {
  const nameCounts = new Map<string, number>();
  for (const model of models) {
    if (model.path) nameCounts.set(model.name, (nameCounts.get(model.name) ?? 0) + 1);
  }
  const entries: LocalApiModel[] = models.map((model) =>
    model.path
      ? {
          id:
            (nameCounts.get(model.name) ?? 0) > 1
              ? `${basename(dirname(model.path))}/${model.name}`
              : model.name,
          target: model.path,
          upstreamModel: model.name,
          loaded: Boolean(model.loaded),
        }
      : { id: model.id, target: model.id, upstreamModel: model.id, loaded: true },
  );
  const idCounts = new Map<string, number>();
  for (const entry of entries) idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
  const reservedIds = new Set(entries.map((entry) => entry.id));
  return entries.map((entry) => {
    if (idCounts.get(entry.id) === 1) return entry;
    // Qualifying by the last folder can still collide across roots. Keep paths
    // private and ids stable across discovery order; never drop a model.
    const digest = createHash('sha256').update(entry.target).digest('hex');
    let id = `${entry.id}~${digest}`;
    while (reservedIds.has(id)) id += '~';
    reservedIds.add(id);
    return { ...entry, id };
  });
};

export const listLocalApiModels = async (): Promise<LocalApiModel[]> => {
  try {
    return toLocalApiModels(await getGenerationProvider('llama-cpp').listModels());
  } catch (error) {
    throw new LocalApiError(
      'upstream_unavailable',
      `Could not list local models: ${firstLine(error)}`,
    );
  }
};

const availableModelsHint = (models: readonly LocalApiModel[]): string => {
  if (models.length === 0) {
    return 'No GGUF models were found. Download one in ThreadShelf Settings or add a model directory.';
  }
  const ids = models.slice(0, MAX_LISTED_IDS).map((model) => model.id);
  const more = models.length > ids.length ? `, … (${models.length - ids.length} more)` : '';
  return `Available models: ${ids.join(', ')}${more}. Full list: GET /v1/models.`;
};

/** Finds the model a request names: exact id first, then a unique case-insensitive match. */
export const resolveLocalApiModel = async (requested: unknown): Promise<LocalApiModel> => {
  const models = await listLocalApiModels();
  if (typeof requested !== 'string' || !requested.trim()) {
    throw new LocalApiError(
      'invalid_request',
      `The "model" field is required. ${availableModelsHint(models)}`,
      'model',
    );
  }
  const id = requested.trim();
  const exact = models.find((model) => model.id === id);
  if (exact) return exact;
  const folded = models.filter((model) => model.id.toLowerCase() === id.toLowerCase());
  if (folded.length === 1 && folded[0]) return folded[0];
  throw new LocalApiError(
    'model_not_found',
    `The model "${id}" does not exist. ${availableModelsHint(models)}`,
    'model',
  );
};

/**
 * Runs `operation` against the `/v1` base URL of a llama-server that has
 * `model` loaded, holding the runtime lease until the operation settles so the
 * model cannot be swapped out mid-response. Failures to obtain the model are
 * reported as {@link LocalApiError}s; errors from `operation` pass through.
 */
export const withLocalApiModel = async <T>(
  model: LocalApiModel,
  operation: (baseUrl: string) => Promise<T>,
): Promise<T> => {
  let started = false;
  try {
    return await withLlamaServer(model.target, (baseUrl) => {
      started = true;
      return operation(baseUrl);
    });
  } catch (error) {
    if (started) throw error;
    if (error instanceof LlamaModelBusyError) {
      throw new LocalApiError(
        'model_busy',
        `${error.message}. Only one model generates at a time; retry when it finishes.`,
      );
    }
    throw new LocalApiError(
      'model_load_failed',
      `Could not load "${model.id}": ${firstLine(error)}. The llama.cpp log is in ThreadShelf Settings.`,
    );
  }
};

export interface LocalApiUnloadResult {
  readonly unloaded: boolean;
  /** Id of the model that was in memory, or null when none was. */
  readonly model: string | null;
}

/**
 * Frees the memory held by the managed llama-server, like Eject in the UI.
 * With `requested` set, only that model is unloaded; naming a model that is not
 * loaded is a no-op rather than an error, so scripts can call this blindly.
 */
export const unloadLocalApiModel = async (requested: unknown): Promise<LocalApiUnloadResult> => {
  try {
    return await withLlamaRuntimeControl(async () => {
      const config = await getGenerationConfig();
      if (config.llamaCpp.baseUrl) {
        throw new LocalApiError(
          'invalid_request',
          `ThreadShelf is using an existing llama-server at ${config.llamaCpp.baseUrl}; unload models there.`,
        );
      }
      const wanted =
        requested === undefined || requested === null || requested === ''
          ? undefined
          : await resolveLocalApiModel(requested);
      const loadedPath = getLoadedLlamaModel();
      if (!loadedPath) return { unloaded: false, model: null };
      const loaded = (await listLocalApiModels()).find(
        (model) => resolve(model.target) === loadedPath,
      );
      const loadedId = loaded?.id ?? basename(loadedPath).replace(/\.gguf$/i, '');
      if (wanted && resolve(wanted.target) !== loadedPath)
        return { unloaded: false, model: loadedId };
      await stopManagedLlamaServer();
      return { unloaded: true, model: loadedId };
    });
  } catch (error) {
    if (error instanceof LlamaModelBusyError) {
      throw new LocalApiError(
        'model_busy',
        `${error.message}. The model is unloaded only between requests; retry when it finishes.`,
      );
    }
    throw error;
  }
};
