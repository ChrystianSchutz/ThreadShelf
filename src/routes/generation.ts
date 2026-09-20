import { Router } from 'express';
import {
  getGenerationConfig,
  llamaCppConfigChanged,
  updateGenerationConfig,
} from '../generation/config.js';
import { browseDirectories, isLoopbackRequest } from '../generation/filesystem-browser.js';
import { requireLoopback } from './loopback.js';
import {
  getManagedLlamaStatus,
  getLlamaRuntimeDiagnostics,
  LlamaModelBusyError,
  stopManagedLlamaServer,
  withLlamaRuntimeControl,
} from '../generation/llama-process.js';
import {
  createMasterPrompt,
  deleteMasterPrompt,
  listMasterPrompts,
  setActiveMasterPrompt,
  updateMasterPrompt,
} from '../generation/master-prompts.js';
import { listGenerationProviders, getGenerationProvider } from '../generation/registry.js';
import { generateChat, generateChatStream } from '../generation/service.js';
import {
  acquireThreadShelfChat,
  acquireStoredThreadGeneration,
  appendStoredThreadExchange,
  appendThreadShelfChatExchange,
  createThreadShelfChat,
  deleteThreadShelfChat,
  renameThreadShelfChat,
  getThreadShelfChat,
  listThreadShelfChats,
  resolveStoredThreadGenerationTarget,
  ThreadShelfChatBusyError,
  ThreadShelfChatNotFoundError,
} from '../generation/threads.js';
import type {
  ChatMessage,
  ChatRequest,
  GenerationProviderId,
  GenerationRuntimeStatus,
} from '../generation/types.js';
import { NotFoundError, BadRequestError } from '../services/thread.js';
import {
  normalizeCollectionSelector,
  normalizeOptionalString,
  normalizeQuery,
  validateTurns,
  ValidationError,
  type Turn,
} from '../validation.js';

const router = Router();
const providerIds = new Set<GenerationProviderId>(['llama-cpp', 'openrouter']);
const openRouterSorts = new Set(['default', 'most-popular', 'newest']);

class GenerationConflictError extends Error {}

const parseProvider = (value: unknown): GenerationProviderId => {
  if (typeof value !== 'string' || !providerIds.has(value as GenerationProviderId)) {
    throw new ValidationError('Invalid provider', { field: 'provider' });
  }
  return value as GenerationProviderId;
};

const errorResponse = (res: import('express').Response, error: unknown): void => {
  if (error instanceof ValidationError) {
    res.status(400).json({ error: error.message, field: error.field });
    return;
  }
  if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof BadRequestError) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof LlamaModelBusyError) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof ThreadShelfChatNotFoundError) {
    res.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof ThreadShelfChatBusyError) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof GenerationConflictError) {
    res.status(409).json({ error: error.message });
    return;
  }
  console.error('[/api/generation]', error);
  res.status(502).json({ error: error instanceof Error ? error.message : 'Generation failed' });
};

router.get('/api/generation/config', requireLoopback, async (_req, res) => {
  try {
    const [config, statuses] = await Promise.all([
      getGenerationConfig(),
      Promise.all(listGenerationProviders().map((provider) => provider.status())),
    ]);
    res.json({ config, providers: statuses });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.put('/api/generation/config', requireLoopback, async (req, res) => {
  try {
    const update = async () => {
      const previous = await getGenerationConfig();
      const config = await updateGenerationConfig(req.body);
      if (llamaCppConfigChanged(previous, config)) await stopManagedLlamaServer();
      const statuses = await Promise.all(
        listGenerationProviders().map((provider) => provider.status()),
      );
      return { config, providers: statuses };
    };
    const result =
      req.body?.llamaCpp === undefined ? await update() : await withLlamaRuntimeControl(update);
    res.json(result);
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get('/api/generation/directories', async (req, res) => {
  try {
    const forwardedFor = [req.headers['x-forwarded-for'], req.headers['x-real-ip']]
      .flatMap((value) => (Array.isArray(value) ? value : value ? [value] : []))
      .map(String);
    if (
      !isLoopbackRequest(
        req.socket.remoteAddress,
        forwardedFor,
        req.headers.forwarded,
        req.hostname,
      )
    ) {
      res.status(403).json({ error: 'System folder browsing is available only from localhost' });
      return;
    }
    res.json(
      await browseDirectories(typeof req.query.path === 'string' ? req.query.path : undefined),
    );
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get('/api/generation/runtime', async (_req, res) => {
  try {
    const config = await getGenerationConfig();
    if (!config.llamaCpp.baseUrl) {
      res.json({ backend: 'llama.cpp', runtime: getManagedLlamaStatus() });
      return;
    }
    const models = await getGenerationProvider('llama-cpp').listModels();
    res.json({
      backend: 'llama.cpp',
      runtime: {
        state: 'external',
        model: models.find((model) => model.loaded)?.id,
        detail: `Connected to an existing local server at ${config.llamaCpp.baseUrl}.`,
      },
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get('/api/generation/runtime/logs', requireLoopback, async (_req, res) => {
  try {
    res.json(await getLlamaRuntimeDiagnostics());
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post('/api/generation/runtime/eject', requireLoopback, async (req, res) => {
  try {
    const result = await withLlamaRuntimeControl(async () => {
      const config = await getGenerationConfig();
      if (config.llamaCpp.baseUrl) {
        const requestedModel = req.body?.model;
        if (typeof requestedModel !== 'string' || !requestedModel.trim()) {
          throw new GenerationConflictError('No model is loaded on the external llama.cpp server');
        }
        const model = normalizeQuery(requestedModel, { field: 'model', maxLength: 4096 });
        const response = await fetch(`${config.llamaCpp.baseUrl}/models/unload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          throw new Error(
            payload.error?.message || `External llama.cpp unload failed (${response.status})`,
          );
        }
      } else {
        await stopManagedLlamaServer();
      }
      return {
        backend: 'llama.cpp',
        runtime: {
          state: config.llamaCpp.baseUrl ? 'external' : 'stopped',
          detail: config.llamaCpp.baseUrl
            ? 'Unload request accepted by the existing local server.'
            : 'The managed model was unloaded from memory. GGUF files were not deleted.',
        },
      };
    });
    res.json(result);
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get('/api/generation/models', requireLoopback, async (req, res) => {
  try {
    const provider = parseProvider(req.query.provider);
    const sort = String(req.query.sort || 'default');
    if (!openRouterSorts.has(sort)) {
      throw new ValidationError('Invalid model sort', { field: 'sort' });
    }
    const models = await getGenerationProvider(provider).listModels({
      sort: sort as 'default' | 'most-popular' | 'newest',
      freeOnly: req.query.free === '1',
    });
    let runtime: GenerationRuntimeStatus;
    if (provider === 'llama-cpp') {
      const config = await getGenerationConfig();
      runtime = config.llamaCpp.baseUrl
        ? {
            state: 'external',
            model: models.find((model) => model.loaded)?.id,
            detail: `Using an existing local server at ${config.llamaCpp.baseUrl}.`,
          }
        : getManagedLlamaStatus();
    } else {
      runtime = {
        state: 'remote',
        detail: 'Models run remotely through OpenRouter and are not loaded by ThreadShelf.',
      };
    }
    res.json({ provider, models, runtime });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get('/api/generation/prompts', requireLoopback, async (_req, res) => {
  try {
    res.json(await listMasterPrompts());
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post('/api/generation/prompts', requireLoopback, async (req, res) => {
  try {
    res.status(201).json(await createMasterPrompt(req.body ?? {}));
  } catch (error) {
    errorResponse(res, error);
  }
});

// Registered before '/:id' so the literal segment is never read as an id.
router.put('/api/generation/prompts/active', requireLoopback, async (req, res) => {
  try {
    res.json(await setActiveMasterPrompt(req.body?.id ?? ''));
  } catch (error) {
    errorResponse(res, error);
  }
});

router.patch('/api/generation/prompts/:id', requireLoopback, async (req, res) => {
  try {
    res.json(await updateMasterPrompt(req.params.id, req.body ?? {}));
  } catch (error) {
    errorResponse(res, error);
  }
});

router.delete('/api/generation/prompts/:id', requireLoopback, async (req, res) => {
  try {
    res.json(await deleteMasterPrompt(req.params.id));
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get('/api/generation/threads', requireLoopback, async (_req, res) => {
  try {
    res.json({ threads: await listThreadShelfChats() });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post('/api/generation/threads', requireLoopback, async (req, res) => {
  try {
    const title = normalizeOptionalString(req.body?.title, { field: 'title', maxLength: 200 });
    const turns = req.body?.turns === undefined ? [] : validateTurns(req.body.turns);
    res.status(201).json(await createThreadShelfChat(title, turns));
  } catch (error) {
    errorResponse(res, error);
  }
});

router.patch('/api/generation/threads/:id', requireLoopback, async (req, res) => {
  try {
    const title = normalizeQuery(req.body?.title, { field: 'title', maxLength: 200 });
    res.json(await renameThreadShelfChat(req.params.id, title));
  } catch (error) {
    errorResponse(res, error);
  }
});

router.delete('/api/generation/threads/:id', requireLoopback, async (req, res) => {
  try {
    await deleteThreadShelfChat(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get('/api/generation/threads/:id', requireLoopback, async (req, res) => {
  try {
    res.json(await getThreadShelfChat(req.params.id));
  } catch (error) {
    errorResponse(res, error);
  }
});

const turnMessages = (turns: readonly Turn[]): ChatMessage[] =>
  turns.flatMap((turn): ChatMessage[] => {
    if (typeof turn.user === 'string') return [{ role: 'user', content: turn.user }];
    if (typeof turn.ai === 'string') return [{ role: 'assistant', content: turn.ai }];
    // Deliberately exclude archived hidden reasoning from provider context.
    return [];
  });

const parseContinuation = (value: unknown): ChatMessage[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new ValidationError('Invalid continuation', { field: 'continuation' });
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError(`Invalid continuation[${index}]`, { field: 'continuation' });
    }
    const message = entry as Record<string, unknown>;
    if (!['user', 'assistant'].includes(String(message.role))) {
      throw new ValidationError(`Invalid continuation[${index}].role`, { field: 'continuation' });
    }
    const content = normalizeQuery(message.content, {
      field: `continuation[${index}].content`,
      maxLength: 100_000,
    });
    return { role: message.role as 'user' | 'assistant', content };
  });
};

interface PreparedChat {
  readonly provider: GenerationProviderId;
  readonly request: ChatRequest;
  readonly threadId?: string;
  readonly prompt: string;
  readonly storedThread?: Awaited<ReturnType<typeof resolveStoredThreadGenerationTarget>>;
  readonly ephemeral?: true;
}

// The user's master prompt. It is prepended as a system message to every
// request but is never persisted with the conversation, so re-reading a stored
// thread never replays a prompt the user has since changed or turned off.
const parseSystemPrompt = (value: unknown): ChatMessage[] => {
  const content = normalizeOptionalString(value, { field: 'systemPrompt', maxLength: 20_000 });
  return content ? [{ role: 'system', content }] : [];
};

const prepareChat = async (body: Record<string, unknown>): Promise<PreparedChat> => {
  const provider = parseProvider(body?.provider);
  const model = normalizeQuery(body?.model, { field: 'model', maxLength: 4096 });
  const prompt = normalizeQuery(body?.prompt, { field: 'prompt', maxLength: 100_000 });
  const system = parseSystemPrompt(body?.systemPrompt);
  if (body?.ephemeral === true) {
    const continuation = parseContinuation(body?.continuation);
    return {
      provider,
      prompt,
      ephemeral: true,
      request: {
        provider,
        model,
        messages: [...system, ...continuation, { role: 'user', content: prompt }],
        temperature: body?.temperature as number | undefined,
        maxTokens: body?.maxTokens as number | undefined,
        openRouterZdr: body?.openRouterZdr as boolean | undefined,
        persistDiagnostics: false,
      },
    };
  }
  if (body?.threadId !== undefined) {
    if (body.continuation !== undefined) {
      throw new ValidationError('ThreadShelf chats use their stored history', {
        field: 'continuation',
      });
    }
    const chat = await getThreadShelfChat(body.threadId);
    return {
      provider,
      threadId: chat.id,
      prompt,
      request: {
        provider,
        model,
        messages: [...system, ...turnMessages(chat.turns), { role: 'user', content: prompt }],
        temperature: body?.temperature as number | undefined,
        maxTokens: body?.maxTokens as number | undefined,
        openRouterZdr: body?.openRouterZdr as boolean | undefined,
      },
    };
  }
  const collection = normalizeCollectionSelector(body?.collection);
  const sourceFile = normalizeQuery(body?.sourceFile, {
    field: 'sourceFile',
    maxLength: 4096,
  });
  const conversationKey =
    body?.conversationKey === undefined
      ? undefined
      : normalizeQuery(body.conversationKey, { field: 'conversationKey', maxLength: 4096 });
  const thread = await resolveStoredThreadGenerationTarget(collection, sourceFile, conversationKey);
  if (!thread) {
    throw new BadRequestError(
      'This archived thread predates persistent thread storage. Re-index its collection before continuing it.',
    );
  }
  const continuation = parseContinuation(body?.continuation);
  return {
    provider,
    prompt,
    storedThread: thread,
    request: {
      provider,
      model,
      messages: [
        ...system,
        ...turnMessages(thread.turns),
        ...continuation,
        { role: 'user', content: prompt },
      ],
      temperature: body?.temperature as number | undefined,
      maxTokens: body?.maxTokens as number | undefined,
      openRouterZdr: body?.openRouterZdr as boolean | undefined,
    },
  };
};

const prepareChatWithLease = async (
  body: Record<string, unknown>,
): Promise<{ readonly prepared: PreparedChat; readonly release?: () => void }> => {
  if (body.threadId !== undefined) {
    const release = acquireThreadShelfChat(body.threadId);
    try {
      return { prepared: await prepareChat(body), release };
    } catch (error) {
      release();
      throw error;
    }
  }

  const initial = await prepareChat(body);
  if (!initial.storedThread) return { prepared: initial };
  const release = acquireStoredThreadGeneration(initial.storedThread);
  try {
    // Re-read under the per-conversation lease so provider context cannot be
    // assembled from history that another generation is about to replace.
    return { prepared: await prepareChat(body), release };
  } catch (error) {
    release();
    throw error;
  }
};

router.post('/api/generation/chat', requireLoopback, async (req, res) => {
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  let releaseChat: (() => void) | undefined;
  try {
    const leased = await prepareChatWithLease(req.body as Record<string, unknown>);
    const prepared = leased.prepared;
    releaseChat = leased.release;
    const response = await generateChat(prepared.request, controller.signal);
    let persistence;
    if (prepared.threadId) {
      persistence = (
        await appendThreadShelfChatExchange(prepared.threadId, prepared.prompt, response)
      ).persistence;
    } else if (prepared.storedThread) {
      persistence = await appendStoredThreadExchange(
        prepared.storedThread,
        prepared.prompt,
        response,
      );
    }
    res.json({ ...response, persistence });
  } catch (error) {
    errorResponse(res, error);
  } finally {
    releaseChat?.();
  }
});

router.post('/api/generation/chat/stream', requireLoopback, async (req, res) => {
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const send = (event: Readonly<Record<string, unknown>>): void => {
    if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
  };

  let releaseChat: (() => void) | undefined;
  try {
    send({
      type: 'status',
      phase: 'preparing',
      message:
        req.body?.ephemeral === true
          ? 'Preparing a private in-memory chat…'
          : req.body?.threadId
            ? 'Loading the locally saved ThreadShelf chat…'
            : 'Loading the archived conversation…',
    });
    const leased = await prepareChatWithLease(req.body as Record<string, unknown>);
    const prepared = leased.prepared;
    releaseChat = leased.release;
    send({
      type: 'status',
      phase: prepared.provider === 'llama-cpp' ? 'loading-model' : 'connecting',
      message:
        prepared.provider === 'llama-cpp'
          ? 'Starting llama.cpp and loading the selected GGUF model. First load can take a while…'
          : 'Connecting to OpenRouter and waiting for the first token…',
      provider: prepared.provider,
      model: prepared.request.model,
    });
    let firstDelta = true;
    const response = await generateChatStream(
      prepared.request,
      (delta) => {
        if (firstDelta) {
          firstDelta = false;
          send({
            type: 'status',
            phase: 'generating',
            message: 'Generating response…',
            provider: prepared.provider,
            model: delta.model || prepared.request.model,
          });
        }
        send({ type: 'delta', ...delta });
      },
      controller.signal,
    );
    if (!prepared.ephemeral) {
      send({
        type: 'status',
        phase: 'saving',
        message: 'Saving and indexing the completed exchange locally…',
        provider: prepared.provider,
        model: response.model,
      });
    }
    let persistence;
    if (prepared.threadId) {
      persistence = (
        await appendThreadShelfChatExchange(prepared.threadId, prepared.prompt, response)
      ).persistence;
    } else if (prepared.storedThread) {
      persistence = await appendStoredThreadExchange(
        prepared.storedThread,
        prepared.prompt,
        response,
      );
    }
    send({ type: 'done', response: { ...response, persistence } });
    res.end();
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error('[/api/generation/chat/stream]', error);
      send({
        type: 'error',
        error: error instanceof Error ? error.message : 'Generation failed',
      });
      res.end();
    }
  } finally {
    releaseChat?.();
  }
});

export default router;
