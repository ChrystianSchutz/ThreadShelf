import { describe, it } from 'node:test';
import assert from 'node:assert';
import { request } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer } from './helpers.js';
import { createFakeLlamaServer, fakeLlamaUnavailable } from '../shared/fake-llama.js';
import { syntheticMtpModel } from '../shared/gguf.js';

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

describe('local model API (/v1) E2E', () => {
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
});
