import { describe, it } from 'node:test';
import assert from 'node:assert';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer } from './helpers.js';
import { createFakeLlamaServer, fakeLlamaUnavailable } from '../shared/fake-llama.js';
import { syntheticMtpModel } from '../shared/gguf.js';
import { startLocalApiUpstream } from '../shared/local-api-upstream.js';

const post = (url, body, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

/** `fetch` cannot forge Host/Origin, so header-guard checks use plain http. */
const rawGet = (baseUrl, path, headers) =>
  new Promise((resolve, reject) => {
    const req = request(new URL(path, baseUrl), { headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end();
  });

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const putConfig = async (baseUrl, update) => {
  const response = await fetch(`${baseUrl}/api/generation/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  });
  const body = await response.json();
  assert.strictEqual(response.ok, true, JSON.stringify(body));
  return body;
};

const waitFor = async (check, message, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(message);
};

/** A fake llama-server, two small GGUF files and a ThreadShelf server using them. */
const startWithModels = async (prefix, env = {}) => {
  const toolsRoot = await mkdtemp(join(tmpdir(), prefix));
  const executable = await createFakeLlamaServer(join(toolsRoot, 'bin'));
  const modelsDir = join(toolsRoot, 'models');
  await mkdir(modelsDir, { recursive: true });
  await writeFile(join(modelsDir, 'Alpha.Q4_K_M.gguf'), syntheticMtpModel(1));
  await writeFile(join(modelsDir, 'Beta.Q8_0.gguf'), syntheticMtpModel(1));
  const ctx = await startApiServer({ prefix, env: { LLAMA_CPP_SERVER: executable, ...env } });
  await putConfig(ctx.baseUrl, { llamaCpp: { modelDirectories: [modelsDir] } });
  return {
    ...ctx,
    v1: `${ctx.baseUrl}/v1`,
    stop: async () => {
      await ctx.stop();
      await rm(toolsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
};

const loadedIds = async (v1, headers = {}) => {
  const response = await fetch(`${v1}/models`, { headers });
  assert.strictEqual(response.status, 200);
  return (await response.json()).data.filter((model) => model.loaded).map((model) => model.id);
};

const chat = (v1, model, headers = {}) =>
  post(
    `${v1}/chat/completions`,
    { model, stream: false, messages: [{ role: 'user', content: 'hi' }] },
    headers,
  );

describe('local model API (/v1) E2E', () => {
  it(
    'turning off network access closes active inference without disabling loopback access',
    { timeout: 30_000 },
    async () => {
      const upstream = await startLocalApiUpstream();
      let ctx;
      const controller = new AbortController();
      try {
        ctx = await startApiServer({
          prefix: 'threadshelf-api-network-close-',
          env: { LLAMA_CPP_BASE_URL: upstream.baseUrl },
        });
        const port = await freePort();
        await putConfig(ctx.baseUrl, { localApi: { networkAccess: true, networkPort: port } });
        const gate = upstream.holdNextInference();
        const stream = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'synthetic-model', stream: true, messages: [] }),
          signal: controller.signal,
        });
        const reader = stream.body.getReader();
        await reader.read();
        await gate.started;
        const disconnected = reader.read();
        const rejected = assert.rejects(disconnected);
        await putConfig(ctx.baseUrl, { localApi: { networkAccess: false } });
        await gate.disconnected;
        await rejected;
        await assert.rejects(() => fetch(`http://127.0.0.1:${port}/v1/models`));
        assert.equal((await fetch(`${ctx.baseUrl}/v1/models`)).status, 200);
      } finally {
        controller.abort();
        await ctx?.stop();
        await upstream.stop();
      }
    },
  );

  it(
    'does not start inference after disconnection during model lookup',
    { timeout: 30_000 },
    async () => {
      const upstream = await startLocalApiUpstream();
      let ctx;
      try {
        ctx = await startApiServer({
          prefix: 'threadshelf-api-cancel-lookup-',
          env: { LLAMA_CPP_BASE_URL: upstream.baseUrl },
        });
        const gate = upstream.holdNextModelList();
        const client = request(`${ctx.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        });
        client.on('error', () => {});
        const closed = new Promise((resolve) => client.once('close', resolve));
        client.end(
          JSON.stringify({
            model: 'synthetic-model',
            stream: false,
            messages: [{ role: 'user', content: 'cancelled' }],
          }),
        );
        await gate.started;
        client.destroy();
        await closed;
        gate.release();
        await gate.finished;
        const control = await post(`${ctx.baseUrl}/v1/chat/completions`, {
          model: 'synthetic-model',
          stream: false,
          messages: [{ role: 'user', content: 'control' }],
        });
        assert.equal(control.status, 200);
        await control.text();
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(
          upstream.requests.map((req) => req.body.messages[0].content),
          ['control'],
        );
      } finally {
        await ctx?.stop();
        await upstream.stop();
      }
    },
  );

  it(
    'closes upstream streaming inference and releases the lease when the client cancels',
    { timeout: 30_000 },
    async () => {
      const upstream = await startLocalApiUpstream();
      let ctx;
      try {
        ctx = await startApiServer({
          prefix: 'threadshelf-api-cancel-stream-',
          env: { LLAMA_CPP_BASE_URL: upstream.baseUrl },
        });
        const gate = upstream.holdNextInference();
        const controller = new AbortController();
        const stream = await fetch(`${ctx.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'synthetic-model', stream: true, messages: [] }),
          signal: controller.signal,
        });
        await stream.body.getReader().read();
        await gate.started;
        controller.abort();
        await gate.disconnected;
        await waitFor(async () => {
          const response = await fetch(`${ctx.baseUrl}/api/generation/config`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ llamaCpp: { idleUnloadMinutes: 0 } }),
          });
          return response.status === 200;
        }, 'cancelled request still holds the runtime lease');
        const next = await chat(`${ctx.baseUrl}/v1`, 'synthetic-model');
        assert.equal(next.status, 200);
        await next.text();
      } finally {
        await ctx?.stop();
        await upstream.stop();
      }
    },
  );

  it(
    'serves OpenAI- and Anthropic-compatible endpoints over the managed llama-server',
    { timeout: 180_000, skip: fakeLlamaUnavailable() },
    async () => {
      const toolsRoot = await mkdtemp(join(tmpdir(), 'threadshelf-local-api-'));
      const executable = await createFakeLlamaServer(join(toolsRoot, 'bin'));
      const modelsDir = join(toolsRoot, 'models');
      // Two folders holding the same file name exercise id disambiguation.
      await mkdir(join(modelsDir, 'vendor-a'), { recursive: true });
      await mkdir(join(modelsDir, 'vendor-b'), { recursive: true });
      await writeFile(join(modelsDir, 'Solo-Model.Q8_0.gguf'), syntheticMtpModel(1));
      await writeFile(join(modelsDir, 'vendor-a', 'twin.gguf'), syntheticMtpModel(1));
      await writeFile(join(modelsDir, 'vendor-b', 'twin.gguf'), syntheticMtpModel(1));

      const ctx = await startApiServer({
        prefix: 'threadshelf-local-api-',
        env: { LLAMA_CPP_SERVER: executable },
      });
      const v1 = `${ctx.baseUrl}/v1`;

      try {
        const configured = await fetch(`${ctx.baseUrl}/api/generation/config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ llamaCpp: { modelDirectories: [modelsDir] } }),
        });
        assert.strictEqual(configured.ok, true, await configured.clone().text());

        // Model list: short file-name ids, folder-qualified only on a collision.
        let response = await fetch(`${v1}/models`);
        assert.strictEqual(response.status, 200);
        const list = await response.json();
        assert.strictEqual(list.object, 'list');
        assert.deepStrictEqual(list.data.map((model) => model.id).sort(), [
          'Solo-Model.Q8_0',
          'vendor-a/twin',
          'vendor-b/twin',
        ]);
        assert.deepStrictEqual(list.data[0], {
          id: list.data[0].id,
          object: 'model',
          owned_by: 'threadshelf',
          loaded: false,
        });
        assert.ok(!JSON.stringify(list).includes(modelsDir), 'model paths must not leak');

        response = await fetch(`${v1}/models/vendor-a/twin`);
        assert.strictEqual(response.status, 200);
        assert.strictEqual((await response.json()).id, 'vendor-a/twin');

        // Non-streamed relay: the body reaches llama-server with `model` set to its alias.
        response = await post(`${v1}/chat/completions`, {
          model: 'solo-model.q8_0',
          stream: false,
          temperature: 0.2,
          messages: [{ role: 'user', content: 'Say hi' }],
        });
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(await response.json(), {
          path: '/v1/chat/completions',
          model: 'Solo-Model.Q8_0',
          content: 'Fake llama answer',
        });

        // Streamed relay keeps the server-sent events intact.
        response = await post(`${v1}/chat/completions`, {
          model: 'Solo-Model.Q8_0',
          stream: true,
          messages: [{ role: 'user', content: 'Say hi' }],
        });
        assert.strictEqual(response.status, 200);
        assert.match(response.headers.get('content-type'), /^text\/event-stream/);
        const events = await response.text();
        assert.match(events, /"content":"Fake llama answer"/);
        assert.match(events, /data: \[DONE\]/);

        for (const path of ['/completions', '/responses', '/messages', '/messages/count_tokens']) {
          response = await post(`${v1}${path}`, { model: 'vendor-b/twin', input: 'hi' });
          assert.strictEqual(response.status, 200, path);
          assert.deepStrictEqual(await response.json(), {
            path: `/v1${path}`,
            model: 'twin',
            content: 'Fake llama answer',
          });
        }

        // Errors use the calling SDK's own shape.
        response = await post(`${v1}/chat/completions`, { messages: [] });
        assert.strictEqual(response.status, 400);
        let error = (await response.json()).error;
        assert.strictEqual(error.type, 'invalid_request_error');
        assert.strictEqual(error.param, 'model');
        assert.match(error.message, /Solo-Model\.Q8_0/);

        response = await post(`${v1}/chat/completions`, { model: 'missing', messages: [] });
        assert.strictEqual(response.status, 404);
        error = (await response.json()).error;
        assert.strictEqual(error.code, 'model_not_found');

        response = await post(`${v1}/messages`, { model: 'missing', messages: [] });
        assert.strictEqual(response.status, 404);
        assert.deepStrictEqual(await response.json(), {
          type: 'error',
          error: { type: 'not_found_error', message: error.message },
        });

        response = await post(`${v1}/chat/completions`, '{not json');
        assert.strictEqual(response.status, 400);
        assert.match((await response.json()).error.message, /^Invalid JSON body/);

        response = await post(`${v1}/embeddings`, { model: 'Solo-Model.Q8_0', input: 'x' });
        assert.strictEqual(response.status, 404);
        assert.strictEqual((await response.json()).error.code, 'unknown_endpoint');

        // Same browser boundary as /api: no DNS rebinding, no cross-site callers.
        const port = new URL(ctx.baseUrl).port;
        let raw = await rawGet(ctx.baseUrl, '/v1/models', { host: `attacker.example:${port}` });
        assert.strictEqual(raw.status, 403);
        raw = await rawGet(ctx.baseUrl, '/v1/models', {
          host: `127.0.0.1:${port}`,
          origin: 'https://attacker.example',
        });
        assert.strictEqual(raw.status, 403);
        assert.strictEqual(raw.body.error.message, 'Forbidden origin');

        // Inference through /v1 is never archived.
        response = await fetch(`${ctx.baseUrl}/api/generation/threads`);
        assert.deepStrictEqual((await response.json()).threads, []);
      } finally {
        await ctx.stop();
        await rm(toolsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    },
  );

  it(
    'is open by default and requires the API key once one is set',
    { timeout: 180_000, skip: fakeLlamaUnavailable() },
    async () => {
      const ctx = await startWithModels('threadshelf-local-api-key-');
      try {
        // Default: like LM Studio and Ollama, no key and any key are both accepted.
        assert.strictEqual((await fetch(`${ctx.v1}/models`)).status, 200);
        assert.strictEqual(
          (await fetch(`${ctx.v1}/models`, { headers: { authorization: 'Bearer anything' } }))
            .status,
          200,
        );

        let body = await putConfig(ctx.baseUrl, { localApi: { apiKey: 'ts-test-key' } });
        assert.strictEqual(body.config.localApi.apiKeyConfigured, true);
        assert.strictEqual(body.config.localApi.apiKeySource, 'settings');
        assert.ok(!JSON.stringify(body).includes('ts-test-key'), 'the key is never returned');

        // Missing or wrong key: 401 in each SDK's own error shape.
        let response = await fetch(`${ctx.v1}/models`);
        assert.strictEqual(response.status, 401);
        const error = (await response.json()).error;
        assert.strictEqual(error.code, 'invalid_api_key');
        assert.strictEqual(error.type, 'invalid_request_error');

        response = await post(
          `${ctx.v1}/messages`,
          { model: 'Alpha.Q4_K_M' },
          { 'x-api-key': 'no' },
        );
        assert.strictEqual(response.status, 401);
        assert.strictEqual((await response.json()).error.type, 'authentication_error');

        response = await chat(ctx.v1, 'Alpha.Q4_K_M', { authorization: 'Bearer ts-test-key2' });
        assert.strictEqual(response.status, 401);
        response = await chat(ctx.v1, 'Alpha.Q4_K_M', { authorization: 'Basic ts-test-key' });
        assert.strictEqual(response.status, 401);

        // OpenAI SDKs send a bearer token, Anthropic SDKs x-api-key.
        response = await chat(ctx.v1, 'Alpha.Q4_K_M', { authorization: 'Bearer ts-test-key' });
        assert.strictEqual(response.status, 200);
        response = await chat(ctx.v1, 'Alpha.Q4_K_M', { authorization: 'bearer ts-test-key' });
        assert.strictEqual(response.status, 200);
        response = await post(
          `${ctx.v1}/messages`,
          { model: 'Alpha.Q4_K_M', messages: [] },
          { 'x-api-key': 'ts-test-key' },
        );
        assert.strictEqual(response.status, 200);

        // The key does not replace the browser boundary on the loopback port.
        const port = new URL(ctx.baseUrl).port;
        const raw = await rawGet(ctx.baseUrl, '/v1/models', {
          host: `attacker.example:${port}`,
          authorization: 'Bearer ts-test-key',
        });
        assert.strictEqual(raw.status, 403);

        // The settings page still lists models without the key.
        response = await fetch(`${ctx.baseUrl}/api/generation/local-api`);
        assert.strictEqual(response.status, 200);
        body = await response.json();
        assert.deepStrictEqual(body.models.map((model) => model.id).sort(), [
          'Alpha.Q4_K_M',
          'Beta.Q8_0',
        ]);
        assert.deepStrictEqual(body.network, { state: 'off', urls: [] });

        // Clearing the key opens the API again.
        await putConfig(ctx.baseUrl, { localApi: { clearApiKey: true } });
        assert.strictEqual((await fetch(`${ctx.v1}/models`)).status, 200);
      } finally {
        await ctx.stop();
      }
    },
  );

  it(
    'takes its key from THREADSHELF_API_KEY',
    { timeout: 180_000, skip: fakeLlamaUnavailable() },
    async () => {
      const ctx = await startWithModels('threadshelf-local-api-env-key-', {
        THREADSHELF_API_KEY: 'env-key',
      });
      try {
        const { config } = await (await fetch(`${ctx.baseUrl}/api/generation/config`)).json();
        assert.strictEqual(config.localApi.apiKeySource, 'env');
        assert.strictEqual((await fetch(`${ctx.v1}/models`)).status, 401);
        const ok = await fetch(`${ctx.v1}/models`, { headers: { 'x-api-key': 'env-key' } });
        assert.strictEqual(ok.status, 200);
      } finally {
        await ctx.stop();
      }
    },
  );

  it(
    'can be turned off without affecting the app',
    { timeout: 180_000, skip: fakeLlamaUnavailable() },
    async () => {
      const ctx = await startWithModels('threadshelf-local-api-off-');
      try {
        await putConfig(ctx.baseUrl, { localApi: { enabled: false } });
        let response = await fetch(`${ctx.v1}/models`);
        assert.strictEqual(response.status, 403);
        assert.strictEqual((await response.json()).error.code, 'api_disabled');
        response = await post(`${ctx.v1}/messages`, { model: 'Alpha.Q4_K_M' });
        assert.strictEqual(response.status, 403);
        assert.strictEqual((await response.json()).error.type, 'permission_error');
        // The app's own API keeps working.
        response = await fetch(`${ctx.baseUrl}/api/generation/local-api`);
        assert.strictEqual(response.status, 200);

        await putConfig(ctx.baseUrl, { localApi: { enabled: true } });
        assert.strictEqual((await fetch(`${ctx.v1}/models`)).status, 200);
      } finally {
        await ctx.stop();
      }
    },
  );

  it(
    'reports the loaded model, swaps models on request and unloads on demand',
    { timeout: 180_000, skip: fakeLlamaUnavailable() },
    async () => {
      const ctx = await startWithModels('threadshelf-local-api-unload-');
      try {
        assert.deepStrictEqual(await loadedIds(ctx.v1), []);

        // Nothing loaded: unloading is a harmless no-op.
        let response = await post(`${ctx.v1}/models/unload`, {});
        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(await response.json(), { unloaded: false, model: null });

        assert.strictEqual((await chat(ctx.v1, 'Alpha.Q4_K_M')).status, 200);
        assert.deepStrictEqual(await loadedIds(ctx.v1), ['Alpha.Q4_K_M']);
        response = await fetch(`${ctx.v1}/models/Alpha.Q4_K_M`);
        assert.strictEqual((await response.json()).loaded, true);

        // Asking for another model replaces the one in memory.
        assert.strictEqual((await chat(ctx.v1, 'Beta.Q8_0')).status, 200);
        assert.deepStrictEqual(await loadedIds(ctx.v1), ['Beta.Q8_0']);

        // Naming a model that is not loaded leaves the loaded one alone.
        response = await post(`${ctx.v1}/models/unload`, { model: 'Alpha.Q4_K_M' });
        assert.deepStrictEqual(await response.json(), { unloaded: false, model: 'Beta.Q8_0' });
        assert.deepStrictEqual(await loadedIds(ctx.v1), ['Beta.Q8_0']);

        response = await post(`${ctx.v1}/models/unload`, { model: 'missing' });
        assert.strictEqual(response.status, 404);
        assert.strictEqual((await response.json()).error.code, 'model_not_found');

        response = await post(`${ctx.v1}/models/unload`, { model: 'beta.q8_0' });
        assert.deepStrictEqual(await response.json(), { unloaded: true, model: 'Beta.Q8_0' });
        assert.deepStrictEqual(await loadedIds(ctx.v1), []);
        response = await fetch(`${ctx.baseUrl}/api/generation/runtime`);
        assert.strictEqual((await response.json()).runtime.state, 'stopped');

        // A body-less call unloads whatever is loaded; the next request reloads.
        assert.strictEqual((await chat(ctx.v1, 'Alpha.Q4_K_M')).status, 200);
        response = await fetch(`${ctx.v1}/models/unload`, { method: 'POST' });
        assert.deepStrictEqual(await response.json(), { unloaded: true, model: 'Alpha.Q4_K_M' });
        assert.strictEqual((await chat(ctx.v1, 'Alpha.Q4_K_M')).status, 200);
        assert.deepStrictEqual(await loadedIds(ctx.v1), ['Alpha.Q4_K_M']);

        // Unload is a POST; GET reaches the model lookup and finds no such model.
        response = await fetch(`${ctx.v1}/models/unload`);
        assert.strictEqual(response.status, 404);
      } finally {
        await ctx.stop();
      }
    },
  );

  it(
    'unloads the model after the configured idle time',
    { timeout: 180_000, skip: fakeLlamaUnavailable() },
    async () => {
      // One "minute" lasts 300 ms here.
      const ctx = await startWithModels('threadshelf-local-api-idle-', {
        THREADSHELF_IDLE_MINUTE_MS: '300',
      });
      try {
        // Default: the model stays loaded.
        assert.strictEqual((await chat(ctx.v1, 'Alpha.Q4_K_M')).status, 200);
        await new Promise((resolve) => setTimeout(resolve, 900));
        assert.deepStrictEqual(await loadedIds(ctx.v1), ['Alpha.Q4_K_M']);

        // Turning the timeout on arms it for the model already in memory.
        await putConfig(ctx.baseUrl, { llamaCpp: { idleUnloadMinutes: 1 } });
        await waitFor(
          async () => (await loadedIds(ctx.v1)).length === 0,
          'model was not unloaded after the idle timeout',
        );

        // Requests keep resetting the timer; it unloads only after the last one.
        assert.strictEqual((await chat(ctx.v1, 'Alpha.Q4_K_M')).status, 200);
        await putConfig(ctx.baseUrl, { llamaCpp: { idleUnloadMinutes: 5 } });
        for (let index = 0; index < 4; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          assert.strictEqual((await chat(ctx.v1, 'Alpha.Q4_K_M')).status, 200);
          assert.deepStrictEqual(await loadedIds(ctx.v1), ['Alpha.Q4_K_M']);
        }
        await waitFor(
          async () => (await loadedIds(ctx.v1)).length === 0,
          'model was not unloaded after the last request went idle',
        );
        const logs = await (await fetch(`${ctx.baseUrl}/api/generation/runtime/logs`)).json();
        assert.match(logs.logs, /Unloading after 5 min without requests/);
      } finally {
        await ctx.stop();
      }
    },
  );

  it(
    'serves only /v1 on the optional network port',
    { timeout: 180_000, skip: fakeLlamaUnavailable() },
    async () => {
      const ctx = await startWithModels('threadshelf-local-api-network-');
      const networkPort = await freePort();
      const network = `http://127.0.0.1:${networkPort}`;
      try {
        await assert.rejects(() => fetch(`${network}/v1/models`), 'off by default');

        let body = await putConfig(ctx.baseUrl, { localApi: { networkAccess: true, networkPort } });
        assert.strictEqual(body.config.localApi.networkAccess, true);
        let status = await (await fetch(`${ctx.baseUrl}/api/generation/local-api`)).json();
        assert.strictEqual(status.network.state, 'listening');
        assert.strictEqual(status.network.port, networkPort);
        for (const url of status.network.urls) {
          assert.match(url, new RegExp(`^http://[\\d.]+:${networkPort}/v1$`));
        }

        let response = await fetch(`${network}/v1/models`);
        assert.strictEqual(response.status, 200);
        assert.strictEqual((await chat(`${network}/v1`, 'Alpha.Q4_K_M')).status, 200);

        // The archive and the settings API are never served on this port.
        for (const path of ['/api/generation/config', '/api/health', '/', '/index.html']) {
          response = await fetch(`${network}${path}`);
          assert.strictEqual(response.status, 404, path);
        }

        // Without a key: IP addresses and this machine's name only, no cross-site pages.
        let raw = await rawGet(network, '/v1/models', { host: `192.168.7.7:${networkPort}` });
        assert.strictEqual(raw.status, 200);
        raw = await rawGet(network, '/v1/models', { host: `attacker.example:${networkPort}` });
        assert.strictEqual(raw.status, 403);
        raw = await rawGet(network, '/v1/models', {
          host: `192.168.7.7:${networkPort}`,
          origin: 'https://attacker.example',
        });
        assert.strictEqual(raw.status, 403);

        // With a key, the key decides, whatever name the client used.
        await putConfig(ctx.baseUrl, { localApi: { apiKey: 'lan-key' } });
        raw = await rawGet(network, '/v1/models', { host: `gpu-box.example:${networkPort}` });
        assert.strictEqual(raw.status, 401);
        raw = await rawGet(network, '/v1/models', {
          host: `gpu-box.example:${networkPort}`,
          authorization: 'Bearer lan-key',
        });
        assert.strictEqual(raw.status, 200);

        // The loopback port still refuses other machines' names.
        raw = await rawGet(ctx.baseUrl, '/v1/models', {
          host: `192.168.7.7:${new URL(ctx.baseUrl).port}`,
          authorization: 'Bearer lan-key',
        });
        assert.strictEqual(raw.status, 403);

        // Turning the API off stops the network port too; turning it back on restores it.
        await putConfig(ctx.baseUrl, { localApi: { enabled: false } });
        await assert.rejects(() => fetch(`${network}/v1/models`));
        await putConfig(ctx.baseUrl, { localApi: { enabled: true } });
        response = await fetch(`${network}/v1/models`, { headers: { 'x-api-key': 'lan-key' } });
        assert.strictEqual(response.status, 200);

        // A port that cannot be used is reported instead of failing the save.
        const mainPort = Number(new URL(ctx.baseUrl).port);
        body = await putConfig(ctx.baseUrl, { localApi: { networkPort: mainPort } });
        status = await (await fetch(`${ctx.baseUrl}/api/generation/local-api`)).json();
        assert.strictEqual(status.network.state, 'error');
        assert.match(status.network.error, /ThreadShelf's own port/);

        await putConfig(ctx.baseUrl, { localApi: { networkAccess: false, networkPort } });
        await assert.rejects(() => fetch(`${network}/v1/models`));
        status = await (await fetch(`${ctx.baseUrl}/api/generation/local-api`)).json();
        assert.deepStrictEqual(status.network, { state: 'off', urls: [] });
      } finally {
        await ctx.stop();
      }
    },
  );
});
