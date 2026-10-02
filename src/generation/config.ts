import { existsSync } from 'fs';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dataPath } from '../paths.js';
import { dirname, join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { ValidationError } from '../validation.js';

export interface LlamaCppConfig {
  readonly executablePath?: string;
  readonly baseUrl?: string;
  /** Paths explicitly saved by the user. */
  readonly modelDirectories: readonly string[];
  /** Environment and conventional paths added at runtime, but never persisted. */
  readonly defaultModelDirectories: readonly string[];
  /** Where catalog downloads land. Always searched for models. */
  readonly downloadDirectory: string;
  readonly contextSize: number;
  readonly acceleration: LlamaAccelerationMode;
  readonly gpuLayers: number;
  readonly splitMode: LlamaSplitMode;
  readonly mainGpu: number;
  readonly tensorSplit?: string;
  readonly threads: number;
  readonly flashAttention: LlamaFlashAttention;
  readonly kvCache: LlamaKvCacheProfile;
  readonly speculative: LlamaSpeculativeMode;
  readonly reasoningEffort: LlamaReasoningEffort;
  /** Unload the managed model after this many idle minutes; 0 keeps it loaded. */
  readonly idleUnloadMinutes: number;
}

export type LlamaAccelerationMode = 'auto' | 'cpu' | 'gpu' | 'hybrid' | 'multi-gpu';
export type LlamaSplitMode = 'layer' | 'row';
export type LlamaFlashAttention = 'auto' | 'on' | 'off';
/** default = llama.cpp f16; quality = q8_0 keys+values; memory = q4_0 keys+values. */
export type LlamaKvCacheProfile = 'default' | 'quality' | 'memory';
/** MTP/NextN speculative decoding: auto drafts 2 tokens, aggressive drafts 3. */
export type LlamaSpeculativeMode = 'off' | 'auto' | 'aggressive';
export type LlamaReasoningEffort = 'default' | 'off' | 'low' | 'medium' | 'high' | 'xhigh';

const KV_CACHE_PROFILES: readonly LlamaKvCacheProfile[] = ['default', 'quality', 'memory'];
const SPECULATIVE_MODES: readonly LlamaSpeculativeMode[] = ['off', 'auto', 'aggressive'];
const REASONING_EFFORTS: readonly LlamaReasoningEffort[] = [
  'default',
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
];

export interface OpenRouterConfig {
  readonly baseUrl: string;
  readonly apiKeyConfigured: boolean;
  readonly enforceZdr: boolean;
  readonly denyDataCollection: boolean;
}

/** The OpenAI/Anthropic-compatible API at `/v1`. The key itself is never returned. */
export interface LocalApiConfig {
  readonly enabled: boolean;
  readonly apiKeyConfigured: boolean;
  /** `env` when THREADSHELF_API_KEY supplies the key; the saved key is then ignored. */
  readonly apiKeySource: 'none' | 'settings' | 'env';
  /** Also serve `/v1` (and only `/v1`) to other machines on `networkPort`. */
  readonly networkAccess: boolean;
  readonly networkPort: number;
}

export interface PublicGenerationConfig {
  readonly llamaCpp: LlamaCppConfig;
  readonly openRouter: OpenRouterConfig;
  readonly localApi: LocalApiConfig;
  readonly diagnostics: { readonly persistErrorLogs: boolean };
}

interface StoredGenerationConfig {
  readonly schemaVersion?: number;
  readonly llamaCpp?: {
    readonly executablePath?: string;
    readonly baseUrl?: string;
    readonly modelDirectories?: readonly string[];
    readonly downloadDirectory?: string;
    readonly contextSize?: number;
    readonly acceleration?: LlamaAccelerationMode;
    readonly gpuLayers?: number;
    readonly splitMode?: LlamaSplitMode;
    readonly mainGpu?: number;
    readonly tensorSplit?: string;
    readonly threads?: number;
    readonly flashAttention?: LlamaFlashAttention;
    readonly kvCache?: LlamaKvCacheProfile;
    readonly speculative?: LlamaSpeculativeMode;
    readonly reasoningEffort?: LlamaReasoningEffort;
    readonly idleUnloadMinutes?: number;
  };
  readonly openRouter?: {
    readonly enforceZdr?: boolean;
    readonly denyDataCollection?: boolean;
  };
  readonly localApi?: {
    readonly enabled?: boolean;
    readonly apiKey?: string;
    readonly networkAccess?: boolean;
    readonly networkPort?: number;
  };
  readonly diagnostics?: { readonly persistErrorLogs?: boolean };
}

export interface GenerationConfigUpdate {
  readonly llamaCpp?: {
    readonly executablePath?: unknown;
    readonly baseUrl?: unknown;
    readonly modelDirectories?: unknown;
    readonly downloadDirectory?: unknown;
    readonly contextSize?: unknown;
    readonly acceleration?: unknown;
    readonly gpuLayers?: unknown;
    readonly splitMode?: unknown;
    readonly mainGpu?: unknown;
    readonly tensorSplit?: unknown;
    readonly threads?: unknown;
    readonly flashAttention?: unknown;
    readonly kvCache?: unknown;
    readonly speculative?: unknown;
    readonly reasoningEffort?: unknown;
    readonly idleUnloadMinutes?: unknown;
  };
  readonly openRouter?: {
    readonly apiKey?: unknown;
    readonly clearApiKey?: unknown;
    readonly enforceZdr?: unknown;
    readonly denyDataCollection?: unknown;
  };
  readonly localApi?: {
    readonly enabled?: unknown;
    readonly apiKey?: unknown;
    readonly clearApiKey?: unknown;
    readonly networkAccess?: unknown;
    readonly networkPort?: unknown;
  };
  readonly diagnostics?: { readonly persistErrorLogs?: unknown };
}

let sessionOpenRouterApiKey = '';
export const DEFAULT_LOCAL_API_NETWORK_PORT = 3001;
export const MAX_IDLE_UNLOAD_MINUTES = 7 * 24 * 60;
const warnedInvalidEnvironmentValues = new Set<string>();

export const generationConfigPath = (): string =>
  resolve(
    process.env.GENERATION_CONFIG_PATH || dataPath('generationConfig'),
  );

const normalizePaths = (paths: readonly string[]): string[] => [
  ...new Set(paths.map((path) => resolve(path.trim())).filter(Boolean)),
];

export const defaultModelDirectories = (
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string[] => {
  const configured = (env.LLAMA_MODEL_PATHS || '')
    .split(process.platform === 'win32' ? ';' : ':')
    .filter(Boolean);
  const defaults =
    env.THREADSHELF_DISABLE_DEFAULT_MODEL_PATHS === '1'
      ? []
      : [
          join(home, '.lmstudio', 'models'),
          join(home, '.lmstudio'),
          join(home, '.cache', 'lm-studio', 'models'),
          join(home, '.cache', 'llama.cpp'),
          join(home, '.cache', 'huggingface', 'hub'),
        ];
  return normalizePaths([...configured, ...defaults]);
};

export const defaultDownloadDirectory = (env: NodeJS.ProcessEnv = process.env): string =>
  resolve(env.THREADSHELF_MODELS_PATH || dataPath('models'));

const readStoredConfig = async (): Promise<StoredGenerationConfig> => {
  try {
    return JSON.parse(await readFile(generationConfigPath(), 'utf8')) as StoredGenerationConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid generation config JSON at ${generationConfigPath()}`, {
        cause: error,
      });
    }
    throw error;
  }
};

const parseLocalBaseUrl = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 2048) {
    throw new ValidationError(`Invalid ${field}`, { field });
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError(`Invalid ${field}: expected URL`, { field });
  }
  const host = url.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
    throw new ValidationError(`Invalid ${field}: llama.cpp endpoint must be loopback-only`, {
      field,
    });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ValidationError(`Invalid ${field}: expected HTTP(S)`, { field });
  }
  return url.toString().replace(/\/$/, '');
};

const parsePath = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) {
    throw new ValidationError(`Invalid ${field}`, { field });
  }
  const trimmed = value.trim();
  if (!trimmed || /^[/\\]{2}/.test(trimmed)) {
    throw new ValidationError(`Invalid ${field}: network paths are not allowed`, { field });
  }
  return resolve(trimmed);
};

const parseBoolean = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new ValidationError(`Invalid ${field}`, { field });
  return value;
};

const parseContextSize = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 512 || (value as number) > 1_048_576) {
    throw new ValidationError('Invalid contextSize: expected integer from 512 to 1048576', {
      field: 'contextSize',
    });
  }
  return value as number;
};

const parseEnum = <T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
): T | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new ValidationError(`Invalid ${field}`, { field });
  }
  return value as T;
};

const parseInteger = (
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ValidationError(`Invalid ${field}: expected integer from ${min} to ${max}`, {
      field,
    });
  }
  return value as number;
};

const parseTensorSplit = (value: unknown): string | undefined => {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 256) {
    throw new ValidationError('Invalid tensorSplit', { field: 'tensorSplit' });
  }
  const parts = value.split(',').map((part) => part.trim());
  if (
    parts.length === 0 ||
    parts.length > 16 ||
    parts.some((part) => !part || !Number.isFinite(Number(part)) || Number(part) <= 0)
  ) {
    throw new ValidationError('Invalid tensorSplit: expected positive comma-separated weights', {
      field: 'tensorSplit',
    });
  }
  return parts.join(',');
};

const parseDirectories = (value: unknown): string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) {
    throw new ValidationError('Invalid modelDirectories: expected at most 32 paths', {
      field: 'modelDirectories',
    });
  }
  return normalizePaths(
    value.map((entry, index) => {
      const path = parsePath(entry, `modelDirectories[${index}]`);
      if (!path) {
        throw new ValidationError(`Invalid modelDirectories[${index}]: empty path`, {
          field: 'modelDirectories',
        });
      }
      return path;
    }),
  );
};

const resolveApiKey = (): string => sessionOpenRouterApiKey || process.env.OPENROUTER_API_KEY || '';

export const getOpenRouterApiKey = (): string => resolveApiKey();

export const clearSessionOpenRouterApiKeyForTests = (): void => {
  sessionOpenRouterApiKey = '';
};

/** Keys travel in HTTP headers, so only visible ASCII without spaces is accepted. */
const parseLocalApiKey = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 512 || !/^[\x21-\x7e]*$/.test(value.trim())) {
    throw new ValidationError('Invalid local API key: use up to 512 visible ASCII characters', {
      field: 'apiKey',
    });
  }
  return value.trim();
};

const environmentLocalApiKey = (): string => (process.env.THREADSHELF_API_KEY || '').trim();

/**
 * What the `/v1` access check needs, including the key the public config hides.
 * An empty key means no key is required, as in LM Studio and Ollama.
 */
export const getLocalApiAccess = async (): Promise<{
  readonly enabled: boolean;
  readonly apiKey: string;
}> => {
  const stored = await readStoredConfig();
  return {
    enabled: stored.localApi?.enabled ?? true,
    apiKey: environmentLocalApiKey() || stored.localApi?.apiKey || '',
  };
};

const parseEnvironmentOverride = <T>(
  name: string,
  parser: (value: string) => T | undefined,
): T | undefined => {
  const value = process.env[name];
  if (value === undefined) return undefined;
  try {
    return parser(value);
  } catch (error) {
    const warningKey = `${name}\0${value}`;
    if (!warnedInvalidEnvironmentValues.has(warningKey)) {
      warnedInvalidEnvironmentValues.add(warningKey);
      console.warn(
        `[generation] Ignoring invalid ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return undefined;
  }
};

export const effectiveModelDirectories = (config: LlamaCppConfig): string[] =>
  normalizePaths([
    config.downloadDirectory,
    ...config.modelDirectories,
    ...config.defaultModelDirectories,
  ]);

/** True when the change needs llama-server restarted; the idle timeout does not. */
export const llamaCppConfigChanged = (
  previous: PublicGenerationConfig,
  next: PublicGenerationConfig,
): boolean =>
  JSON.stringify({ ...previous.llamaCpp, idleUnloadMinutes: undefined }) !==
  JSON.stringify({ ...next.llamaCpp, idleUnloadMinutes: undefined });

export const getGenerationConfig = async (): Promise<PublicGenerationConfig> => {
  const stored = await readStoredConfig();
  return {
    llamaCpp: {
      executablePath:
        process.env.LLAMA_CPP_SERVER ||
        process.env.LLAMA_SERVER_PATH ||
        stored.llamaCpp?.executablePath,
      baseUrl:
        parseEnvironmentOverride('LLAMA_CPP_BASE_URL', (value) =>
          parseLocalBaseUrl(value, 'LLAMA_CPP_BASE_URL'),
        ) ?? parseLocalBaseUrl(stored.llamaCpp?.baseUrl, 'baseUrl'),
      modelDirectories: normalizePaths(stored.llamaCpp?.modelDirectories ?? []),
      defaultModelDirectories: defaultModelDirectories(),
      downloadDirectory:
        parseEnvironmentOverride('THREADSHELF_MODELS_PATH', (value) =>
          parsePath(value, 'THREADSHELF_MODELS_PATH'),
        ) ??
        (stored.llamaCpp?.downloadDirectory
          ? resolve(stored.llamaCpp.downloadDirectory)
          : defaultDownloadDirectory()),
      contextSize:
        parseEnvironmentOverride('LLAMA_CPP_CONTEXT_SIZE', (value) =>
          parseContextSize(Number(value)),
        ) ??
        stored.llamaCpp?.contextSize ??
        8192,
      acceleration:
        parseEnvironmentOverride('LLAMA_CPP_ACCELERATION', (value) =>
          parseEnum(value, ['auto', 'cpu', 'gpu', 'hybrid', 'multi-gpu'], 'LLAMA_CPP_ACCELERATION'),
        ) ??
        stored.llamaCpp?.acceleration ??
        'auto',
      gpuLayers:
        parseEnvironmentOverride('LLAMA_CPP_GPU_LAYERS', (value) =>
          parseInteger(Number(value), 'LLAMA_CPP_GPU_LAYERS', 1, 999),
        ) ??
        stored.llamaCpp?.gpuLayers ??
        20,
      splitMode:
        parseEnvironmentOverride('LLAMA_CPP_SPLIT_MODE', (value) =>
          parseEnum(value, ['layer', 'row'], 'LLAMA_CPP_SPLIT_MODE'),
        ) ??
        stored.llamaCpp?.splitMode ??
        'layer',
      mainGpu:
        parseEnvironmentOverride('LLAMA_CPP_MAIN_GPU', (value) =>
          parseInteger(Number(value), 'LLAMA_CPP_MAIN_GPU', 0, 31),
        ) ??
        stored.llamaCpp?.mainGpu ??
        0,
      tensorSplit:
        parseEnvironmentOverride('LLAMA_CPP_TENSOR_SPLIT', parseTensorSplit) ??
        stored.llamaCpp?.tensorSplit,
      threads:
        parseEnvironmentOverride('LLAMA_CPP_THREADS', (value) =>
          parseInteger(Number(value), 'LLAMA_CPP_THREADS', -1, 1024),
        ) ??
        stored.llamaCpp?.threads ??
        -1,
      flashAttention:
        parseEnvironmentOverride('LLAMA_CPP_FLASH_ATTENTION', (value) =>
          parseEnum(value, ['auto', 'on', 'off'], 'LLAMA_CPP_FLASH_ATTENTION'),
        ) ??
        stored.llamaCpp?.flashAttention ??
        'auto',
      kvCache:
        parseEnvironmentOverride('LLAMA_CPP_KV_CACHE', (value) =>
          parseEnum(value, KV_CACHE_PROFILES, 'LLAMA_CPP_KV_CACHE'),
        ) ??
        stored.llamaCpp?.kvCache ??
        'quality',
      speculative:
        parseEnvironmentOverride('LLAMA_CPP_SPECULATIVE', (value) =>
          parseEnum(value, SPECULATIVE_MODES, 'LLAMA_CPP_SPECULATIVE'),
        ) ??
        stored.llamaCpp?.speculative ??
        'auto',
      reasoningEffort:
        parseEnvironmentOverride('LLAMA_CPP_REASONING_EFFORT', (value) =>
          parseEnum(value, REASONING_EFFORTS, 'LLAMA_CPP_REASONING_EFFORT'),
        ) ??
        stored.llamaCpp?.reasoningEffort ??
        'medium',
      idleUnloadMinutes:
        parseEnvironmentOverride('LLAMA_CPP_IDLE_UNLOAD_MINUTES', (value) =>
          parseInteger(Number(value), 'LLAMA_CPP_IDLE_UNLOAD_MINUTES', 0, MAX_IDLE_UNLOAD_MINUTES),
        ) ??
        stored.llamaCpp?.idleUnloadMinutes ??
        0,
    },
    openRouter: {
      baseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(
        /\/$/,
        '',
      ),
      apiKeyConfigured: Boolean(resolveApiKey()),
      enforceZdr: stored.schemaVersion === 2 ? (stored.openRouter?.enforceZdr ?? false) : false,
      denyDataCollection:
        stored.schemaVersion === 2 ? (stored.openRouter?.denyDataCollection ?? false) : false,
    },
    localApi: {
      enabled: stored.localApi?.enabled ?? true,
      apiKeyConfigured: Boolean(environmentLocalApiKey() || stored.localApi?.apiKey),
      apiKeySource: environmentLocalApiKey()
        ? 'env'
        : stored.localApi?.apiKey
          ? 'settings'
          : 'none',
      networkAccess: stored.localApi?.networkAccess ?? false,
      networkPort: stored.localApi?.networkPort ?? DEFAULT_LOCAL_API_NETWORK_PORT,
    },
    diagnostics: {
      persistErrorLogs:
        stored.schemaVersion === 2 ? (stored.diagnostics?.persistErrorLogs ?? true) : true,
    },
  };
};

export const updateGenerationConfig = async (
  update: GenerationConfigUpdate,
): Promise<PublicGenerationConfig> => {
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    throw new ValidationError('Invalid generation config');
  }
  const current = await readStoredConfig();
  const llamaUpdate = update.llamaCpp;
  const openRouterUpdate = update.openRouter;
  const diagnosticsUpdate = update.diagnostics;
  const localApiUpdate = update.localApi;
  if (
    localApiUpdate !== undefined &&
    (typeof localApiUpdate !== 'object' || Array.isArray(localApiUpdate))
  ) {
    throw new ValidationError('Invalid localApi config', { field: 'localApi' });
  }
  if (
    llamaUpdate !== undefined &&
    (typeof llamaUpdate !== 'object' || Array.isArray(llamaUpdate))
  ) {
    throw new ValidationError('Invalid llamaCpp config', { field: 'llamaCpp' });
  }
  if (
    diagnosticsUpdate !== undefined &&
    (typeof diagnosticsUpdate !== 'object' || Array.isArray(diagnosticsUpdate))
  ) {
    throw new ValidationError('Invalid diagnostics config', { field: 'diagnostics' });
  }
  if (
    openRouterUpdate !== undefined &&
    (typeof openRouterUpdate !== 'object' || Array.isArray(openRouterUpdate))
  ) {
    throw new ValidationError('Invalid openRouter config', { field: 'openRouter' });
  }

  let nextSessionOpenRouterApiKey = sessionOpenRouterApiKey;
  if (openRouterUpdate?.apiKey !== undefined) {
    if (
      typeof openRouterUpdate.apiKey !== 'string' ||
      openRouterUpdate.apiKey.length > 4096 ||
      openRouterUpdate.apiKey.includes('\0')
    ) {
      throw new ValidationError('Invalid apiKey', { field: 'apiKey' });
    }
    nextSessionOpenRouterApiKey = openRouterUpdate.apiKey.trim();
  }
  const clearApiKey = parseBoolean(openRouterUpdate?.clearApiKey, 'clearApiKey');
  if (clearApiKey === true) nextSessionOpenRouterApiKey = '';

  // An omitted or empty key keeps the saved one; only clearApiKey removes it.
  let localApiKey = current.localApi?.apiKey;
  if (localApiUpdate?.apiKey !== undefined) {
    localApiKey = parseLocalApiKey(localApiUpdate.apiKey) || localApiKey;
  }
  if (parseBoolean(localApiUpdate?.clearApiKey, 'clearApiKey') === true) {
    localApiKey = undefined;
  }

  const next: StoredGenerationConfig = {
    schemaVersion: 2,
    llamaCpp: {
      executablePath:
        llamaUpdate?.executablePath !== undefined
          ? parsePath(llamaUpdate.executablePath, 'executablePath')
          : current.llamaCpp?.executablePath,
      baseUrl:
        llamaUpdate?.baseUrl !== undefined
          ? parseLocalBaseUrl(llamaUpdate.baseUrl, 'baseUrl')
          : current.llamaCpp?.baseUrl,
      modelDirectories:
        parseDirectories(llamaUpdate?.modelDirectories) ?? current.llamaCpp?.modelDirectories ?? [],
      downloadDirectory:
        (llamaUpdate?.downloadDirectory !== undefined
          ? parsePath(llamaUpdate.downloadDirectory, 'downloadDirectory')
          : current.llamaCpp?.downloadDirectory) ?? undefined,
      contextSize:
        parseContextSize(llamaUpdate?.contextSize) ?? current.llamaCpp?.contextSize ?? 8192,
      acceleration:
        parseEnum(
          llamaUpdate?.acceleration,
          ['auto', 'cpu', 'gpu', 'hybrid', 'multi-gpu'],
          'acceleration',
        ) ??
        current.llamaCpp?.acceleration ??
        'auto',
      gpuLayers:
        parseInteger(llamaUpdate?.gpuLayers, 'gpuLayers', 1, 999) ??
        current.llamaCpp?.gpuLayers ??
        20,
      splitMode:
        parseEnum(llamaUpdate?.splitMode, ['layer', 'row'], 'splitMode') ??
        current.llamaCpp?.splitMode ??
        'layer',
      mainGpu:
        parseInteger(llamaUpdate?.mainGpu, 'mainGpu', 0, 31) ?? current.llamaCpp?.mainGpu ?? 0,
      tensorSplit:
        llamaUpdate?.tensorSplit !== undefined
          ? parseTensorSplit(llamaUpdate.tensorSplit)
          : current.llamaCpp?.tensorSplit,
      threads:
        parseInteger(llamaUpdate?.threads, 'threads', -1, 1024) ?? current.llamaCpp?.threads ?? -1,
      flashAttention:
        parseEnum(llamaUpdate?.flashAttention, ['auto', 'on', 'off'], 'flashAttention') ??
        current.llamaCpp?.flashAttention ??
        'auto',
      kvCache:
        parseEnum(llamaUpdate?.kvCache, KV_CACHE_PROFILES, 'kvCache') ??
        current.llamaCpp?.kvCache ??
        'quality',
      speculative:
        parseEnum(llamaUpdate?.speculative, SPECULATIVE_MODES, 'speculative') ??
        current.llamaCpp?.speculative ??
        'auto',
      reasoningEffort:
        parseEnum(llamaUpdate?.reasoningEffort, REASONING_EFFORTS, 'reasoningEffort') ??
        current.llamaCpp?.reasoningEffort ??
        'medium',
      idleUnloadMinutes:
        parseInteger(
          llamaUpdate?.idleUnloadMinutes,
          'idleUnloadMinutes',
          0,
          MAX_IDLE_UNLOAD_MINUTES,
        ) ??
        current.llamaCpp?.idleUnloadMinutes ??
        0,
    },
    openRouter: {
      enforceZdr:
        parseBoolean(openRouterUpdate?.enforceZdr, 'enforceZdr') ??
        (current.schemaVersion === 2 ? current.openRouter?.enforceZdr : undefined) ??
        false,
      denyDataCollection:
        parseBoolean(openRouterUpdate?.denyDataCollection, 'denyDataCollection') ??
        (current.schemaVersion === 2 ? current.openRouter?.denyDataCollection : undefined) ??
        false,
    },
    localApi: {
      enabled:
        parseBoolean(localApiUpdate?.enabled, 'enabled') ?? current.localApi?.enabled ?? true,
      apiKey: localApiKey,
      networkAccess:
        parseBoolean(localApiUpdate?.networkAccess, 'networkAccess') ??
        current.localApi?.networkAccess ??
        false,
      networkPort:
        parseInteger(localApiUpdate?.networkPort, 'networkPort', 1, 65_535) ??
        current.localApi?.networkPort ??
        DEFAULT_LOCAL_API_NETWORK_PORT,
    },
    diagnostics: {
      persistErrorLogs:
        parseBoolean(diagnosticsUpdate?.persistErrorLogs, 'persistErrorLogs') ??
        (current.schemaVersion === 2 ? current.diagnostics?.persistErrorLogs : undefined) ??
        true,
    },
  };

  const path = generationConfigPath();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, path);
  sessionOpenRouterApiKey = nextSessionOpenRouterApiKey;
  return getGenerationConfig();
};

export const generationPathExists = (path: string): boolean => existsSync(path);
