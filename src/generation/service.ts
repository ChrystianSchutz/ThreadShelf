import { ValidationError } from '../validation.js';
import { persistGenerationError } from './error-log.js';
import { getGenerationProvider } from './registry.js';
import type {
  ChatDeltaHandler,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  GenerationProviderId,
} from './types.js';

const PROVIDERS = new Set<GenerationProviderId>(['llama-cpp', 'openrouter', 'strata']);
const ROLES = new Set<ChatMessage['role']>(['system', 'user', 'assistant']);
const MAX_MESSAGES = 500;
const MAX_CONTEXT_CHARS = 4_000_000;

export const validateChatRequest = (value: unknown): ChatRequest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('Invalid chat request');
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.provider !== 'string' || !PROVIDERS.has(raw.provider as GenerationProviderId)) {
    throw new ValidationError('Invalid provider', { field: 'provider' });
  }
  if (typeof raw.model !== 'string' || !raw.model.trim() || raw.model.length > 4096) {
    throw new ValidationError('Invalid model', { field: 'model' });
  }
  if (
    !Array.isArray(raw.messages) ||
    raw.messages.length === 0 ||
    raw.messages.length > MAX_MESSAGES
  ) {
    throw new ValidationError(`Invalid messages: expected 1-${MAX_MESSAGES} entries`, {
      field: 'messages',
    });
  }
  let totalChars = 0;
  const messages = raw.messages.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError(`Invalid messages[${index}]`, { field: 'messages' });
    }
    const message = entry as Record<string, unknown>;
    if (typeof message.role !== 'string' || !ROLES.has(message.role as ChatMessage['role'])) {
      throw new ValidationError(`Invalid messages[${index}].role`, { field: 'messages' });
    }
    if (typeof message.content !== 'string' || !message.content.trim()) {
      throw new ValidationError(`Invalid messages[${index}].content`, { field: 'messages' });
    }
    totalChars += message.content.length;
    return {
      role: message.role as ChatMessage['role'],
      content: message.content,
    };
  });
  if (totalChars > MAX_CONTEXT_CHARS) {
    throw new ValidationError(`Conversation context exceeds ${MAX_CONTEXT_CHARS} characters`, {
      field: 'messages',
    });
  }
  const temperature = raw.temperature === undefined ? 0.7 : Number(raw.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new ValidationError('Invalid temperature: expected 0-2', { field: 'temperature' });
  }
  const maxTokens = raw.maxTokens === undefined ? 1024 : Number(raw.maxTokens);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) {
    throw new ValidationError('Invalid maxTokens: expected integer from 1 to 32768', {
      field: 'maxTokens',
    });
  }
  if (raw.openRouterZdr !== undefined && typeof raw.openRouterZdr !== 'boolean') {
    throw new ValidationError('Invalid openRouterZdr: expected boolean', {
      field: 'openRouterZdr',
    });
  }
  if (raw.persistDiagnostics !== undefined && typeof raw.persistDiagnostics !== 'boolean') {
    throw new ValidationError('Invalid persistDiagnostics: expected boolean', {
      field: 'persistDiagnostics',
    });
  }
  return {
    provider: raw.provider as GenerationProviderId,
    model: raw.model.trim(),
    messages,
    temperature,
    maxTokens,
    openRouterZdr:
      raw.provider === 'openrouter' ? (raw.openRouterZdr as boolean | undefined) : undefined,
    persistDiagnostics: raw.persistDiagnostics as boolean | undefined,
  };
};

export const generateChat = async (input: unknown, signal?: AbortSignal): Promise<ChatResponse> => {
  const request = validateChatRequest(input);
  try {
    return await getGenerationProvider(request.provider).chat(request, signal);
  } catch (error) {
    if (!signal?.aborted) await persistGenerationError(request, error).catch(() => undefined);
    throw error;
  }
};

export const generateChatStream = async (
  input: unknown,
  onDelta: ChatDeltaHandler,
  signal?: AbortSignal,
): Promise<ChatResponse> => {
  const request = validateChatRequest(input);
  try {
    return await getGenerationProvider(request.provider).chatStream(request, onDelta, signal);
  } catch (error) {
    if (!signal?.aborted) await persistGenerationError(request, error).catch(() => undefined);
    throw error;
  }
};
