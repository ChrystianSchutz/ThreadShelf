export type View = 'search' | 'chat' | 'insights' | 'indexing' | 'mcp' | 'settings';

export type SearchMode = 'semantic' | 'keyword';

export interface Provider {
  readonly label: string;
  readonly short: string;
  readonly color: string;
}

export interface CollectionStats {
  readonly collection?: string;
  readonly files: number;
  readonly conversations: number;
  readonly chunks: number;
  readonly roles: Readonly<RoleCounts>;
  readonly isEmpty: boolean;
  readonly collections?: CollectionStats[];
}

export interface RoleCounts {
  user: number;
  thinking: number;
  ai: number;
}

export interface SearchResultMetadata {
  readonly role: string;
  readonly provider?: string;
  readonly sourceFile: string;
  readonly collection?: string;
  readonly conversationKey?: string;
  readonly title?: string;
  readonly turnIndex?: number;
  readonly model?: string;
  readonly createdAt?: string;
  readonly createdInThreadShelf?: boolean;
  readonly generationProvider?: GenerationProviderId;
}

export interface SearchResult {
  readonly document: string;
  readonly distance?: number;
  readonly metadata: SearchResultMetadata;
}

export interface ConversationListItem {
  readonly sourceFile: string;
  readonly collection: string;
  readonly conversationKey?: string;
  readonly title?: string;
  readonly turnCount?: number;
  readonly provider?: string;
  readonly lastTurnAt?: string;
  readonly createdInThreadShelf?: boolean;
  readonly hasThreadShelfTurns?: boolean;
}

export type ConversationSort = 'recent' | 'longest' | 'title';

export interface SavedSearch {
  readonly id: string;
  readonly q: string;
  readonly collection: string;
  readonly mode: SearchMode;
  readonly model?: string;
  readonly from?: string;
  readonly to?: string;
  readonly savedAt: string;
}

export interface PinnedConversation {
  readonly collection: string;
  readonly sourceFile: string;
  readonly conversationKey?: string;
  readonly title?: string;
  readonly provider?: string;
}

export interface ActivityBucket {
  readonly month: string;
  readonly count: number;
}

export interface ModelCount {
  readonly model: string;
  readonly count: number;
}

export interface ProviderInsight {
  readonly provider: string;
  readonly conversations: number;
  readonly turns: number;
}

export interface LongestThread {
  readonly collection: string;
  readonly sourceFile: string;
  readonly conversationKey: string;
  readonly title: string;
  readonly provider: string;
  readonly turnCount: number;
  readonly lastTurnAt: string;
}

export interface ArchiveInsights {
  readonly collection: string;
  readonly totals: {
    readonly collections: number;
    readonly files: number;
    readonly chunks: number;
    readonly conversations: number;
    readonly turns: number;
  };
  readonly roles: Readonly<RoleCounts>;
  readonly activity: ActivityBucket[];
  readonly topModels: ModelCount[];
  readonly providers: ProviderInsight[];
  readonly longestThreads: LongestThread[];
  readonly firstActivity: string | null;
  readonly lastActivity: string | null;
}

export interface ThreadTurn {
  readonly user?: string;
  readonly thinking?: string;
  readonly ai?: string;
  readonly model?: string;
  readonly createdAt?: string;
  readonly createdInThreadShelf?: boolean;
  readonly generationProvider?: GenerationProviderId;
}

export interface ThreadShelfChatSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turnCount: number;
  readonly model?: string;
  readonly createdInThreadShelf: true;
}

export interface ThreadShelfChat extends ThreadShelfChatSummary {
  readonly turns: ThreadTurn[];
}

export interface ThreadContext {
  readonly sourceFile: string;
  readonly collection: string;
  readonly conversationKey?: string;
  readonly title?: string;
  readonly matchIdx?: number;
  readonly provider?: string;
  readonly model?: string;
}

export interface IngestProgress {
  readonly pct: number;
  readonly step: string;
  readonly chunks?: number;
  readonly time?: number;
  readonly file?: string;
}

export interface IngestResultSummary {
  readonly conversations?: number;
  readonly ingested?: number;
  readonly files?: readonly string[];
  readonly elapsedMs?: number;
  readonly errors?: readonly string[];
}

export interface IngestStreamEvent {
  readonly status?: 'starting' | 'progress' | 'completed' | 'error' | string;
  readonly phase?: string;
  readonly totalFiles?: number;
  readonly processedFiles?: number;
  readonly currentFile?: string;
  readonly totalChunks?: number;
  readonly elapsedMs?: number;
  readonly error?: string;
  readonly result?: IngestResultSummary;
}

export interface StatusMessage {
  readonly type: 'info' | 'err';
  readonly text: string;
}

export interface FilePreview {
  readonly name: string;
  readonly ok: boolean;
  readonly note?: string;
}

export interface RoleFilters {
  user: boolean;
  thinking: boolean;
  ai: boolean;
}

export type GenerationProviderId = 'llama-cpp' | 'openrouter';
export type OpenRouterModelSort = 'default' | 'most-popular' | 'newest';
export type LlamaAccelerationMode = 'auto' | 'cpu' | 'gpu' | 'hybrid' | 'multi-gpu';
export type LlamaSplitMode = 'layer' | 'row';
export type LlamaFlashAttention = 'auto' | 'on' | 'off';

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

export interface FavoriteGenerationModel {
  readonly provider: GenerationProviderId;
  readonly id: string;
  readonly name: string;
}

export interface GenerationRuntimeStatus {
  readonly state: 'stopped' | 'starting' | 'ready' | 'external' | 'remote';
  readonly model?: string;
  readonly contextSize?: number;
  readonly detail: string;
}

export interface GenerationModelsResponse {
  readonly provider: GenerationProviderId;
  readonly models: GenerationModel[];
  readonly runtime: GenerationRuntimeStatus;
}

export interface GenerationRuntimeResponse {
  readonly backend: 'llama.cpp';
  readonly runtime: GenerationRuntimeStatus;
}

export interface LlamaDeviceInfo {
  readonly id: string;
  readonly name: string;
  readonly totalBytes: number;
  readonly freeBytes: number;
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
  readonly offload: {
    readonly mode: 'cpu' | 'gpu' | 'hybrid' | 'unknown';
    readonly gpuLayers?: number;
    readonly totalLayers?: number;
    readonly gpuPercent?: number;
    readonly cpuPercent?: number;
    readonly deviceBufferMiB?: Readonly<Record<string, number>>;
  };
}

export type CatalogSort = 'downloads' | 'likes' | 'trending' | 'recent';
export type CatalogGating = false | 'auto' | 'manual';
export type CatalogFit = 'fits' | 'tight' | 'too-large';

export interface HardwareProfile {
  readonly devices: readonly LlamaDeviceInfo[];
  readonly detectionSource: 'llama.cpp' | 'nvidia-smi' | 'none';
  readonly totalRamBytes: number;
  readonly freeRamBytes: number;
  readonly vramBudgetBytes: number;
  readonly modelBudgetBytes: number;
  readonly suggestedVariant: 'cpu' | 'cuda' | 'vulkan';
}

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

export interface CatalogQuant {
  readonly label: string;
  readonly totalBytes: number;
  readonly shards: number;
  readonly recommended: boolean;
  readonly fit: CatalogFit;
  readonly files: readonly { readonly path: string; readonly sizeBytes: number }[];
}

export interface CatalogModelDetail extends CatalogModelSummary {
  readonly quants: readonly CatalogQuant[];
  readonly projectors: readonly { readonly path: string; readonly sizeBytes: number }[];
  readonly license?: string;
}

export interface CatalogSearchResponse {
  readonly models: readonly CatalogModelSummary[];
  readonly source: string;
  readonly tokenConfigured: boolean;
  readonly hardware: HardwareProfile;
}

export interface CatalogModelResponse {
  readonly model: CatalogModelDetail;
  readonly hardware: HardwareProfile;
  readonly tokenConfigured: boolean;
}

export type CatalogDownloadEvent =
  | { readonly type: 'plan'; readonly plan: { readonly totalBytes: number } }
  | {
      readonly type: 'progress';
      readonly phase: 'downloading' | 'verifying' | 'skipped' | 'completed';
      readonly file?: string;
      readonly downloadedBytes?: number;
      readonly totalBytes?: number;
    }
  | { readonly type: 'done'; readonly primaryPath: string; readonly directory: string }
  | { readonly type: 'error'; readonly error: string };

export interface QuickSetupPlan {
  readonly hardware: HardwareProfile;
  readonly runtime: {
    readonly action: 'install' | 'reuse';
    readonly variant: string;
    readonly tag: string;
    readonly url?: string;
    readonly sha256?: string;
    readonly sizeBytes?: number;
    readonly companions: readonly {
      readonly url: string;
      readonly sha256: string;
      readonly sizeBytes?: number;
    }[];
    readonly destination: string;
    readonly executablePath?: string;
    readonly releaseUrl?: string;
  };
  readonly model?: {
    readonly action: 'download' | 'reuse';
    readonly repoId: string;
    readonly quant: string;
    readonly totalBytes: number;
    readonly directory: string;
    readonly files: readonly {
      readonly url: string;
      readonly sha256?: string;
      readonly sizeBytes: number;
    }[];
    readonly license?: string;
    readonly contextLength?: number;
    readonly fit: CatalogFit;
  };
  readonly totalDownloadBytes: number;
  readonly warnings: readonly string[];
}

export type QuickSetupEvent =
  | { readonly type: 'plan'; readonly plan: QuickSetupPlan }
  | {
      readonly type: 'progress';
      readonly step: 'runtime' | 'model' | 'done';
      readonly phase?: string;
      readonly percent?: number;
      readonly file?: string;
    }
  | { readonly type: 'done'; readonly executablePath: string; readonly modelPath?: string }
  | { readonly type: 'error'; readonly error: string };

export interface DirectoryBrowserResponse {
  readonly path: string;
  readonly parent?: string;
  readonly roots: readonly { readonly name: string; readonly path: string }[];
  readonly directories: readonly { readonly name: string; readonly path: string }[];
  readonly truncated: boolean;
}

export interface GenerationProviderStatus {
  readonly id: GenerationProviderId;
  readonly label: string;
  readonly available: boolean;
  readonly local: boolean;
  readonly detail: string;
}

export interface GenerationConfig {
  readonly experimentalAlpha: true;
  readonly llamaCpp: {
    readonly executablePath?: string;
    readonly baseUrl?: string;
    readonly modelDirectories: readonly string[];
    readonly defaultModelDirectories: readonly string[];
    readonly contextSize: number;
    readonly acceleration: LlamaAccelerationMode;
    readonly gpuLayers: number;
    readonly splitMode: LlamaSplitMode;
    readonly mainGpu: number;
    readonly tensorSplit?: string;
    readonly threads: number;
    readonly flashAttention: LlamaFlashAttention;
  };
  readonly openRouter: {
    readonly baseUrl: string;
    readonly apiKeyConfigured: boolean;
    readonly enforceZdr: boolean;
    readonly denyDataCollection: boolean;
  };
  readonly diagnostics: {
    readonly persistErrorLogs: boolean;
  };
}

export interface GenerationConfigResponse {
  readonly config: GenerationConfig;
  readonly providers: readonly GenerationProviderStatus[];
}

export interface ContinuationMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly reasoning?: string;
  readonly model?: string;
  readonly usage?: GenerationResponse['usage'];
  readonly performance?: GenerationResponse['performance'];
  readonly contextWindowTokens?: number;
}

interface GenerationChatCommonInput {
  readonly provider: GenerationProviderId;
  readonly model: string;
  readonly prompt: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly openRouterZdr?: boolean;
  /** Master prompt prepended as a system message. Not stored with the chat. */
  readonly systemPrompt?: string;
}

/** A reusable master prompt, stored on the local server in `.threadshelf/`. */
export interface MasterPrompt {
  readonly id: string;
  readonly name: string;
  readonly text: string;
  readonly updatedAt: string;
}

export interface MasterPromptCollection {
  readonly prompts: readonly MasterPrompt[];
  /** '' when no master prompt is active. */
  readonly activeId: string;
}

export type GenerationChatInput = GenerationChatCommonInput &
  (
    | { readonly threadId: string }
    | {
        readonly ephemeral: true;
        readonly continuation?: readonly ContinuationMessage[];
      }
    | {
        readonly sourceFile: string;
        readonly collection: string;
        readonly conversationKey?: string;
        readonly continuation?: readonly ContinuationMessage[];
      }
  );

export interface GenerationResponse {
  readonly provider: GenerationProviderId;
  readonly model: string;
  readonly content: string;
  readonly reasoning?: string;
  readonly usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  readonly performance?: {
    readonly completionTokensPerSecond: number;
    readonly promptTokensPerSecond?: number;
    readonly generationMs?: number;
    readonly source: 'provider' | 'measured';
  };
  readonly persistence?: {
    readonly saved: boolean;
    readonly indexed: boolean;
    readonly indexedChunks: number;
    readonly warning?: string;
  };
}

export type GenerationStreamEvent =
  | {
      readonly type: 'status';
      readonly phase: 'preparing' | 'loading-model' | 'connecting' | 'generating' | 'saving';
      readonly message: string;
      readonly provider?: GenerationProviderId;
      readonly model?: string;
    }
  | {
      readonly type: 'delta';
      readonly content?: string;
      readonly reasoning?: string;
      readonly model?: string;
    }
  | { readonly type: 'done'; readonly response: GenerationResponse }
  | { readonly type: 'error'; readonly error: string };
