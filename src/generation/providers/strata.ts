import { getStrataApiKey, getStrataBaseUrl } from '../config.js';
import { openAiCompatibleChat, openAiCompatibleChatStream } from '../openai-compatible.js';
import type { GenerationModel, GenerationProvider, GenerationProviderStatus } from '../types.js';

const STATUS_TIMEOUT_MS = 2_000;
const MODELS_TIMEOUT_MS = 10_000;

const notRunning = (baseUrl: string): string =>
  `Strata is not running at ${baseUrl}. Start it (for example with START-HERE.bat) and try again.`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;

const unavailable = (detail: string): GenerationProviderStatus => ({
  id: 'strata',
  label: 'Strata',
  available: false,
  local: true,
  detail,
});

/**
 * One `/v1/models` entry. Strata reports `status.value` per model; a missing
 * status means the server did not say, and a server only lists what it serves,
 * so that counts as loaded. Any explicit other value (`loading`, `unloaded`)
 * does not.
 */
export const parseStrataModel = (entry: unknown): GenerationModel | undefined => {
  if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.trim()) return undefined;
  const status = isRecord(entry.status) ? entry.status.value : undefined;
  const meta = isRecord(entry.meta) ? entry.meta : undefined;
  return {
    id: entry.id,
    name: entry.id,
    provider: 'strata',
    contextLength: positiveInteger(meta?.n_ctx),
    loaded: status === undefined || status === 'loaded',
  };
};

/**
 * Every request to Strata refuses redirects: the URL is checked to be loopback,
 * and following a 307/308 to another host would send the conversation off the
 * machine. A configured key is sent as a Bearer token.
 */
const strataInit = (init: RequestInit = {}): RequestInit => {
  const apiKey = getStrataApiKey();
  const headers = new Headers(init.headers);
  if (apiKey) headers.set('Authorization', `Bearer ${apiKey}`);
  return { ...init, headers, redirect: 'error' };
};

/**
 * Turns a refused/unreachable connection into a message that names the URL.
 * An abort stays an abort so cancellation is not reported as an outage.
 */
const strataFetch =
  (fetchImpl: typeof fetch, baseUrl: string): typeof fetch =>
  async (input, init) => {
    try {
      return await fetchImpl(input, strataInit(init));
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      throw new Error(notRunning(baseUrl), { cause: error });
    }
  };

/**
 * A separately started Strata server (OpenAI-compatible, loopback-only).
 * ThreadShelf never launches or unloads it; it only talks to `/health` and `/v1`.
 */
export const createStrataProvider = (fetchImpl: typeof fetch = fetch): GenerationProvider => ({
  id: 'strata',
  label: 'Strata',
  local: true,

  async status() {
    let baseUrl: string;
    try {
      baseUrl = getStrataBaseUrl();
    } catch (error) {
      // An invalid environment value must not break the whole settings response.
      return unavailable(error instanceof Error ? error.message : 'Invalid STRATA_BASE_URL');
    }
    let response: Response;
    try {
      response = await fetchImpl(
        `${baseUrl}/health`,
        strataInit({ signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) }),
      );
    } catch {
      return unavailable(notRunning(baseUrl));
    }
    const health: unknown = await response.json().catch(() => undefined);
    const record = isRecord(health) ? health : {};
    const model = typeof record.model === 'string' ? record.model : undefined;
    const state = typeof record.status === 'string' ? record.status : undefined;
    if (!response.ok || record.loaded === false) {
      return unavailable(
        `Strata at ${baseUrl} is not ready (${state ?? `HTTP ${response.status}`}).`,
      );
    }
    return {
      id: 'strata',
      label: 'Strata',
      available: true,
      local: true,
      detail: `Strata at ${baseUrl}${model ? ` · ${model}` : ''}`,
    };
  },

  async listModels(): Promise<GenerationModel[]> {
    const baseUrl = getStrataBaseUrl();
    let response: Response;
    try {
      response = await fetchImpl(
        `${baseUrl}/v1/models`,
        strataInit({ signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) }),
      );
    } catch (error) {
      throw new Error(notRunning(baseUrl), { cause: error });
    }
    if (!response.ok) {
      throw new Error(`Strata models request failed (HTTP ${response.status}) at ${baseUrl}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(`Strata at ${baseUrl} returned an invalid models list (not JSON)`, {
        cause: error,
      });
    }
    if (!isRecord(payload) || (payload.data !== undefined && !Array.isArray(payload.data))) {
      throw new Error(`Strata at ${baseUrl} returned an invalid models list`);
    }
    const seen = new Set<string>();
    return ((payload.data as unknown[] | undefined) ?? [])
      .map(parseStrataModel)
      .filter((model): model is GenerationModel => {
        if (!model || seen.has(model.id)) return false;
        seen.add(model.id);
        return true;
      });
  },

  async chat(request, signal) {
    const baseUrl = getStrataBaseUrl();
    return openAiCompatibleChat({
      provider: 'strata',
      baseUrl: `${baseUrl}/v1`,
      request,
      signal,
      fetchImpl: strataFetch(fetchImpl, baseUrl),
    });
  },

  async chatStream(request, onDelta, signal) {
    const baseUrl = getStrataBaseUrl();
    return openAiCompatibleChatStream(
      {
        provider: 'strata',
        baseUrl: `${baseUrl}/v1`,
        request,
        signal,
        fetchImpl: strataFetch(fetchImpl, baseUrl),
      },
      onDelta,
    );
  },
});
