export type GenerationProviderId = 'llama-cpp' | 'openrouter';
export type OpenRouterModelSort = 'default' | 'most-popular' | 'newest';

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly ChatToolCall[];
  /** Opaque provider state, replayed only within the current tool loop. */
  readonly reasoning_details?: readonly Readonly<Record<string, unknown>>[];
}

export interface ChatToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}
export interface ChatTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: {
      readonly type: 'object';
      readonly properties: Record<string, unknown>;
      readonly required: readonly string[];
      readonly additionalProperties: false;
    };
  };
}

export interface ChatRequest {
  readonly provider: GenerationProviderId;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ChatTool[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  /** Per-request OpenRouter routing override. Omitted for other providers. */
  readonly openRouterZdr?: boolean;
  /** False for private tab-scoped chats, which must never write diagnostics to disk. */
  readonly persistDiagnostics?: boolean;
}

export interface ChatResponse {
  readonly provider: GenerationProviderId;
  readonly model: string;
  readonly content: string;
  readonly toolCalls?: readonly ChatToolCall[];
  readonly reasoningDetails?: readonly Readonly<Record<string, unknown>>[];
  readonly reasoning?: string;
  readonly usage?: {
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly totalTokens?: number;
  };
  readonly performance?: {
    readonly completionTokensPerSecond: number;
    readonly promptTokensPerSecond?: number;
    readonly generationMs?: number;
    readonly source: 'provider' | 'measured';
  };
}

export interface ChatDelta {
  readonly content?: string;
  readonly reasoning?: string;
  readonly model?: string;
}

export type ChatDeltaHandler = (delta: ChatDelta) => void | Promise<void>;

export interface GenerationModel {
  readonly id: string;
  readonly name: string;
  readonly provider: GenerationProviderId;
  readonly path?: string;
  readonly sizeBytes?: number;
  readonly contextLength?: number;
  readonly promptPrice?: string;
  readonly completionPrice?: string;
  readonly createdAt?: string;
  readonly loaded?: boolean;
}

export interface GenerationModelListOptions {
  readonly sort?: OpenRouterModelSort;
  readonly freeOnly?: boolean;
}

export interface GenerationRuntimeStatus {
  readonly state: 'stopped' | 'starting' | 'ready' | 'external' | 'remote';
  readonly model?: string;
  /** Effective context window of the managed llama.cpp process. */
  readonly contextSize?: number;
  readonly detail: string;
}

export interface LlamaDeviceInfo {
  readonly id: string;
  readonly name: string;
  readonly totalBytes: number;
  readonly freeBytes: number;
}

export interface LlamaOffloadInfo {
  readonly mode: 'cpu' | 'gpu' | 'hybrid' | 'unknown';
  readonly gpuLayers?: number;
  readonly totalLayers?: number;
  readonly gpuPercent?: number;
  readonly cpuPercent?: number;
  readonly deviceBufferMiB?: Readonly<Record<string, number>>;
}

export interface LlamaRuntimeDiagnostics {
  readonly runtime: GenerationRuntimeStatus;
  readonly source: 'managed' | 'external' | 'none';
  readonly executable?: string;
  readonly arguments?: readonly string[];
  readonly startedAt?: string;
  readonly logs: string;
  readonly logsTruncated: boolean;
  readonly devices: readonly LlamaDeviceInfo[];
  readonly deviceDetectionSupported: boolean;
  readonly offload: LlamaOffloadInfo;
  /** Resolved performance profile of the latest managed launch. */
  readonly profile?: readonly LlamaRuntimeProfileEntry[];
}

export interface LlamaRuntimeProfileEntry {
  readonly setting: string;
  readonly value: string;
  /**
   * settings = saved or environment value; threadshelf = wrapper default;
   * model = derived from GGUF metadata; runtime = limited by llama-server.
   */
  readonly source: 'settings' | 'threadshelf' | 'model' | 'runtime';
  readonly applied: boolean;
  readonly note?: string;
}

export interface GenerationProviderStatus {
  readonly id: GenerationProviderId;
  readonly label: string;
  readonly available: boolean;
  readonly local: boolean;
  readonly detail: string;
}

export interface GenerationProvider {
  readonly id: GenerationProviderId;
  readonly label: string;
  readonly local: boolean;
  status(): Promise<GenerationProviderStatus>;
  listModels(options?: GenerationModelListOptions): Promise<GenerationModel[]>;
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
  chatStream(
    request: ChatRequest,
    onDelta: ChatDeltaHandler,
    signal?: AbortSignal,
  ): Promise<ChatResponse>;
}
