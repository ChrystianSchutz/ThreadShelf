import { createHash, timingSafeEqual } from 'crypto';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import http from 'http';
import https from 'https';
import { pipeline } from 'stream/promises';
import { getLocalApiAccess } from '../generation/config.js';
import {
  LocalApiError,
  listLocalApiModels,
  resolveLocalApiModel,
  unloadLocalApiModel,
  withLocalApiModel,
  type LocalApiModel,
} from '../generation/local-api.js';
import { localOriginRejection, networkOriginRejection } from './local-origin.js';
import { isLoopbackHttpRequest } from './loopback.js';
import { abortOnDisconnect } from './stream-abort.js';

/**
 * ThreadShelf's local inference API, mounted at `/v1`: the same surface LM
 * Studio and Ollama expose, so any OpenAI or Anthropic SDK, and tools built on
 * them, can use the local llama.cpp models.
 *
 * Inference requests are relayed byte-for-byte to the managed llama-server,
 * which loads the requested model on demand; only `model` is rewritten from the
 * public id. Streaming, tool calls, structured output and sampling parameters
 * therefore behave exactly as llama.cpp implements them. Nothing is written to
 * the archive, and the master prompt is not applied.
 *
 * The same router serves two listeners: the app's own port, open only to this
 * machine, and an optional network port that serves nothing but `/v1`.
 */
export type LocalApiListener = 'local' | 'network';

/** Request paths relayed to llama-server, relative to `/v1`. */
const INFERENCE_ENDPOINTS = [
  '/chat/completions',
  '/completions',
  '/responses',
  '/messages',
  '/messages/count_tokens',
];
const MAX_BODY = '32mb';
const RELAYED_HEADERS = ['content-type', 'content-length', 'cache-control'] as const;

type ErrorDialect = 'openai' | 'anthropic';

/** Anthropic SDKs parse `{type:'error', error:{type,message}}`, OpenAI SDKs `{error:{…}}`. */
const errorDialect = (req: Request): ErrorDialect =>
  req.path === '/messages' ||
  req.path.startsWith('/messages/') ||
  req.headers['anthropic-version'] !== undefined
    ? 'anthropic'
    : 'openai';

const anthropicErrorType = (status: number): string => {
  switch (status) {
    case 400:
      return 'invalid_request_error';
    case 401:
      return 'authentication_error';
    case 403:
      return 'permission_error';
    case 404:
      return 'not_found_error';
    case 413:
      return 'request_too_large';
    case 503:
      return 'overloaded_error';
    default:
      return status < 500 ? 'invalid_request_error' : 'api_error';
  }
};

const sendError = (
  req: Request,
  res: Response,
  status: number,
  message: string,
  { code, param }: { readonly code?: string; readonly param?: string } = {},
): void => {
  if (errorDialect(req) === 'anthropic') {
    res
      .status(status)
      .json({ type: 'error', error: { type: anthropicErrorType(status), message } });
    return;
  }
  res.status(status).json({
    error: {
      message,
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      param: param ?? null,
      code: code ?? null,
    },
  });
};

/** OpenAI's model object; `loaded` is an extra field that SDKs ignore. */
export const openAiModel = (model: LocalApiModel) => ({
  id: model.id,
  object: 'model',
  owned_by: 'threadshelf',
  loaded: model.loaded,
});

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/** OpenAI SDKs send `Authorization: Bearer`, Anthropic SDKs `x-api-key`. */
const presentsApiKey = (req: Request, apiKey: string): boolean => {
  const expected = sha256(apiKey);
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '')?.[1];
  const header = req.headers['x-api-key'];
  return [bearer, typeof header === 'string' ? header.trim() : undefined].some(
    (candidate) => candidate !== undefined && timingSafeEqual(sha256(candidate), expected),
  );
};

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Sends `body` to llama-server and streams its answer back unchanged. Plain
 * `http` rather than `fetch`: a reverse proxy must neither buffer nor time out
 * a long non-streamed generation, and closing the upstream socket when the
 * client leaves is what makes llama-server stop generating.
 */
const relay = (target: URL, body: string, res: Response, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    let answered = false;
    const upstream = (target.protocol === 'https:' ? https : http).request(
      target,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        signal,
      },
      (upstreamRes) => {
        answered = true;
        res.status(upstreamRes.statusCode ?? 502);
        for (const name of RELAYED_HEADERS) {
          const value = upstreamRes.headers[name];
          if (value !== undefined) res.setHeader(name, value);
        }
        if (upstreamRes.headers['content-type']?.startsWith('text/event-stream')) {
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders();
        }
        pipeline(upstreamRes, res).then(resolve, reject);
      },
    );
    upstream.once('error', (error) => {
      if (answered || signal.aborted) {
        reject(error);
        return;
      }
      reject(
        new LocalApiError('upstream_unavailable', `llama-server did not answer: ${error.message}`),
      );
    });
    upstream.end(body);
  });

/**
 * Who may call the API. By default, as in LM Studio and Ollama, any program on
 * this machine may, without a key. A key, once set, is required on both
 * listeners. The Host and Origin checks keep web pages from driving the API
 * through the browser; on the network listener a key makes them redundant.
 */
const accessControl =
  (listener: LocalApiListener) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { enabled, apiKey } = await getLocalApiAccess();
    if (!enabled) {
      sendError(req, res, 403, 'The local model API is turned off in ThreadShelf Settings.', {
        code: 'api_disabled',
      });
      return;
    }
    const rejection =
      listener === 'local'
        ? (localOriginRejection(req) ??
          (isLoopbackHttpRequest(req)
            ? undefined
            : 'The local model API on this port is available only from this machine. Turn on network access in ThreadShelf Settings to serve other devices.'))
        : apiKey
          ? undefined
          : networkOriginRejection(req);
    if (rejection) {
      sendError(req, res, 403, rejection, { code: 'forbidden' });
      return;
    }
    if (apiKey && !presentsApiKey(req, apiKey)) {
      sendError(
        req,
        res,
        401,
        'Invalid or missing API key. Send the key set in ThreadShelf Settings as "Authorization: Bearer <key>" or "x-api-key: <key>".',
        { code: 'invalid_api_key' },
      );
      return;
    }
    next();
  };

export const createLocalApiRouter = (listener: LocalApiListener): Router => {
  const router = Router();
  router.use(accessControl(listener));

  router.use(express.json({ limit: MAX_BODY }));

  router.get('/models', async (_req, res) => {
    const models = await listLocalApiModels();
    res.json({ object: 'list', data: models.map(openAiModel) });
  });

  // ThreadShelf's own addition: frees VRAM now instead of on the idle timeout.
  router.post('/models/unload', async (req, res) => {
    const body: unknown = req.body;
    const requested = isJsonObject(body) ? body.model : undefined;
    res.json(await unloadLocalApiModel(requested));
  });

  // Ids qualified by their folder contain a slash, hence the wildcard.
  router.get('/models/*id', async (req, res) => {
    const segments: unknown = req.params.id;
    const id = Array.isArray(segments) ? segments.join('/') : String(segments ?? '');
    res.json(openAiModel(await resolveLocalApiModel(id)));
  });

  router.post(INFERENCE_ENDPOINTS, async (req, res) => {
    const controller = abortOnDisconnect(req, res);
    if (controller.signal.aborted) return;
    const body: unknown = req.body;
    if (!isJsonObject(body)) {
      throw new LocalApiError(
        'invalid_request',
        'The request body must be a JSON object sent with Content-Type: application/json.',
      );
    }
    try {
      const model = await resolveLocalApiModel(body.model);
      if (controller.signal.aborted) return;
      const payload = JSON.stringify({ ...body, model: model.upstreamModel });
      await withLocalApiModel(model, (baseUrl) => {
        controller.signal.throwIfAborted();
        return relay(new URL(`${baseUrl}${req.path}`), payload, res, controller.signal);
      });
    } catch (error) {
      // The client went away; llama-server has already been told to stop.
      if (controller.signal.aborted) return;
      throw error;
    }
  });

  router.use((req, res) => {
    sendError(
      req,
      res,
      404,
      `Unknown endpoint: ${req.method} /v1${req.path}. Supported: GET /v1/models, POST /v1/models/unload, ${INFERENCE_ENDPOINTS.map((path) => `POST /v1${path}`).join(', ')}.`,
      { code: 'unknown_endpoint' },
    );
  });

  router.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      // Mid-stream: the status is already sent, so cutting the connection is the
      // only honest signal left that the response is incomplete.
      res.destroy();
      return;
    }
    if (error instanceof LocalApiError) {
      sendError(req, res, error.status, error.message, { code: error.kind, param: error.param });
      return;
    }
    // body-parser errors carry an HTTP status and a client-safe message.
    const parserError = error as { status?: unknown; expose?: unknown; message?: unknown };
    if (typeof parserError.status === 'number' && parserError.status < 500) {
      const message =
        parserError.status === 413
          ? `The request body exceeds ${MAX_BODY}.`
          : parserError.expose && typeof parserError.message === 'string'
            ? `Invalid JSON body: ${parserError.message}`
            : 'Invalid request body.';
      sendError(req, res, parserError.status, message);
      return;
    }
    console.error('[/v1]', error);
    sendError(req, res, 500, error instanceof Error ? error.message : 'Internal server error');
  });

  return router;
};
