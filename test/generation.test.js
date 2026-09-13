import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultModelDirectories,
  clearSessionOpenRouterApiKeyForTests,
  effectiveModelDirectories,
  getGenerationConfig,
  getOpenRouterApiKey,
  llamaCppConfigChanged,
  updateGenerationConfig,
} from '../src/generation/config.js';
import { discoverGgufModels, localGgufModelName } from '../src/generation/model-discovery.js';
import { createOpenRouterProvider } from '../src/generation/providers/openrouter.js';
import { createLlamaCppProvider } from '../src/generation/providers/llama-cpp.js';
import {
  generateChat,
  generateChatStream,
  validateChatRequest,
} from '../src/generation/service.js';
import { setGenerationProviderForTests } from '../src/generation/registry.js';
import { CHAT_TITLE_MAX, titleFromPrompt } from '../src/generation/threads.js';
import { loadThreadShelfEnv } from '../src/load-env.js';
import { openAiCompatibleChatStream } from '../src/generation/openai-compatible.js';
import {
  buildLlamaRuntimeArgs,
  assertLlamaModelIdle,
  LlamaModelBusyError,
  parseLlamaDeviceOutput,
  parseLlamaOffload,
  parseLlamaRuntimeCapabilities,
  stopManagedLlamaServer,
  withLlamaModelLease,
  withLlamaRuntimeControl,
} from '../src/generation/llama-process.js';
import {
  browseDirectories,
  isLoopbackAddress,
  isLoopbackRequest,
} from '../src/generation/filesystem-browser.js';

const originalEnv = { ...process.env };

afterEach(async () => {
  clearSessionOpenRouterApiKeyForTests();
  process.env = { ...originalEnv };
});

describe('generation configuration', () => {
  it('loads an OpenRouter key from .env without replacing an explicit environment value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-env-'));
    try {
      const envPath = join(root, '.env');
      await writeFile(envPath, 'OPENROUTER_API_KEY=from-dotenv\n', 'utf8');

      delete process.env.OPENROUTER_API_KEY;
      assert.strictEqual(loadThreadShelfEnv(envPath), true);
      assert.strictEqual(process.env.OPENROUTER_API_KEY, 'from-dotenv');

      process.env.OPENROUTER_API_KEY = 'explicit-parent-value';
      loadThreadShelfEnv(envPath);
      assert.strictEqual(process.env.OPENROUTER_API_KEY, 'explicit-parent-value');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps restrictive OpenRouter routing opt-in by default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-config-defaults-'));
    try {
      process.env.GENERATION_CONFIG_PATH = join(root, 'generation.json');
      const config = await getGenerationConfig();
      assert.strictEqual(config.openRouter.enforceZdr, false);
      assert.strictEqual(config.openRouter.denyDataCollection, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('migrates the old implicit privacy defaults to opt-in routing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-config-migration-'));
    try {
      process.env.GENERATION_CONFIG_PATH = join(root, 'generation.json');
      await writeFile(
        process.env.GENERATION_CONFIG_PATH,
        JSON.stringify({ openRouter: { enforceZdr: true, denyDataCollection: true } }),
      );
      let config = await getGenerationConfig();
      assert.strictEqual(config.openRouter.enforceZdr, false);
      assert.strictEqual(config.openRouter.denyDataCollection, false);
      config = await updateGenerationConfig({});
      assert.strictEqual(config.openRouter.enforceZdr, false);
      const stored = JSON.parse(await readFile(process.env.GENERATION_CONFIG_PATH, 'utf8'));
      assert.strictEqual(stored.schemaVersion, 2);
      assert.strictEqual(stored.openRouter.enforceZdr, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('includes LM Studio, llama.cpp, and Hugging Face model caches by default', () => {
    const paths = defaultModelDirectories({}, join(tmpdir(), 'tester')).map((path) =>
      path.replace(/\\/g, '/'),
    );
    assert.ok(paths.some((path) => path.includes('.lmstudio/models')));
    assert.ok(paths.some((path) => path.includes('.cache/lm-studio/models')));
    assert.ok(paths.some((path) => path.includes('.cache/llama.cpp')));
    assert.ok(paths.some((path) => path.includes('.cache/huggingface/hub')));
  });

  it('persists non-secret settings but keeps OpenRouter keys session-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-config-'));
    try {
      process.env.GENERATION_CONFIG_PATH = join(root, 'generation.json');
      process.env.THREADSHELF_DISABLE_DEFAULT_MODEL_PATHS = '1';
      const config = await updateGenerationConfig({
        llamaCpp: {
          executablePath: join(root, 'llama-server'),
          modelDirectories: [join(root, 'models')],
          contextSize: 16384,
        },
        openRouter: { apiKey: 'super-secret', enforceZdr: true, denyDataCollection: true },
        diagnostics: { persistErrorLogs: false },
      });
      assert.strictEqual(config.openRouter.apiKeyConfigured, true);
      assert.strictEqual(config.llamaCpp.contextSize, 16384);
      assert.strictEqual(config.diagnostics.persistErrorLogs, false);
      const stored = await readFile(process.env.GENERATION_CONFIG_PATH, 'utf8');
      assert.strictEqual(stored.includes('super-secret'), false);
      assert.deepStrictEqual(config.llamaCpp.modelDirectories, [resolve(root, 'models')]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects remote llama.cpp endpoints and invalid context sizes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-config-'));
    try {
      process.env.GENERATION_CONFIG_PATH = join(root, 'generation.json');
      await assert.rejects(
        () => updateGenerationConfig({ llamaCpp: { baseUrl: 'https://example.com' } }),
        /loopback-only/,
      );
      await assert.rejects(
        () => updateGenerationConfig({ llamaCpp: { contextSize: 12 } }),
        /contextSize/,
      );
      await assert.rejects(
        () =>
          updateGenerationConfig({
            llamaCpp: { executablePath: '\\\\attacker\\share\\llama-server.exe' },
          }),
        /network paths are not allowed/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates the whole update before replacing the session OpenRouter key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-config-key-'));
    try {
      process.env.GENERATION_CONFIG_PATH = join(root, 'generation.json');
      process.env.THREADSHELF_DISABLE_DEFAULT_MODEL_PATHS = '1';
      await updateGenerationConfig({ openRouter: { apiKey: 'working-key' } });
      await assert.rejects(
        () =>
          updateGenerationConfig({
            llamaCpp: { contextSize: 12 },
            openRouter: { apiKey: 'must-not-apply' },
          }),
        /contextSize/,
      );
      assert.strictEqual(getOpenRouterApiKey(), 'working-key');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps default model roots runtime-only and honors disabling them after a save', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-config-directories-'));
    try {
      process.env.GENERATION_CONFIG_PATH = join(root, 'generation.json');
      delete process.env.THREADSHELF_DISABLE_DEFAULT_MODEL_PATHS;
      const custom = join(root, 'custom-models');
      let config = await updateGenerationConfig({ llamaCpp: { modelDirectories: [custom] } });
      assert.deepStrictEqual(config.llamaCpp.modelDirectories, [resolve(custom)]);
      assert.ok(config.llamaCpp.defaultModelDirectories.length > 0);
      assert.ok(effectiveModelDirectories(config.llamaCpp).length > 1);
      const stored = JSON.parse(await readFile(process.env.GENERATION_CONFIG_PATH, 'utf8'));
      assert.deepStrictEqual(stored.llamaCpp.modelDirectories, [resolve(custom)]);

      process.env.THREADSHELF_DISABLE_DEFAULT_MODEL_PATHS = '1';
      config = await getGenerationConfig();
      assert.deepStrictEqual(config.llamaCpp.defaultModelDirectories, []);
      // The catalog download directory is always searched, so models fetched from
      // the browser are discoverable without the user configuring a root.
      assert.deepStrictEqual(effectiveModelDirectories(config.llamaCpp), [
        resolve(config.llamaCpp.downloadDirectory),
        resolve(custom),
      ]);
    } finally {
      delete process.env.THREADSHELF_MODELS_PATH;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores an invalid generation env override and identifies it in a warning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-config-env-'));
    const warnings = [];
    const originalWarn = console.warn;
    try {
      process.env.GENERATION_CONFIG_PATH = join(root, 'generation.json');
      process.env.THREADSHELF_DISABLE_DEFAULT_MODEL_PATHS = '1';
      await updateGenerationConfig({ llamaCpp: { contextSize: 16384 } });
      process.env.LLAMA_CPP_CONTEXT_SIZE = '8k-test-value';
      console.warn = (...args) => warnings.push(args.join(' '));
      const config = await getGenerationConfig();
      assert.strictEqual(config.llamaCpp.contextSize, 16384);
      assert.ok(warnings.some((warning) => warning.includes('LLAMA_CPP_CONTEXT_SIZE')));
    } finally {
      console.warn = originalWarn;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('restarts llama.cpp only when its effective settings changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-config-restart-'));
    try {
      process.env.GENERATION_CONFIG_PATH = join(root, 'generation.json');
      process.env.THREADSHELF_DISABLE_DEFAULT_MODEL_PATHS = '1';
      const before = await getGenerationConfig();
      await updateGenerationConfig({ openRouter: { apiKey: 'key-only' } });
      const keyOnly = await getGenerationConfig();
      assert.strictEqual(llamaCppConfigChanged(before, keyOnly), false);
      const changed = await updateGenerationConfig({ llamaCpp: { contextSize: 16384 } });
      assert.strictEqual(llamaCppConfigChanged(keyOnly, changed), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('maps common CPU, GPU, hybrid, and multi-GPU profiles to current llama.cpp flags', () => {
    const base = {
      modelDirectories: [],
      contextSize: 8192,
      acceleration: 'auto',
      gpuLayers: 24,
      splitMode: 'layer',
      mainGpu: 1,
      tensorSplit: '3,1',
      threads: 12,
      flashAttention: 'auto',
    };
    assert.deepStrictEqual(buildLlamaRuntimeArgs(base).slice(-6), [
      '--threads',
      '12',
      '--n-gpu-layers',
      'auto',
      '--fit',
      'on',
    ]);
    assert.match(buildLlamaRuntimeArgs({ ...base, acceleration: 'cpu' }).join(' '), /gpu-layers 0/);
    assert.match(
      buildLlamaRuntimeArgs({ ...base, acceleration: 'gpu' }).join(' '),
      /gpu-layers auto .*split-mode none .*main-gpu 1/,
    );
    assert.match(
      buildLlamaRuntimeArgs({ ...base, acceleration: 'hybrid' }).join(' '),
      /gpu-layers 24/,
    );
    assert.match(
      buildLlamaRuntimeArgs({ ...base, acceleration: 'multi-gpu' }).join(' '),
      /gpu-layers auto .*split-mode layer .*tensor-split 3,1/,
    );
  });

  it('falls back to flags accepted by older llama.cpp builds', () => {
    const base = {
      modelDirectories: [],
      defaultModelDirectories: [],
      contextSize: 8192,
      acceleration: 'auto',
      gpuLayers: 24,
      splitMode: 'layer',
      mainGpu: 0,
      threads: -1,
      flashAttention: 'auto',
    };
    const legacy = parseLlamaRuntimeCapabilities(`--n-gpu-layers N\n--flash-attn\n`);
    assert.deepStrictEqual(legacy, {
      autoFit: false,
      flashAttentionFlag: true,
      flashAttentionValues: false,
      flashAttentionAuto: false,
      kvCacheTypes: false,
      speculativeTypes: [],
      parallelSlots: false,
      reasoningEffort: false,
      reasoningToggle: false,
    });
    const legacyArgs = buildLlamaRuntimeArgs(base, legacy);
    assert.deepStrictEqual(legacyArgs, ['--ctx-size', '8192', '--n-gpu-layers', '999']);
    assert.deepStrictEqual(
      buildLlamaRuntimeArgs({ ...base, flashAttention: 'on' }, legacy).slice(0, 3),
      ['--ctx-size', '8192', '--flash-attn'],
    );

    const intermediate = parseLlamaRuntimeCapabilities(`--flash-attn [on|off]\n`);
    assert.strictEqual(intermediate.flashAttentionAuto, false);
    assert.deepStrictEqual(buildLlamaRuntimeArgs(base, intermediate), [
      '--ctx-size',
      '8192',
      '--n-gpu-layers',
      '999',
    ]);
    assert.deepStrictEqual(
      buildLlamaRuntimeArgs({ ...base, flashAttention: 'on' }, intermediate).slice(0, 4),
      ['--ctx-size', '8192', '--flash-attn', 'on'],
    );

    const current = parseLlamaRuntimeCapabilities(
      `--n-gpu-layers N (auto or all)\n--fit [on|off]\n--flash-attn [on|off|auto]\n`,
    );
    assert.strictEqual(current.autoFit, true);
    assert.strictEqual(current.flashAttentionValues, true);
    assert.strictEqual(current.flashAttentionAuto, true);
    assert.match(buildLlamaRuntimeArgs(base, current).join(' '), /gpu-layers auto --fit on/);
  });

  it('keeps a model leased until all of its parallel chats finish', async () => {
    let releaseFirst;
    const first = withLlamaModelLease(
      join(tmpdir(), 'first.gguf'),
      () => new Promise((resolveFirst) => (releaseFirst = resolveFirst)),
    );
    const sameModel = withLlamaModelLease(join(tmpdir(), 'first.gguf'), async () => 'same');
    await assert.rejects(
      () => withLlamaModelLease(join(tmpdir(), 'second.gguf'), async () => 'wrong'),
      LlamaModelBusyError,
    );
    assert.throws(() => assertLlamaModelIdle(), LlamaModelBusyError);
    await assert.rejects(() => stopManagedLlamaServer(), LlamaModelBusyError);
    assert.strictEqual(await sameModel, 'same');
    releaseFirst('first');
    assert.strictEqual(await first, 'first');
    assert.strictEqual(
      await withLlamaModelLease(join(tmpdir(), 'second.gguf'), async () => 'after'),
      'after',
    );

    let releaseControl;
    const control = withLlamaRuntimeControl(
      () => new Promise((resolveControl) => (releaseControl = resolveControl)),
    );
    await assert.rejects(
      () => withLlamaModelLease(join(tmpdir(), 'first.gguf'), async () => 'blocked'),
      LlamaModelBusyError,
    );
    releaseControl();
    await control;
  });

  it('browses directories only and recognizes loopback clients', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-directory-browser-'));
    try {
      await mkdir(join(root, 'Models'));
      await writeFile(join(root, 'private.txt'), 'not listed', 'utf8');
      const result = await browseDirectories(root);
      assert.deepStrictEqual(
        result.directories.map((entry) => entry.name),
        ['Models'],
      );
      assert.strictEqual(isLoopbackAddress('::ffff:127.0.0.1'), true);
      assert.strictEqual(isLoopbackAddress('192.168.1.10'), false);
      assert.strictEqual(isLoopbackRequest('127.0.0.1', '127.0.0.1'), true);
      assert.strictEqual(isLoopbackRequest('127.0.0.1', '203.0.113.7'), false);
      assert.strictEqual(isLoopbackRequest('127.0.0.1', undefined, 'for=203.0.113.7'), false);
      assert.strictEqual(
        isLoopbackRequest('127.0.0.1', undefined, undefined, 'threadshelf.example'),
        false,
      );
      assert.strictEqual(isLoopbackRequest('127.0.0.1', undefined, undefined, 'localhost'), true);
      assert.strictEqual(isLoopbackRequest('192.168.1.10'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('generation streaming', () => {
  it('parses fragmented OpenAI-compatible SSE deltas and usage', async () => {
    const encoder = new TextEncoder();
    const payload = [
      'data: {"model":"stream-model","choices":[{"delta":{"reasoning_content":"brief "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6},"timings":{"prompt_per_second":80,"predicted_per_second":25.5,"predicted_ms":78.4}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const cuts = [17, 83, 141, payload.length];
    let start = 0;
    const chunks = cuts.map((end) => {
      const chunk = encoder.encode(payload.slice(start, end));
      start = end;
      return chunk;
    });
    let sentBody;
    const deltas = [];
    const response = await openAiCompatibleChatStream(
      {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.test/api/v1',
        apiKey: 'secret',
        request: {
          provider: 'openrouter',
          model: 'stream-model',
          messages: [{ role: 'user', content: 'hello' }],
        },
        fetchImpl: async (_url, init) => {
          sentBody = JSON.parse(init.body);
          return new Response(
            new ReadableStream({
              start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk);
                controller.close();
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      },
      (delta) => deltas.push(delta),
    );

    assert.strictEqual(sentBody.stream, true);
    assert.deepStrictEqual(sentBody.stream_options, { include_usage: true });
    assert.strictEqual(deltas.map((delta) => delta.content || '').join(''), 'Hello world');
    assert.strictEqual(deltas.map((delta) => delta.reasoning || '').join(''), 'brief ');
    assert.strictEqual(response.content, 'Hello world');
    assert.strictEqual(response.reasoning, 'brief');
    assert.deepStrictEqual(response.usage, {
      promptTokens: 4,
      completionTokens: 2,
      totalTokens: 6,
    });
    assert.deepStrictEqual(response.performance, {
      completionTokensPerSecond: 25.5,
      promptTokensPerSecond: 80,
      generationMs: 78.4,
      source: 'provider',
    });
  });

  it('reports the provider, stream stage, and nested transport cause', async () => {
    const inputError = new Error('Error in input stream', {
      cause: new Error('socket closed by upstream process'),
    });
    await assert.rejects(
      openAiCompatibleChatStream(
        {
          provider: 'llama-cpp',
          baseUrl: 'http://127.0.0.1:1234/v1',
          request: {
            provider: 'llama-cpp',
            model: 'crashing-model',
            messages: [{ role: 'user', content: 'hello' }],
          },
          fetchImpl: async () =>
            new Response(
              new ReadableStream({
                pull() {
                  throw inputError;
                },
              }),
              { headers: { 'content-type': 'text/event-stream' } },
            ),
        },
        () => undefined,
      ),
      /llama-cpp response stream failed: Error in input stream → socket closed by upstream process/,
    );
  });

  it('does not report a transport false positive after the SSE done marker', async () => {
    const encoder = new TextEncoder();
    let pullCount = 0;
    const response = await openAiCompatibleChatStream(
      {
        provider: 'llama-cpp',
        baseUrl: 'http://127.0.0.1:1234/v1',
        request: {
          provider: 'llama-cpp',
          model: 'completed-model',
          messages: [{ role: 'user', content: 'hello' }],
        },
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                pullCount += 1;
                if (pullCount === 1) {
                  controller.enqueue(
                    encoder.encode(
                      'data: {"choices":[{"delta":{"content":"Complete answer"}}]}\n\n' +
                        'data: [DONE]\n\n',
                    ),
                  );
                  return;
                }
                controller.error(new Error('Error in input stream'));
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      },
      () => undefined,
    );

    assert.strictEqual(response.content, 'Complete answer');
  });

  it('preserves a plain-text OpenRouter HTTP error response', async () => {
    await assert.rejects(
      openAiCompatibleChatStream(
        {
          provider: 'openrouter',
          baseUrl: 'https://openrouter.test/api/v1',
          request: {
            provider: 'openrouter',
            model: 'remote-model',
            messages: [{ role: 'user', content: 'hello' }],
          },
          fetchImpl: async () =>
            new Response('upstream provider is temporarily unavailable', {
              status: 502,
              statusText: 'Bad Gateway',
            }),
        },
        () => undefined,
      ),
      /openrouter request failed: upstream provider is temporarily unavailable/,
    );
  });

  it('dispatches streaming through the provider plugin contract', async () => {
    const restore = setGenerationProviderForTests('llama-cpp', {
      id: 'llama-cpp',
      label: 'Streaming fake',
      local: true,
      status: async () => ({
        id: 'llama-cpp',
        label: 'Streaming fake',
        available: true,
        local: true,
        detail: 'test',
      }),
      listModels: async () => [],
      chat: async () => ({ provider: 'llama-cpp', model: 'fake', content: 'unused' }),
      chatStream: async (request, onDelta) => {
        await onDelta({ content: 'streamed' });
        return { provider: 'llama-cpp', model: request.model, content: 'streamed' };
      },
    });
    try {
      const deltas = [];
      const response = await generateChatStream(
        {
          provider: 'llama-cpp',
          model: 'fake.gguf',
          messages: [{ role: 'user', content: 'plugin streams' }],
        },
        (delta) => deltas.push(delta.content),
      );
      assert.deepStrictEqual(deltas, ['streamed']);
      assert.strictEqual(response.content, 'streamed');
    } finally {
      restore();
    }
  });
});

describe('GGUF discovery', () => {
  it('scans nested LM Studio layouts, deduplicates roots, and ignores mmproj and later shards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-models-'));
    try {
      const nested = join(root, 'publisher', 'model');
      await mkdir(nested, { recursive: true });
      await Promise.all([
        writeFile(join(nested, 'model-Q4_K_M.gguf'), 'model'),
        writeFile(join(nested, 'mmproj-model-f16.gguf'), 'projector'),
        writeFile(join(nested, 'large-00001-of-00002.gguf'), 'first'),
        writeFile(join(nested, 'large-00002-of-00002.gguf'), 'second'),
        writeFile(join(nested, 'notes.txt'), 'ignore'),
      ]);
      const models = await discoverGgufModels([root, nested]);
      assert.deepStrictEqual(
        models.map((model) => model.name),
        ['large-00001-of-00002', 'model-Q4_K_M'],
      );
      assert.ok(models.every((model) => model.provider === 'llama-cpp'));
      assert.ok(models.every((model) => Number.isInteger(model.sizeBytes)));
      assert.strictEqual(localGgufModelName(models[1].id), 'model-Q4_K_M');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps roots on a different drive instead of folding them into the first one', async () => {
    // On Windows `path.relative` between drives returns an absolute path with no
    // `..` prefix. Treating that as "nested" silently dropped every model root
    // that did not share a drive with the first one.
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-crossdrive-'));
    try {
      await writeFile(join(root, 'only-Q4_K_M.gguf'), 'model');
      const otherDrive = process.platform === 'win32' ? 'Z:\models' : '/mnt/other-models';
      const models = await discoverGgufModels([otherDrive, root]);
      assert.deepStrictEqual(
        models.map((model) => model.name),
        ['only-Q4_K_M'],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('generation providers', () => {
  it('uses an existing loopback llama.cpp server through the same plugin contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-llama-provider-'));
    const calls = [];
    try {
      process.env.GENERATION_CONFIG_PATH = join(root, 'generation.json');
      process.env.THREADSHELF_DISABLE_DEFAULT_MODEL_PATHS = '1';
      process.env.LLAMA_CPP_BASE_URL = 'http://127.0.0.1:18080';
      const mockFetch = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith('/v1/models')) {
          return Response.json({ data: [{ id: 'loaded-local-model' }] });
        }
        return Response.json({
          model: 'loaded-local-model',
          choices: [{ message: { content: 'local answer' } }],
        });
      };
      const provider = createLlamaCppProvider(mockFetch);
      const status = await provider.status();
      assert.strictEqual(status.available, true);
      assert.strictEqual(status.local, true);
      const models = await provider.listModels();
      assert.deepStrictEqual(
        models.map((entry) => entry.id),
        ['loaded-local-model'],
      );
      const response = await provider.chat({
        provider: 'llama-cpp',
        model: 'loaded-local-model',
        messages: [{ role: 'user', content: 'hello locally' }],
      });
      assert.strictEqual(response.content, 'local answer');
      assert.strictEqual(calls.at(-1).url, 'http://127.0.0.1:18080/v1/chat/completions');
      assert.strictEqual(calls.at(-1).init.headers.Authorization, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('discovers current OpenRouter models and applies ZDR only when requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-openrouter-'));
    const calls = [];
    try {
      process.env.GENERATION_CONFIG_PATH = join(root, 'generation.json');
      process.env.OPENROUTER_BASE_URL = 'https://openrouter.test/api/v1';
      await updateGenerationConfig({ openRouter: { apiKey: 'session-key' } });
      const mockFetch = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        if (String(url).includes('/models')) {
          return Response.json({
            data: [
              {
                id: 'vendor/current-model',
                name: 'Current Model',
                context_length: 131072,
                pricing: { prompt: '0.1', completion: '0.2' },
              },
              {
                id: 'vendor/free-model:free',
                name: 'Free Model',
                created: 1_700_000_000,
                pricing: { prompt: '0', completion: '0' },
              },
            ],
          });
        }
        return Response.json({
          model: 'vendor/current-model',
          choices: [{ message: { content: 'answer', reasoning_content: 'brief reasoning' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        });
      };
      const provider = createOpenRouterProvider(mockFetch);
      const models = await provider.listModels();
      assert.strictEqual(models[0].id, 'vendor/current-model');
      const response = await provider.chat({
        provider: 'openrouter',
        model: models[0].id,
        messages: [{ role: 'user', content: 'hello' }],
      });
      assert.strictEqual(response.content, 'answer');
      const body = JSON.parse(calls[1].init.body);
      assert.strictEqual(body.provider, undefined);
      assert.strictEqual(calls[1].init.headers.Authorization, 'Bearer session-key');
      await provider.chat({
        provider: 'openrouter',
        model: models[0].id,
        messages: [{ role: 'user', content: 'private request' }],
        openRouterZdr: true,
      });
      assert.deepStrictEqual(JSON.parse(calls[2].init.body).provider, { zdr: true });
      const freeModels = await provider.listModels({ sort: 'newest', freeOnly: true });
      assert.deepStrictEqual(
        freeModels.map((model) => model.id),
        ['vendor/free-model:free'],
      );
      assert.match(calls[3].url, /sort=newest/);
      assert.strictEqual(freeModels[0].createdAt, '2023-11-14T22:13:20.000Z');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('parses llama.cpp devices, memory, and actual CPU/GPU layer placement', () => {
    const devices = parseLlamaDeviceOutput(`
Available devices:
  CUDA0: NVIDIA Example GPU (12288 MiB, 9216 MiB free)
  Vulkan1: AMD Example GPU (16384 MiB, 12000 MiB free)
`);
    assert.strictEqual(devices.supported, true);
    assert.strictEqual(devices.devices.length, 2);
    assert.strictEqual(devices.devices[0].freeBytes, 9216 * 1024 ** 2);

    const offload = parseLlamaOffload(`
load_tensors: offloaded 24/40 layers to GPU
load_tensors: CUDA0 model buffer size = 6144.00 MiB
load_tensors: CPU model buffer size = 4096.00 MiB
`);
    assert.strictEqual(offload.mode, 'hybrid');
    assert.strictEqual(offload.gpuPercent, 60);
    assert.strictEqual(offload.cpuPercent, 40);
    assert.deepStrictEqual(offload.deviceBufferMiB, { CUDA0: 6144, CPU: 4096 });

    const cpuOnly = parseLlamaDeviceOutput('Available devices:\n');
    assert.strictEqual(parseLlamaOffload('', cpuOnly.devices, cpuOnly.supported).mode, 'cpu');
  });

  it('validates provider, roles, bounds, and total context before dispatch', () => {
    assert.throws(() => validateChatRequest({}), /Invalid provider/);
    assert.throws(
      () =>
        validateChatRequest({
          provider: 'llama-cpp',
          model: 'x',
          messages: [{ role: 'tool', content: 'x' }],
        }),
      /role/,
    );
    assert.throws(
      () =>
        validateChatRequest({
          provider: 'llama-cpp',
          model: 'x',
          messages: [{ role: 'user', content: 'x' }],
          maxTokens: 0,
        }),
      /maxTokens/,
    );
    assert.strictEqual(
      validateChatRequest({
        provider: 'llama-cpp',
        model: 'x',
        messages: [{ role: 'user', content: 'private' }],
        persistDiagnostics: false,
      }).persistDiagnostics,
      false,
    );
  });

  it('dispatches through the plugin registry contract', async () => {
    const restore = setGenerationProviderForTests('llama-cpp', {
      id: 'llama-cpp',
      label: 'Fake llama.cpp',
      local: true,
      status: async () => ({
        id: 'llama-cpp',
        label: 'Fake llama.cpp',
        available: true,
        local: true,
        detail: 'test',
      }),
      listModels: async () => [],
      chat: async (request) => ({
        provider: 'llama-cpp',
        model: request.model,
        content: request.messages.at(-1).content.toUpperCase(),
      }),
      chatStream: async (request, onDelta) => {
        const content = request.messages.at(-1).content.toUpperCase();
        await onDelta({ content });
        return { provider: 'llama-cpp', model: request.model, content };
      },
    });
    try {
      const response = await generateChat({
        provider: 'llama-cpp',
        model: 'fake.gguf',
        messages: [{ role: 'user', content: 'plugin works' }],
      });
      assert.strictEqual(response.content, 'PLUGIN WORKS');
    } finally {
      restore();
    }
  });
});

describe('auto-derived chat titles', () => {
  it('keeps the whole prompt instead of cutting it at a display-friendly length', () => {
    // The derived title is persisted, so anything dropped here is unrecoverable:
    // no tooltip or thread reader can show text that was never stored. Chats
    // created before this was fixed still carry titles elided at ~50-70 chars.
    const prompt =
      'Chciałbym abyś napisał 15 zdan w kursie następującym, uwzględniając odmianę ' +
      'przez przypadki oraz przykłady użycia w mowie potocznej i pisanej';
    assert.ok(prompt.length > 72, 'fixture must exceed the old 72-char cut');

    const title = titleFromPrompt(prompt);
    assert.strictEqual(title, prompt);
    assert.ok(!title.endsWith('…'), 'a title within the cap must not be elided');
  });

  it('collapses whitespace and only elides beyond the persisted ceiling', () => {
    assert.strictEqual(
      titleFromPrompt('  wiele   spacji \n i nowa linia  '),
      'wiele spacji i nowa linia',
    );

    const tooLong = 'ą'.repeat(CHAT_TITLE_MAX + 50);
    const elided = titleFromPrompt(tooLong);
    assert.strictEqual(elided.length, CHAT_TITLE_MAX);
    assert.ok(elided.endsWith('…'));
  });
});
