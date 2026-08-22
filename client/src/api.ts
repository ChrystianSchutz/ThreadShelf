import type {
  ArchiveInsights,
  CollectionStats,
  ConversationListItem,
  IngestStreamEvent,
  SearchResult,
  ThreadTurn,
  GenerationConfigResponse,
  GenerationChatInput,
  GenerationModelsResponse,
  GenerationProviderId,
  GenerationResponse,
  GenerationRuntimeResponse,
  LlamaRuntimeDiagnostics,
  GenerationStreamEvent,
  MasterPromptCollection,
  DirectoryBrowserResponse,
  CatalogDownloadEvent,
  CatalogModelResponse,
  CatalogSearchResponse,
  CatalogSort,
  HardwareProfile,
  QuickSetupEvent,
  QuickSetupPlan,
  OpenRouterModelSort,
  ThreadShelfChat,
  ThreadShelfChatSummary,
} from './types';

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly field?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const request = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = data as { error?: string; field?: string };
    throw new ApiError(response.status, err.error ?? response.statusText, err.field);
  }
  return data as T;
};

const buildUrl = (path: string, params?: Record<string, string | undefined>): string => {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
  }
  return url.toString();
};

interface NdjsonReaderLike {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
}

const parseNdjsonLine = <T>(line: string): T => {
  try {
    return JSON.parse(line) as T;
  } catch (error) {
    const preview = line.length > 120 ? `${line.slice(0, 117)}...` : line;
    const parseError = new Error(`Invalid NDJSON event: ${preview}`) as Error & { cause?: unknown };
    parseError.cause = error;
    throw parseError;
  }
};

export const readNdjsonStream = async <T = Record<string, unknown>>(
  response: Response,
  onEvent: (event: T) => void,
  createDecoder: () => TextDecoder = () => new TextDecoder(),
): Promise<void> => {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const err = data as { error?: string; field?: string };
    throw new ApiError(response.status, err.error ?? response.statusText, err.field);
  }
  if (!response.body) {
    throw new Error('Streaming response is not available in this browser.');
  }

  const reader: NdjsonReaderLike = response.body.getReader();
  const decoder = createDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) {
        onEvent(parseNdjsonLine<T>(line));
      }
      newlineIndex = buffer.indexOf('\n');
    }

    if (done) {
      const tail = buffer.trim();
      if (tail) {
        onEvent(parseNdjsonLine<T>(tail));
      }
      break;
    }
  }
};

export const api = {
  async health(signal?: AbortSignal): Promise<boolean> {
    // A long ingest can keep the event loop busy; without a timeout a single
    // hung ping would block the health query indefinitely.
    const timeout = AbortSignal.timeout(5000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const r = await fetch('/api/health', { signal: combined });
      return r.ok;
    } catch (e) {
      if (signal?.aborted) throw e; // caller cancelled — not a failed ping
      return false;
    }
  },

  collections(signal?: AbortSignal) {
    return request<{ collections: string[] }>('/api/collections', { signal });
  },

  createCollection(name: string) {
    return request<{ ok: boolean; collection: string }>('/api/collections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  },

  clearCollection(name: string) {
    return request<{ ok: boolean }>(`/api/collections/${encodeURIComponent(name)}/clear`, {
      method: 'POST',
    });
  },

  deleteCollection(name: string) {
    return request<{ ok: boolean }>(`/api/collections/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
  },

  collectionStats(name: string, signal?: AbortSignal) {
    return request<CollectionStats>(`/api/collections/${encodeURIComponent(name)}/stats`, {
      signal,
    });
  },

  allCollectionStats(signal?: AbortSignal) {
    return request<CollectionStats>('/api/collections/all/stats', { signal });
  },

  insights(collection: string, signal?: AbortSignal) {
    return request<ArchiveInsights>(buildUrl('/api/insights', { collection }), { signal });
  },

  files(collection: string, signal?: AbortSignal) {
    return request<{ files: ConversationListItem[] }>(buildUrl('/api/files', { collection }), {
      signal,
    });
  },

  search(
    params: {
      q: string;
      collection: string;
      n?: number;
      roles?: string;
      keywordBoost?: boolean;
      model?: string;
      from?: string;
      to?: string;
      mode?: string;
      origin?: 'threadshelf' | 'archive';
    },
    signal?: AbortSignal,
  ) {
    return request<{ results: SearchResult[] }>(
      buildUrl('/api/search', {
        q: params.q,
        collection: params.collection,
        n: params.n ? String(params.n) : undefined,
        roles: params.roles,
        keywordBoost: params.keywordBoost ? '1' : undefined,
        model: params.model || undefined,
        from: params.from || undefined,
        to: params.to || undefined,
        mode: params.mode === 'keyword' ? 'keyword' : undefined,
        origin: params.origin,
      }),
      { signal },
    );
  },

  thread(sourceFile: string, collection: string, conversationKey?: string, signal?: AbortSignal) {
    return request<{
      sourceFile: string;
      title?: string;
      conversationKey?: string;
      createdInThreadShelf: boolean;
      threadCreatedAt?: string;
      turns: ThreadTurn[];
    }>(buildUrl('/api/thread', { sourceFile, collection, conversationKey }), { signal });
  },

  masterPrompts(signal?: AbortSignal) {
    return request<MasterPromptCollection>('/api/generation/prompts', { signal });
  },

  createMasterPrompt(prompt: { name: string; text: string }) {
    return request<MasterPromptCollection>('/api/generation/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prompt),
    });
  },

  updateMasterPrompt(id: string, prompt: { name?: string; text?: string; active?: boolean }) {
    return request<MasterPromptCollection>(`/api/generation/prompts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prompt),
    });
  },

  deleteMasterPrompt(id: string) {
    return request<MasterPromptCollection>(`/api/generation/prompts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  /** An empty id turns the master prompt off without deleting it. */
  setActiveMasterPrompt(id: string) {
    return request<MasterPromptCollection>('/api/generation/prompts/active', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  },

  generationThreads(signal?: AbortSignal) {
    return request<{ threads: ThreadShelfChatSummary[] }>('/api/generation/threads', { signal });
  },

  createGenerationThread(title?: string, turns?: readonly ThreadTurn[]) {
    return request<ThreadShelfChat>('/api/generation/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, turns }),
    });
  },

  renameGenerationThread(id: string, title: string) {
    return request<ThreadShelfChat>(`/api/generation/threads/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
  },

  deleteGenerationThread(id: string) {
    return request<{ ok: true }>(`/api/generation/threads/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  generationThread(id: string, signal?: AbortSignal) {
    return request<ThreadShelfChat>(`/api/generation/threads/${encodeURIComponent(id)}`, {
      signal,
    });
  },

  generationConfig(signal?: AbortSignal) {
    return request<GenerationConfigResponse>('/api/generation/config', { signal });
  },

  updateGenerationConfig(update: {
    readonly llamaCpp?: {
      readonly executablePath?: string;
      readonly baseUrl?: string;
      readonly modelDirectories?: readonly string[];
      readonly contextSize?: number;
      readonly acceleration?: 'auto' | 'cpu' | 'gpu' | 'hybrid' | 'multi-gpu';
      readonly gpuLayers?: number;
      readonly splitMode?: 'layer' | 'row';
      readonly mainGpu?: number;
      readonly tensorSplit?: string;
      readonly threads?: number;
      readonly flashAttention?: 'auto' | 'on' | 'off';
    };
    readonly openRouter?: {
      readonly apiKey?: string;
      readonly clearApiKey?: boolean;
      readonly enforceZdr?: boolean;
      readonly denyDataCollection?: boolean;
    };
    readonly diagnostics?: {
      readonly persistErrorLogs?: boolean;
    };
  }) {
    return request<GenerationConfigResponse>('/api/generation/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    });
  },

  generationModels(
    provider: GenerationProviderId,
    options: {
      readonly signal?: AbortSignal;
      readonly sort?: OpenRouterModelSort;
      readonly freeOnly?: boolean;
    } = {},
  ) {
    return request<GenerationModelsResponse>(
      buildUrl('/api/generation/models', {
        provider,
        sort: options.sort && options.sort !== 'default' ? options.sort : undefined,
        free: options.freeOnly ? '1' : undefined,
      }),
      { signal: options.signal },
    );
  },

  generationRuntime(signal?: AbortSignal) {
    return request<GenerationRuntimeResponse>('/api/generation/runtime', { signal });
  },

  generationLlamaLogs(signal?: AbortSignal) {
    return request<LlamaRuntimeDiagnostics>('/api/generation/runtime/logs', { signal });
  },

  ejectGenerationModel(model?: string) {
    return request<GenerationRuntimeResponse>('/api/generation/runtime/eject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
  },

  generationHardware(signal?: AbortSignal) {
    return request<HardwareProfile>('/api/generation/hardware', { signal });
  },

  catalogSearch(
    options: { q?: string; sort?: CatalogSort; limit?: number } = {},
    signal?: AbortSignal,
  ) {
    return request<CatalogSearchResponse>(
      buildUrl('/api/generation/catalog/search', {
        q: options.q || undefined,
        sort: options.sort && options.sort !== 'downloads' ? options.sort : undefined,
        limit: options.limit ? String(options.limit) : undefined,
      }),
      { signal },
    );
  },

  catalogModel(id: string, signal?: AbortSignal) {
    return request<CatalogModelResponse>(buildUrl('/api/generation/catalog/model', { id }), {
      signal,
    });
  },

  async catalogDownload(
    input: { repoId: string; quant?: string; includeProjector?: boolean },
    onEvent: (event: CatalogDownloadEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch('/api/generation/catalog/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });
    await readNdjsonStream<CatalogDownloadEvent>(response, (event) => {
      onEvent(event);
      if (event.type === 'error') throw new Error(event.error);
    });
  },

  quickSetupPlan(variant?: string, signal?: AbortSignal) {
    return request<QuickSetupPlan>(buildUrl('/api/generation/setup/plan', { variant }), { signal });
  },

  async runQuickSetup(
    input: { variant?: string; model?: string; quant?: string },
    onEvent: (event: QuickSetupEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch('/api/generation/setup/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The server refuses to download anything without this flag; it is the
      // recorded consent for the whole plan shown on screen.
      body: JSON.stringify({ ...input, confirm: true }),
      signal,
    });
    await readNdjsonStream<QuickSetupEvent>(response, (event) => {
      onEvent(event);
      if (event.type === 'error') throw new Error(event.error);
    });
  },

  generationDirectories(path?: string, signal?: AbortSignal) {
    return request<DirectoryBrowserResponse>(buildUrl('/api/generation/directories', { path }), {
      signal,
    });
  },

  async continueThreadStream(
    input: GenerationChatInput,
    onEvent: (event: GenerationStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<GenerationResponse> {
    const response = await fetch('/api/generation/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });
    let completed: GenerationResponse | undefined;
    await readNdjsonStream<GenerationStreamEvent>(response, (event) => {
      onEvent(event);
      if (event.type === 'error') throw new Error(event.error);
      if (event.type === 'done') completed = event.response;
    });
    if (!completed) throw new Error('Generation stream ended before completion.');
    return completed;
  },

  continueThread(input: GenerationChatInput, signal?: AbortSignal) {
    return request<{
      provider: GenerationProviderId;
      model: string;
      content: string;
      reasoning?: string;
      usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
      performance?: GenerationResponse['performance'];
    }>('/api/generation/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });
  },

  ingestPreview(folderPath: string, collection: string, signal?: AbortSignal) {
    return request<{
      collection: string;
      files: string[];
      duplicates: Array<{ sourceFile: string; name: string; canonicalPath: string }>;
    }>(buildUrl('/api/ingest-preview', { folderPath, collection }), { signal });
  },

  async ingestUpload(files: File[], collectionName: string, clearFirst: boolean) {
    const fd = new FormData();
    fd.append('clearFirst', clearFirst ? 'true' : 'false');
    fd.append('collectionName', collectionName);
    for (const f of files) {
      fd.append((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, f);
    }
    return request<{
      status: string;
      result: { ingested: number; files: string[]; elapsedMs: number };
      collectionName: string;
    }>('/api/ingest-upload', { method: 'POST', body: fd });
  },

  async ingestUploadProgress(
    files: File[],
    collectionName: string,
    clearFirst: boolean,
    onEvent: (event: IngestStreamEvent) => void,
    signal?: AbortSignal,
  ) {
    const fd = new FormData();
    fd.append('clearFirst', clearFirst ? 'true' : 'false');
    fd.append('collectionName', collectionName);
    for (const f of files) {
      fd.append((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, f);
    }

    const response = await fetch('/api/ingest-upload-progress', {
      method: 'POST',
      body: fd,
      signal,
    });
    await readNdjsonStream<IngestStreamEvent>(response, onEvent);
  },

  async ingestPathProgress(
    folderPath: string,
    collection: string,
    clearFirst: boolean,
    onEvent: (event: IngestStreamEvent) => void,
    signal?: AbortSignal,
  ) {
    const response = await fetch('/api/ingest-progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folderPath,
        collection,
        clearFirst,
      }),
      signal,
    });
    await readNdjsonStream<IngestStreamEvent>(response, onEvent);
  },
};
