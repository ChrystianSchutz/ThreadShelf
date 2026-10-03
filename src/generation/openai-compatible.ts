import type {
  ChatDeltaHandler,
  ChatRequest,
  ChatResponse,
  ChatToolCall,
  GenerationProviderId,
} from './types.js';

interface OpenAiResponse {
  readonly model?: string;
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string | null;
      readonly reasoning?: string | null;
      readonly reasoning_content?: string | null;
      readonly tool_calls?: readonly ChatToolCall[];
      readonly reasoning_details?: readonly Readonly<Record<string, unknown>>[];
    };
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
  readonly timings?: {
    readonly prompt_per_second?: number;
    readonly predicted_per_second?: number;
    readonly predicted_ms?: number;
  };
  readonly error?: { readonly message?: string };
}

interface OpenAiStreamChunk {
  readonly model?: string;
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: unknown;
      readonly reasoning?: unknown;
      readonly reasoning_content?: unknown;
      readonly reasoning_details?: readonly Readonly<Record<string, unknown>>[];
      readonly tool_calls?: readonly {
        readonly index: number;
        readonly id?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }[];
    };
  }[];
  readonly usage?: OpenAiResponse['usage'];
  readonly timings?: OpenAiResponse['timings'];
  readonly error?: { readonly message?: string };
}

export interface OpenAiChatOptions {
  readonly provider: GenerationProviderId;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly request: ChatRequest;
  readonly extraBody?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

const requestHeaders = (apiKey?: string): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
};

const requestSignal = (provider: GenerationProviderId, signal?: AbortSignal): AbortSignal => {
  const timeout = AbortSignal.timeout(provider === 'llama-cpp' ? 30 * 60_000 : 5 * 60_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

const errorChain = (error: unknown): string => {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current) && messages.length < 5) {
    seen.add(current);
    if (current instanceof Error) {
      if (current.message && !messages.includes(current.message)) messages.push(current.message);
      current = current.cause;
    } else {
      const message = String(current);
      if (message && !messages.includes(message)) messages.push(message);
      break;
    }
  }
  return messages.join(' → ') || 'unknown transport error';
};

const providerRequestError = (
  provider: GenerationProviderId,
  stage: string,
  error: unknown,
): Error => new Error(`${provider} ${stage}: ${errorChain(error)}`, { cause: error });

const responseErrorMessage = async (
  response: Response,
  provider: GenerationProviderId,
): Promise<string> => {
  const raw = await response.text().catch(() => '');
  if (raw) {
    try {
      const payload = JSON.parse(raw) as OpenAiResponse;
      if (payload.error?.message) return payload.error.message;
    } catch {
      const compact = raw.replace(/\s+/g, ' ').trim();
      if (compact) return compact.slice(0, 2_000);
    }
  }
  return `${provider} request failed (${response.status} ${response.statusText || 'HTTP error'})`;
};

const requestBody = (
  request: ChatRequest,
  stream: boolean,
  extraBody?: Readonly<Record<string, unknown>>,
): string =>
  JSON.stringify({
    model: request.model,
    messages: request.messages,
    temperature: request.temperature,
    max_tokens: request.maxTokens,
    stream,
    ...(request.tools?.length
      ? { tools: request.tools, tool_choice: 'auto', parallel_tool_calls: false }
      : {}),
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...extraBody,
  });

const textDelta = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
};

const responseUsage = (usage: OpenAiResponse['usage']): ChatResponse['usage'] =>
  usage
    ? {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
      }
    : undefined;

const responsePerformance = (
  timings: OpenAiResponse['timings'],
  usage: OpenAiResponse['usage'],
  elapsedMs: number,
): ChatResponse['performance'] => {
  if (timings?.predicted_per_second && Number.isFinite(timings.predicted_per_second)) {
    return {
      completionTokensPerSecond: timings.predicted_per_second,
      promptTokensPerSecond: timings.prompt_per_second,
      generationMs: timings.predicted_ms,
      source: 'provider',
    };
  }
  if (!usage?.completion_tokens || elapsedMs <= 0) return undefined;
  return {
    completionTokensPerSecond: usage.completion_tokens / (elapsedMs / 1000),
    generationMs: elapsedMs,
    source: 'measured',
  };
};

export const openAiCompatibleChat = async ({
  provider,
  baseUrl,
  apiKey,
  request,
  extraBody,
  signal,
  fetchImpl = fetch,
}: OpenAiChatOptions): Promise<ChatResponse> => {
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: requestHeaders(apiKey),
      body: requestBody(request, false, extraBody),
      signal: requestSignal(provider, signal),
    });
  } catch (error) {
    throw providerRequestError(provider, 'connection failed', error);
  }
  if (!response.ok) {
    throw new Error(
      `${provider} request failed: ${await responseErrorMessage(response, provider)}`,
    );
  }
  const payload = (await response.json().catch(() => ({}))) as OpenAiResponse;
  const message = payload.choices?.[0]?.message;
  const content = message?.content?.trim();
  const toolCalls = validatedToolCalls(message?.tool_calls);
  if (toolCalls?.length && !request.tools?.length)
    throw new Error(`${provider} returned tool calls while tools are disabled`);
  if (!content && !toolCalls?.length) throw new Error(`${provider} returned an empty response`);
  const reasoning = (message?.reasoning_content || message?.reasoning || '').trim() || undefined;
  return {
    provider,
    model: payload.model || request.model,
    content: content || '',
    ...(toolCalls?.length ? { toolCalls } : {}),
    ...(toolCalls?.length && message?.reasoning_details?.length
      ? { reasoningDetails: validatedReasoningDetails(message.reasoning_details) }
      : {}),
    reasoning,
    usage: responseUsage(payload.usage),
    performance: responsePerformance(payload.timings, payload.usage, performance.now() - startedAt),
  };
};

export const openAiCompatibleChatStream = async (
  options: OpenAiChatOptions,
  onDelta: ChatDeltaHandler,
): Promise<ChatResponse> => {
  const { provider, baseUrl, apiKey, request, extraBody, signal, fetchImpl = fetch } = options;
  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: requestHeaders(apiKey),
      body: requestBody(request, true, extraBody),
      signal: requestSignal(provider, signal),
    });
  } catch (error) {
    throw providerRequestError(provider, 'connection failed', error);
  }
  if (!response.ok) {
    throw new Error(
      `${provider} request failed: ${await responseErrorMessage(response, provider)}`,
    );
  }
  if (!response.body) throw new Error(`${provider} returned a response without a stream`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let model = request.model;
  let usage: OpenAiResponse['usage'];
  let timings: OpenAiResponse['timings'];
  let streamDone = false;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  const reasoningDetails: Readonly<Record<string, unknown>>[] = [];
  let reasoningDetailBytes = 0;

  const consumeLine = async (rawLine: string): Promise<void> => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') {
      streamDone = true;
      return;
    }
    let chunk: OpenAiStreamChunk;
    try {
      chunk = JSON.parse(data) as OpenAiStreamChunk;
    } catch (error) {
      throw new Error(`${provider} returned an invalid streaming event`, { cause: error });
    }
    if (chunk.error) throw new Error(chunk.error.message || `${provider} streaming request failed`);
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    if (chunk.timings) timings = chunk.timings;
    const delta = chunk.choices?.[0]?.delta;
    if (request.tools?.length && delta?.reasoning_details?.length) {
      const details = validatedReasoningDetails(delta.reasoning_details);
      reasoningDetailBytes += JSON.stringify(details).length;
      if (reasoningDetailBytes > 1_000_000 || reasoningDetails.length + details.length > 10_000)
        throw new Error('Provider tool state exceeds its limit');
      reasoningDetails.push(...details);
    }
    for (const call of delta?.tool_calls || []) {
      if (!Number.isInteger(call.index) || call.index < 0 || call.index >= 16)
        throw new Error('Invalid tool call index');
      const current = calls.get(call.index) || { id: '', name: '', arguments: '' };
      current.id += call.id || '';
      current.name += call.function?.name || '';
      current.arguments += call.function?.arguments || '';
      if (
        current.arguments.length > 100_000 ||
        current.id.length > 200 ||
        current.name.length > 100
      )
        throw new Error('Tool call exceeds its size limit');
      calls.set(call.index, current);
    }
    const contentPart = textDelta(delta?.content);
    const reasoningPart = textDelta(delta?.reasoning_content ?? delta?.reasoning);
    if (!contentPart && !reasoningPart) return;
    content += contentPart;
    reasoning += reasoningPart;
    await onDelta({
      content: contentPart || undefined,
      reasoning: reasoningPart || undefined,
      model,
    });
  };

  try {
    while (!streamDone) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        throw providerRequestError(provider, 'response stream failed', error);
      }
      const { done, value } = result;
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 2_000_000)
        throw new Error('Provider streaming event exceeds its size limit');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        await consumeLine(line);
        if (streamDone) break;
        newline = buffer.indexOf('\n');
      }
      if (done) break;
    }
    if (!streamDone && buffer.trim()) await consumeLine(buffer);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const toolCalls = validatedToolCalls(
    [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments },
      })),
  );
  if (toolCalls?.length && !request.tools?.length)
    throw new Error(`${provider} returned tool calls while tools are disabled`);
  if (!content.trim() && !toolCalls?.length)
    throw new Error(`${provider} returned an empty response`);

  return {
    provider,
    model,
    content,
    ...(toolCalls?.length ? { toolCalls } : {}),
    ...(toolCalls?.length && reasoningDetails.length ? { reasoningDetails } : {}),
    reasoning: reasoning.trim() || undefined,
    usage: responseUsage(usage),
    performance: responsePerformance(timings, usage, performance.now() - startedAt),
  };
};

const validatedToolCalls = (
  calls?: readonly ChatToolCall[],
): readonly ChatToolCall[] | undefined => {
  if (!calls?.length) return undefined;
  if (!Array.isArray(calls) || calls.length > 16) throw new Error('Invalid tool calls');
  const ids = new Set<string>();
  for (const call of calls) {
    if (
      call.type !== 'function' ||
      typeof call.id !== 'string' ||
      !call.id ||
      call.id.length > 200 ||
      ids.has(call.id) ||
      typeof call.function?.name !== 'string' ||
      !/^[a-zA-Z0-9_]{1,100}$/.test(call.function.name) ||
      typeof call.function.arguments !== 'string' ||
      call.function.arguments.length > 100_000
    )
      throw new Error('Invalid tool call');
    ids.add(call.id);
  }
  return calls;
};

const validatedReasoningDetails = (
  details: readonly Readonly<Record<string, unknown>>[],
): readonly Readonly<Record<string, unknown>>[] => {
  if (
    !Array.isArray(details) ||
    details.length > 10_000 ||
    details.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry)) ||
    JSON.stringify(details).length > 1_000_000
  )
    throw new Error('Invalid provider tool state');
  return details;
};
