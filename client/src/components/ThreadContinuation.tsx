import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type {
  ContinuationMessage,
  GenerationConfigResponse,
  GenerationModel,
  GenerationRuntimeStatus,
  GenerationStreamEvent,
  GenerationProviderId,
  OpenRouterModelSort,
} from '../types';
import { toast } from '../toast';
import { useActiveMasterPromptText } from '../queries';
import { appendStableStreamChunk, compactModel, copyText } from '../utils';
import { Icons } from '../icons';
import { Markdown } from './Markdown';
import { MasterPromptMenu } from './MasterPromptMenu';
import { ModelCatalogModal } from './ModelCatalogModal';
import { ModelCombobox } from './ModelCombobox';
import { NumberCombobox } from './NumberCombobox';
import { LlamaLogPanel } from './LlamaLogPanel';

interface ThreadContinuationProps {
  readonly sourceFile?: string;
  readonly collection?: string;
  readonly conversationKey?: string;
  readonly threadId?: string;
  readonly attemptScope?: string;
  readonly ephemeral?: boolean;
  readonly draftSaved?: boolean;
  readonly onCreateThread?: () => Promise<string>;
  readonly initialMessages?: readonly ContinuationMessage[];
  readonly onCompleted?: () => void;
  readonly onMessagesChanged?: (messages: readonly ContinuationMessage[]) => void;
  readonly onRecoveryChanged?: (hasRecovery: boolean) => void;
  readonly onModelChanged?: (model: string) => void;
  readonly showThreadShelfTurns?: boolean;
}

const modelLabel = (model: GenerationModel): string => {
  const size = model.sizeBytes ? ` · ${(model.sizeBytes / 1024 ** 3).toFixed(1)} GB` : '';
  return `${model.loaded ? '● ' : ''}${model.name}${size}`;
};

interface InterruptedGeneration {
  readonly id: string;
  readonly prompt: string;
  readonly content: string;
  readonly reasoning: string;
  readonly model: string;
  readonly provider: GenerationProviderId;
  readonly error: string;
  readonly stopped: boolean;
  readonly createdAt: string;
}

const CONTEXT_SIZE_OPTIONS = [4096, 8192, 16_384, 32_768, 65_536, 131_072] as const;

const loadInterruptedGenerations = (key: string): InterruptedGeneration[] => {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (value): value is InterruptedGeneration =>
        Boolean(value) &&
        typeof value === 'object' &&
        typeof (value as InterruptedGeneration).id === 'string' &&
        typeof (value as InterruptedGeneration).prompt === 'string' &&
        typeof (value as InterruptedGeneration).content === 'string' &&
        typeof (value as InterruptedGeneration).reasoning === 'string' &&
        typeof (value as InterruptedGeneration).error === 'string',
    );
  } catch {
    return [];
  }
};

const attemptTranscript = (attempt: InterruptedGeneration): string =>
  [
    `Prompt:\n${attempt.prompt}`,
    attempt.reasoning ? `Reasoning (partial):\n${attempt.reasoning}` : '',
    attempt.content ? `Answer (partial):\n${attempt.content}` : '',
    `Failure:\n${attempt.error}`,
  ]
    .filter(Boolean)
    .join('\n\n');

export function ThreadContinuation({
  sourceFile,
  collection,
  conversationKey,
  threadId,
  attemptScope,
  ephemeral = false,
  draftSaved = false,
  onCreateThread,
  initialMessages = [],
  onCompleted,
  onMessagesChanged,
  onRecoveryChanged,
  onModelChanged,
  showThreadShelfTurns = true,
}: ThreadContinuationProps) {
  const queryClient = useQueryClient();
  const masterPrompt = useActiveMasterPromptText();
  const [config, setConfig] = useState<GenerationConfigResponse | null>(null);
  const [provider, setProvider] = useState<GenerationProviderId>('llama-cpp');
  const [models, setModels] = useState<GenerationModel[]>([]);
  const [runtime, setRuntime] = useState<GenerationRuntimeStatus | null>(null);
  const [model, setModel] = useState('');
  const [openRouterSort, setOpenRouterSort] = useState<OpenRouterModelSort>('most-popular');
  const [freeOnly, setFreeOnly] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [continuation, setContinuation] = useState<ContinuationMessage[]>([...initialMessages]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [sending, setSending] = useState(false);
  const [pendingUser, setPendingUser] = useState('');
  const [streamedContent, setStreamedContent] = useState<string[]>([]);
  const [streamedReasoning, setStreamedReasoning] = useState<string[]>([]);
  const [streamedModel, setStreamedModel] = useState('');
  const [progress, setProgress] = useState('Discovering local GGUF models…');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [zdrOnly, setZdrOnly] = useState(false);
  const [error, setError] = useState('');
  const [maxTokens, setMaxTokens] = useState('4096');
  const [contextSize, setContextSize] = useState('8192');
  const [savingContextSize, setSavingContextSize] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [createdThreadId, setCreatedThreadId] = useState('');
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const requestController = useRef<AbortController | null>(null);
  const receivedStreamData = useRef(false);
  const streamedContentRef = useRef('');
  const streamedReasoningRef = useRef('');
  const streamedModelRef = useRef('');
  const publishedRuntimeRef = useRef('');
  const interruptedStorageKey = `threadshelf:interrupted-generations:${
    attemptScope ||
    threadId ||
    `${collection ?? 'chat'}:${sourceFile ?? 'new'}:${conversationKey ?? ''}`
  }`;
  const [interruptedGenerations, setInterruptedGenerations] = useState<InterruptedGeneration[]>(
    () => loadInterruptedGenerations(interruptedStorageKey),
  );

  useEffect(() => {
    try {
      sessionStorage.setItem(interruptedStorageKey, JSON.stringify(interruptedGenerations));
    } catch {
      // The current in-memory transcript remains available if session storage is full or blocked.
    }
  }, [interruptedGenerations, interruptedStorageKey]);

  useEffect(() => {
    onRecoveryChanged?.(interruptedGenerations.length > 0);
  }, [interruptedGenerations.length, onRecoveryChanged]);

  useEffect(() => {
    if (!modelMenuOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!modelMenuRef.current?.contains(event.target as Node)) setModelMenuOpen(false);
    };
    const keepPopoverInsideViewport = () => {
      const root = modelMenuRef.current;
      const trigger = root?.getBoundingClientRect();
      if (!root || !trigger) return;
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const topbarClearance = window.innerWidth <= 640 ? 60 : 56;
      const spaceAbove = trigger.top - (viewportTop + topbarClearance) - 8;
      const spaceBelow = viewportBottom - trigger.bottom - 20;
      const placement = spaceBelow > spaceAbove ? 'down' : 'up';
      const availableHeight = Math.max(
        96,
        Math.floor(placement === 'down' ? spaceBelow : spaceAbove),
      );
      root.dataset.popoverPlacement = placement;
      root.style.setProperty('--model-popover-available-height', `${availableHeight}px`);
    };

    keepPopoverInsideViewport();
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', keepPopoverInsideViewport);
    window.addEventListener('scroll', keepPopoverInsideViewport, true);
    window.visualViewport?.addEventListener('resize', keepPopoverInsideViewport);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', keepPopoverInsideViewport);
      window.removeEventListener('scroll', keepPopoverInsideViewport, true);
      window.visualViewport?.removeEventListener('resize', keepPopoverInsideViewport);
    };
  }, [modelMenuOpen]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api.generationConfig(controller.signal),
      api.generationModels('llama-cpp', { signal: controller.signal }),
    ])
      .then(([nextConfig, response]) => {
        setConfig(nextConfig);
        const configuredContext = nextConfig.config.llamaCpp?.contextSize ?? 8192;
        setContextSize(String(configuredContext));
        setMaxTokens(String(Math.min(4096, Math.max(1, configuredContext))));
        setZdrOnly(nextConfig.config.openRouter.enforceZdr);
        setModels(response.models);
        setRuntime(response.runtime);
        setModel(
          response.models.find((candidate) => candidate.loaded)?.id ?? response.models[0]?.id ?? '',
        );
        if (response.models.length === 0) {
          setError(
            'No GGUF models found. Download one from the model menu or add a directory in Settings.',
          );
        }
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(cause instanceof Error ? cause.message : 'Could not load generation settings.');
      })
      .finally(() => setLoadingModels(false));
    return () => {
      controller.abort();
      requestController.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!sending) return undefined;
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [sending]);

  useEffect(() => {
    if (!sending || provider !== 'llama-cpp') return undefined;
    const controller = new AbortController();
    const refreshRuntime = async () => {
      try {
        const response = await api.generationRuntime(controller.signal);
        setRuntime(response.runtime);
        const runtimeSignature = JSON.stringify(response.runtime);
        if (runtimeSignature !== publishedRuntimeRef.current) {
          publishedRuntimeRef.current = runtimeSignature;
          window.dispatchEvent(
            new CustomEvent('threadshelf:generation-runtime-changed', {
              detail: response.runtime,
            }),
          );
        }
        if (response.runtime.state === 'starting') {
          setProgress(response.runtime.detail);
        } else if (response.runtime.state === 'ready' && !receivedStreamData.current) {
          setProgress('Model loaded. Processing the prompt and waiting for the first token…');
        }
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          // The generation stream remains authoritative; a diagnostics poll must not stop it.
        }
      }
    };
    void refreshRuntime();
    const timer = window.setInterval(() => void refreshRuntime(), 1_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [provider, sending]);

  const loadModels = async (
    selectedProvider = provider,
    options: {
      sort?: OpenRouterModelSort;
      freeOnly?: boolean;
      selectModel?: string;
    } = {},
  ) => {
    setLoadingModels(true);
    setError('');
    try {
      const response = await api.generationModels(selectedProvider, {
        sort: options.sort ?? openRouterSort,
        freeOnly: options.freeOnly ?? freeOnly,
      });
      setModels(response.models);
      setRuntime(response.runtime);
      setModel((current) => {
        const preferred = options.selectModel
          ? response.models.find(
              (candidate) =>
                candidate.id === options.selectModel || candidate.path === options.selectModel,
            )
          : undefined;
        if (preferred) return preferred.id;
        const loaded = response.models.find((candidate) => candidate.loaded);
        if (loaded) return loaded.id;
        return response.models.some((candidate) => candidate.id === current)
          ? current
          : (response.models[0]?.id ?? '');
      });
      if (response.models.length === 0) {
        setError(
          selectedProvider === 'llama-cpp'
            ? 'No GGUF models found. Download one here or add a directory in Settings.'
            : 'OpenRouter returned no models.',
        );
      }
    } catch (cause) {
      setModels([]);
      setModel('');
      setError(cause instanceof Error ? cause.message : 'Could not load models.');
    } finally {
      setLoadingModels(false);
    }
  };

  const selectDownloadedModel = async (path: string) => {
    await loadModels('llama-cpp', { selectModel: path });
    setCatalogOpen(false);
    setModelMenuOpen(true);
  };

  const isThreadShelfChat = Boolean(threadId);
  const isStandaloneChat = isThreadShelfChat || ephemeral || draftSaved;
  const selectedModel = models.find((candidate) => candidate.id === model);
  const contextWindowTokens =
    provider === 'llama-cpp'
      ? (runtime?.contextSize ?? config?.config.llamaCpp?.contextSize)
      : selectedModel?.contextLength;
  const parsedContextSize = /^\d+$/.test(contextSize) ? Number(contextSize) : Number.NaN;
  const contextSizeValid =
    Number.isSafeInteger(parsedContextSize) &&
    parsedContextSize >= 512 &&
    parsedContextSize <= 1_048_576;
  const contextSizeDirty =
    provider === 'llama-cpp' &&
    contextSizeValid &&
    parsedContextSize !== config?.config.llamaCpp?.contextSize;
  const maximumAnswerTokens = Math.min(32_768, contextWindowTokens ?? 32_768);
  const parsedMaxTokens = /^\d+$/.test(maxTokens) ? Number(maxTokens) : Number.NaN;
  const maxTokensValid =
    Number.isSafeInteger(parsedMaxTokens) &&
    parsedMaxTokens >= 1 &&
    parsedMaxTokens <= maximumAnswerTokens;
  const effectiveMaxTokens = maxTokensValid ? parsedMaxTokens : 4096;
  const maxTokenOptions = [256, 512, 1024, 2048, 4096, 8192, 16_384, 32_768].filter(
    (value) => value <= maximumAnswerTokens,
  );

  useEffect(() => {
    onModelChanged?.(selectedModel?.name || runtime?.model || model);
  }, [model, onModelChanged, runtime?.model, selectedModel?.name]);

  const changeProvider = (next: GenerationProviderId) => {
    setProvider(next);
    setModels([]);
    setRuntime(null);
    setModel('');
    setError('');
    setProgress(
      next === 'llama-cpp' ? 'Discovering local GGUF models…' : 'Loading live OpenRouter models…',
    );
    void loadModels(next, { sort: openRouterSort, freeOnly });
  };

  const applyContextSize = async () => {
    if (!contextSizeValid) {
      setError('Context window must be a whole number from 512 to 1,048,576 tokens.');
      return;
    }
    setSavingContextSize(true);
    setError('');
    try {
      const nextConfig = await api.updateGenerationConfig({
        llamaCpp: { contextSize: parsedContextSize },
      });
      const response = await api.generationModels('llama-cpp');
      setConfig(nextConfig);
      setContextSize(String(nextConfig.config.llamaCpp.contextSize));
      setModels(response.models);
      setRuntime(response.runtime);
      window.dispatchEvent(new Event('threadshelf:generation-runtime-changed'));
      toast.success(
        `Context window changed to ${nextConfig.config.llamaCpp.contextSize.toLocaleString()} tokens.`,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not change context window.';
      setError(message);
      toast.error(message);
    } finally {
      setSavingContextSize(false);
    }
  };

  const ejectModel = async () => {
    try {
      const response = await api.ejectGenerationModel(runtime?.model || model);
      setRuntime(response.runtime);
      setModels((current) => current.map((candidate) => ({ ...candidate, loaded: false })));
      window.dispatchEvent(new Event('threadshelf:generation-runtime-changed'));
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['collections'] }),
        queryClient.invalidateQueries({ queryKey: ['files'] }),
        queryClient.invalidateQueries({ queryKey: ['search'] }),
        queryClient.invalidateQueries({ queryKey: ['thread'] }),
      ]);
      toast.success('Model unloaded from memory. GGUF file kept on disk.');
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not unload model.');
    }
  };

  const send = async () => {
    const text = prompt.trim();
    if (!text || !model) return;
    if (!maxTokensValid) {
      setError(
        `Max answer must be a whole number from 1 to ${maximumAnswerTokens.toLocaleString()}.`,
      );
      return;
    }
    // A saved draft has no database row until its first message.
    let activeThreadId = threadId || createdThreadId;
    if (!ephemeral && !activeThreadId && draftSaved && onCreateThread) {
      setSending(true);
      setError('');
      try {
        activeThreadId = await onCreateThread();
        setCreatedThreadId(activeThreadId);
      } catch (cause) {
        setSending(false);
        setError(cause instanceof Error ? cause.message : 'Could not create the chat.');
        return;
      }
    }
    setSending(true);
    setElapsedSeconds(0);
    setError('');
    setPendingUser(text);
    setStreamedContent([]);
    setStreamedReasoning([]);
    setStreamedModel(model);
    streamedContentRef.current = '';
    streamedReasoningRef.current = '';
    streamedModelRef.current = model;
    receivedStreamData.current = false;
    setProgress(
      provider === 'llama-cpp'
        ? 'Preparing llama.cpp. The first model load can take a while…'
        : 'Preparing an OpenRouter request…',
    );
    const controller = new AbortController();
    requestController.current = controller;
    try {
      const common = {
        provider,
        model,
        prompt: text,
        maxTokens: effectiveMaxTokens,
        temperature: 0.7,
        systemPrompt: masterPrompt.trim() || undefined,
        openRouterZdr: provider === 'openrouter' ? zdrOnly : undefined,
      };
      const response = await api.continueThreadStream(
        ephemeral
          ? { ...common, ephemeral: true, continuation }
          : activeThreadId
            ? { ...common, threadId: activeThreadId }
            : {
                ...common,
                sourceFile: sourceFile!,
                collection: collection === '__all__' ? 'all' : collection!,
                conversationKey,
              },
        (event: GenerationStreamEvent) => {
          if (event.type === 'status') {
            setProgress(event.message);
            if (event.model) setStreamedModel(event.model);
          } else if (event.type === 'delta') {
            receivedStreamData.current = true;
            if (event.content) {
              streamedContentRef.current += event.content;
              setStreamedContent((current) => appendStableStreamChunk(current, event.content!));
            }
            if (event.reasoning) {
              streamedReasoningRef.current += event.reasoning;
              setStreamedReasoning((current) => appendStableStreamChunk(current, event.reasoning!));
            }
            if (event.model) {
              streamedModelRef.current = event.model;
              setStreamedModel(event.model);
            }
          }
        },
        controller.signal,
      );
      setContinuation((current) => {
        const next: ContinuationMessage[] = [
          ...current,
          { role: 'user', content: text },
          {
            role: 'assistant',
            content: response.content,
            reasoning: response.reasoning,
            model: response.model,
            usage: response.usage,
            performance: response.performance,
            contextWindowTokens,
          },
        ];
        onMessagesChanged?.(next);
        return next;
      });
      setPrompt('');
      setRuntime(
        provider === 'llama-cpp'
          ? {
              state: 'ready',
              model,
              contextSize: contextWindowTokens,
              detail: 'The local model is loaded and ready.',
            }
          : {
              state: 'remote',
              model: response.model,
              detail: 'The response ran through OpenRouter.',
            },
      );
      if (provider === 'llama-cpp') {
        setModels((current) =>
          current.map((candidate) => ({ ...candidate, loaded: candidate.id === model })),
        );
      }
      window.dispatchEvent(new Event('threadshelf:generation-runtime-changed'));
      if (response.persistence?.warning) toast.info(response.persistence.warning);
      onCompleted?.();
    } catch (cause) {
      const stopped = controller.signal.aborted;
      const failure = stopped
        ? 'Generation stopped by the user.'
        : cause instanceof Error
          ? cause.message
          : 'Generation failed.';
      const attempt: InterruptedGeneration = {
        id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
        prompt: text,
        content: streamedContentRef.current,
        reasoning: streamedReasoningRef.current,
        model: streamedModelRef.current || model,
        provider,
        error: failure,
        stopped,
        createdAt: new Date().toISOString(),
      };
      setInterruptedGenerations((current) => [...current, attempt].slice(-8));
      if (stopped) {
        toast.info('Generation stopped.');
      } else {
        setError(failure);
      }
    } finally {
      if (requestController.current === controller) requestController.current = null;
      setSending(false);
      setPendingUser('');
      setStreamedContent([]);
      setStreamedReasoning([]);
      setStreamedModel('');
    }
  };

  const runtimeModel = runtime?.model ? compactModel(runtime.model) : undefined;
  const modelStatusName =
    compactModel(selectedModel?.name || runtime?.model || model, 24) ||
    (loadingModels ? 'Loading models…' : 'Select a model');
  const modelDotState = sending
    ? 'loading'
    : provider === 'openrouter'
      ? 'remote'
      : selectedModel?.loaded || runtime?.state === 'ready'
        ? 'ready'
        : 'stopped';

  return (
    <div className="thread-continuation">
      {(isStandaloneChat || showThreadShelfTurns) &&
        continuation.map((message, index) => {
          const priorAssistants = continuation
            .slice(0, index)
            .filter((candidate) => candidate.role === 'assistant');
          const previousModel = priorAssistants[priorAssistants.length - 1]?.model;
          const showModel =
            message.role === 'assistant' &&
            Boolean(message.model) &&
            (!isStandaloneChat || message.model !== previousModel);
          return (
            <div
              className="turn generated-turn"
              data-role={message.role === 'user' ? 'user' : 'ai'}
              data-origin="threadshelf"
              data-standalone={isStandaloneChat}
              key={index}
            >
              {!isStandaloneChat && (
                <div className="turn-avatar">{message.role === 'user' ? 'U' : 'A'}</div>
              )}
              <div className="turn-content">
                {(!isStandaloneChat || showModel) && (
                  <div className="turn-head">
                    {!isStandaloneChat && (
                      <span className="role-tag">
                        {message.role === 'user' ? 'continued user' : 'generated response'}
                      </span>
                    )}
                    {showModel && (
                      <span className="turn-model" title={message.model}>
                        {compactModel(message.model)}
                      </span>
                    )}
                    {!isStandaloneChat && (
                      <span className="threadshelf-turn-badge">ThreadShelf</span>
                    )}
                  </div>
                )}
                {message.reasoning && (
                  <details className="generated-reasoning">
                    <summary>Model reasoning</summary>
                    <div>{message.reasoning}</div>
                  </details>
                )}
                {message.role === 'assistant' ? (
                  <Markdown className="turn-body" text={message.content} />
                ) : (
                  <div className="turn-body">{message.content}</div>
                )}
                {message.role === 'assistant' &&
                  message.usage &&
                  // Chat view keeps only tok/s + context (rest in the tooltip);
                  // the archive continuation view keeps the full breakdown.
                  (isStandaloneChat ? (
                    <div
                      className="turn-generation-metrics"
                      title={[
                        message.usage.promptTokens !== undefined
                          ? `prompt ${message.usage.promptTokens.toLocaleString()} tokens`
                          : '',
                        message.usage.completionTokens !== undefined
                          ? `answer ${message.usage.completionTokens.toLocaleString()} tokens`
                          : '',
                        message.performance?.source === 'provider'
                          ? 'speed reported by the backend'
                          : 'speed measured across the request',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    >
                      {message.performance && (
                        <strong>
                          {message.performance.completionTokensPerSecond.toFixed(1)} tok/s
                        </strong>
                      )}
                      {message.contextWindowTokens && message.usage.totalTokens !== undefined && (
                        <span>
                          context {message.usage.totalTokens.toLocaleString()} /{' '}
                          {message.contextWindowTokens.toLocaleString()}
                        </span>
                      )}
                    </div>
                  ) : (
                    <div
                      className="turn-generation-metrics"
                      title={
                        message.performance?.source === 'provider'
                          ? 'Token speed reported by the generation backend'
                          : 'Token speed measured across the request'
                      }
                    >
                      {message.performance && (
                        <strong>
                          {message.performance.completionTokensPerSecond.toFixed(1)} tok/s
                        </strong>
                      )}
                      {message.usage.promptTokens !== undefined && (
                        <span>prompt {message.usage.promptTokens.toLocaleString()}</span>
                      )}
                      {message.usage.completionTokens !== undefined && (
                        <span>answer {message.usage.completionTokens.toLocaleString()}</span>
                      )}
                      {message.contextWindowTokens && message.usage.totalTokens !== undefined && (
                        <span>
                          context {message.usage.totalTokens.toLocaleString()} /{' '}
                          {message.contextWindowTokens.toLocaleString()} ·{' '}
                          {Math.max(
                            0,
                            message.contextWindowTokens - message.usage.totalTokens,
                          ).toLocaleString()}{' '}
                          left
                        </span>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          );
        })}

      {(isStandaloneChat || showThreadShelfTurns) &&
        interruptedGenerations.map((attempt) => (
          <section className="interrupted-generation" key={attempt.id}>
            <header>
              <div>
                <strong>{attempt.stopped ? 'Stopped generation' : 'Failed generation'}</strong>
                <span>
                  not saved · {compactModel(attempt.model)} ·{' '}
                  {new Date(attempt.createdAt).toLocaleTimeString()}
                </span>
              </div>
              <div className="interrupted-generation-actions">
                <button
                  className="btn sm"
                  disabled={sending}
                  onClick={() => setPrompt(attempt.prompt)}
                >
                  Retry prompt
                </button>
                <button
                  className="btn sm"
                  onClick={() =>
                    void copyText(attemptTranscript(attempt)).then((copied) =>
                      copied
                        ? toast.success('Partial generation copied.')
                        : toast.error('Could not copy partial generation.'),
                    )
                  }
                >
                  {Icons.copy} Copy attempt
                </button>
                <button
                  className="btn sm ghost"
                  aria-label="Dismiss failed generation"
                  onClick={() =>
                    setInterruptedGenerations((current) =>
                      current.filter((candidate) => candidate.id !== attempt.id),
                    )
                  }
                >
                  Dismiss
                </button>
              </div>
            </header>
            <div className="interrupted-prompt">
              <span>Prompt</span>
              <p>{attempt.prompt}</p>
            </div>
            {attempt.reasoning && (
              <details className="generated-reasoning" open>
                <summary>Partial model reasoning</summary>
                <div>{attempt.reasoning}</div>
              </details>
            )}
            <div className="turn-body interrupted-answer">
              {attempt.content || <em>No answer tokens were received.</em>}
            </div>
            <footer>{attempt.error}</footer>
          </section>
        ))}

      {(isStandaloneChat || showThreadShelfTurns) && sending && pendingUser && (
        <>
          <div
            className="turn generated-turn"
            data-role="user"
            data-origin="threadshelf"
            data-standalone={isStandaloneChat}
          >
            {!isStandaloneChat && <div className="turn-avatar">U</div>}
            <div className="turn-content">
              {!isStandaloneChat && (
                <div className="turn-head">
                  <span className="role-tag">continued user</span>
                  <span className="threadshelf-turn-badge">ThreadShelf</span>
                </div>
              )}
              <div className="turn-body">{pendingUser}</div>
            </div>
          </div>
          <div
            className="turn generated-turn streaming-turn"
            data-role="ai"
            data-origin="threadshelf"
            data-standalone={isStandaloneChat}
            aria-live="polite"
          >
            {!isStandaloneChat && <div className="turn-avatar">A</div>}
            <div className="turn-content">
              <div className="turn-head">
                {!isStandaloneChat && <span className="role-tag">generating response</span>}
                <span className="turn-model" title={streamedModel || model}>
                  {compactModel(streamedModel || model)}
                </span>
                {!isStandaloneChat && <span className="threadshelf-turn-badge">ThreadShelf</span>}
              </div>
              {streamedReasoning.length > 0 && (
                <details className="generated-reasoning">
                  <summary>Model reasoning · streaming</summary>
                  <div>
                    {streamedReasoning.map((chunk, index) => (
                      <span className="stream-fragment" key={index}>
                        {chunk}
                      </span>
                    ))}
                  </div>
                </details>
              )}
              <div className="turn-body">
                {streamedContent.length > 0 ? (
                  streamedContent.map((chunk, index) => (
                    <span className="stream-fragment" key={index}>
                      {chunk}
                    </span>
                  ))
                ) : (
                  <span className="stream-placeholder">Waiting for first token</span>
                )}
                <span className="stream-cursor" aria-hidden="true" />
              </div>
              {(streamedContent.length > 0 || streamedReasoning.length > 0) && (
                <button
                  className="stream-copy-button"
                  onClick={() =>
                    void copyText(
                      [
                        streamedReasoningRef.current
                          ? `Reasoning (partial):\n${streamedReasoningRef.current}`
                          : '',
                        streamedContentRef.current
                          ? `Answer (partial):\n${streamedContentRef.current}`
                          : '',
                      ]
                        .filter(Boolean)
                        .join('\n\n'),
                    ).then((copied) =>
                      copied
                        ? toast.success('Current output copied.')
                        : toast.error('Could not copy current output.'),
                    )
                  }
                >
                  {Icons.copy} Copy current output
                </button>
              )}
            </div>
          </div>
        </>
      )}

      <div className="continue-card">
        {error && <div className="banner err">{error}</div>}
        {sending && (
          <div className="generation-progress" role="status" aria-live="polite">
            <span className="generation-spinner" aria-hidden="true" />
            <div>
              <strong>{progress}</strong>
              <span>
                {compactModel(streamedModel || model)} · {elapsedSeconds}s elapsed
              </span>
            </div>
          </div>
        )}
        <textarea
          id="continuePrompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={`${isStandaloneChat ? 'Message' : 'Ask a follow-up'}… (Enter to send, Shift+Enter for a new line)`}
          maxLength={100_000}
          rows={isStandaloneChat ? 2 : 3}
          disabled={sending}
        />
        <div className="composer-bar">
          <div className="model-menu" ref={modelMenuRef}>
            <button
              type="button"
              id="modelMenuButton"
              className="model-status"
              data-state={modelDotState}
              aria-expanded={modelMenuOpen}
              aria-haspopup="dialog"
              title="Model and generation settings"
              onClick={() => setModelMenuOpen((open) => !open)}
            >
              <span className="runtime-dot" aria-hidden="true" />
              <span className="model-status-name">{modelStatusName}</span>
              {provider === 'openrouter' && <span className="off-device-chip">off-device</span>}
              <span className="model-status-chevron" aria-hidden="true">
                ▾
              </span>
            </button>

            {modelMenuOpen && (
              <div
                className="model-popover"
                role="dialog"
                aria-label="Model and generation settings"
              >
                <div
                  className="model-popover-providers"
                  role="tablist"
                  aria-label="Generation provider"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={provider === 'llama-cpp'}
                    data-active={provider === 'llama-cpp'}
                    onClick={() => provider !== 'llama-cpp' && changeProvider('llama-cpp')}
                  >
                    llama.cpp · local
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={provider === 'openrouter'}
                    data-active={provider === 'openrouter'}
                    onClick={() => provider !== 'openrouter' && changeProvider('openrouter')}
                  >
                    OpenRouter · external
                  </button>
                </div>

                <div className="model-popover-pick">
                  <ModelCombobox
                    provider={provider}
                    models={models}
                    value={model}
                    onChange={setModel}
                    disabled={models.length === 0}
                  />
                  <div className="model-popover-pick-actions">
                    {provider === 'llama-cpp' && (
                      <button
                        className="btn sm icon-only"
                        title="Browse and download GGUF models"
                        aria-label="Browse and download GGUF models"
                        disabled={sending}
                        onClick={() => {
                          setModelMenuOpen(false);
                          setCatalogOpen(true);
                        }}
                      >
                        {Icons.download}
                      </button>
                    )}
                    <button
                      className="btn sm icon-only"
                      title="Refresh model list"
                      aria-label="Refresh model list"
                      disabled={loadingModels}
                      onClick={() => void loadModels()}
                    >
                      {Icons.refresh}
                    </button>
                  </div>
                </div>

                {provider === 'openrouter' && (
                  <div className="model-catalog-filters" aria-label="OpenRouter model filters">
                    <span>Catalog</span>
                    <select
                      aria-label="Sort OpenRouter models"
                      value={openRouterSort}
                      onChange={(event) => {
                        const next = event.target.value as OpenRouterModelSort;
                        setOpenRouterSort(next);
                        void loadModels('openrouter', { sort: next, freeOnly });
                      }}
                    >
                      <option value="most-popular">Most popular this week</option>
                      <option value="newest">Latest</option>
                      <option value="default">Default</option>
                    </select>
                    <label>
                      <input
                        type="checkbox"
                        checked={freeOnly}
                        onChange={(event) => {
                          const next = event.target.checked;
                          setFreeOnly(next);
                          void loadModels('openrouter', { sort: openRouterSort, freeOnly: next });
                        }}
                      />
                      Free only
                    </label>
                  </div>
                )}

                <div className="model-runtime" data-state={runtime?.state || 'loading'}>
                  <div>
                    <strong>
                      {models.length.toLocaleString()}{' '}
                      {provider === 'llama-cpp'
                        ? 'GGUF models discovered'
                        : 'live models available'}
                    </strong>
                    <span title={selectedModel?.path || selectedModel?.id}>
                      {selectedModel
                        ? `${selectedModel.loaded ? 'Loaded' : 'Selected'} · ${modelLabel(selectedModel)}`
                        : 'No model selected'}
                    </span>
                    {runtimeModel && !selectedModel?.loaded && <span>Active: {runtimeModel}</span>}
                    {runtime && <span>{runtime.detail}</span>}
                  </div>
                  {runtime &&
                    (runtime.state === 'starting' ||
                      runtime.state === 'ready' ||
                      (runtime.state === 'external' && Boolean(runtime.model))) && (
                      <button className="btn sm" onClick={() => void ejectModel()}>
                        Eject
                      </button>
                    )}
                </div>

                <div className="generation-budget">
                  {provider === 'llama-cpp' ? (
                    <div className="generation-budget-field">
                      <span>Context window</span>
                      <NumberCombobox
                        id="chatContextSize"
                        label="Context window in tokens"
                        value={contextSize}
                        onChange={setContextSize}
                        options={CONTEXT_SIZE_OPTIONS}
                        optionLabel={(value) => `${value.toLocaleString()} tokens`}
                        invalid={!contextSizeValid}
                        title="Pick a preset or type any whole number from 512 to 1,048,576 tokens"
                      />
                      <button
                        type="button"
                        className="btn sm generation-context-apply"
                        disabled={!contextSizeDirty || savingContextSize || sending}
                        onClick={() => void applyContextSize()}
                      >
                        {savingContextSize ? 'Applying…' : 'Apply'}
                      </button>
                    </div>
                  ) : (
                    <span>
                      Context window{' '}
                      <strong>{contextWindowTokens?.toLocaleString() ?? 'unknown'}</strong> tokens
                    </span>
                  )}
                  <div className="generation-budget-field">
                    <span>Max answer</span>
                    <NumberCombobox
                      id="maxAnswerTokens"
                      label="Maximum response tokens"
                      value={maxTokens}
                      onChange={setMaxTokens}
                      options={maxTokenOptions}
                      optionLabel={(value) => `${value.toLocaleString()} tokens`}
                      invalid={!maxTokensValid}
                      title={`Pick a preset or type any whole number from 1 to ${maximumAnswerTokens.toLocaleString()} tokens`}
                    />
                  </div>
                </div>

                {provider === 'openrouter' && (
                  <label className="openrouter-zdr-option">
                    <input
                      type="checkbox"
                      checked={zdrOnly}
                      onChange={(event) => setZdrOnly(event.target.checked)}
                    />
                    ZDR-only routing <span>may exclude most endpoints</span>
                  </label>
                )}

                {provider === 'llama-cpp' && (
                  <LlamaLogPanel model={selectedModel} active={sending} />
                )}
              </div>
            )}
          </div>

          <MasterPromptMenu />

          <div className="composer-actions">
            <span className="composer-hint">
              {provider === 'llama-cpp'
                ? 'Loopback-only llama-server'
                : 'Sent off-device via OpenRouter'}
            </span>
            {sending ? (
              <button className="btn danger" onClick={() => requestController.current?.abort()}>
                Stop
              </button>
            ) : (
              <button
                id="continueSend"
                className="btn primary"
                disabled={!prompt.trim() || !model}
                onClick={() => void send()}
              >
                {isStandaloneChat ? 'Send' : 'Continue'}
              </button>
            )}
          </div>
        </div>
      </div>
      <ModelCatalogModal
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        onDownloaded={(path) => void selectDownloadedModel(path)}
      />
    </div>
  );
}
