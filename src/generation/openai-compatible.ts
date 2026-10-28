import type { ChatDeltaHandler, ChatRequest, ChatResponse, GenerationProviderId } from './types.js';

interface OpenAiResponse {
  readonly model?: string;
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string | null;
      readonly reasoning?: string | null;
      readonly reasoning_content?: string | null;
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
  const timeout = AbortSignal.timeout(provider === 'openrouter' ? 5 * 60_000 : 30 * 60_000);
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
  if (!content) throw new Error(`${provider} returned an empty response`);
  const reasoning = (message?.reasoning_content || message?.reasoning || '').trim() || undefined;
  return {
    provider,
    model: payload.model || request.model,
    content,
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

  while (!streamDone) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch (error) {
      throw providerRequestError(provider, 'response stream failed', error);
    }
    const { done, value } = result;
    buffer += decoder.decode(value, { stream: !done });
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
  if (streamDone) await reader.cancel().catch(() => undefined);
  if (!content.trim()) throw new Error(`${provider} returned an empty response`);

  return {
    provider,
    model,
    content,
    reasoning: reasoning.trim() || undefined,
    usage: responseUsage(usage),
    performance: responsePerformance(timings, usage, performance.now() - startedAt),
  };
};
