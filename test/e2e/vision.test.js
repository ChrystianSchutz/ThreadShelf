import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer } from './helpers.js';
import { createFakeLlamaServer, fakeLlamaUnavailable } from '../shared/fake-llama.js';
import { syntheticMtpModel } from '../shared/gguf.js';

it(
  'vision API loads the exact projector, preserves image blocks, rejects remote inputs before loading',
  { timeout: 180000, skip: fakeLlamaUnavailable() },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-vision-e2e-'));
    const executable = await createFakeLlamaServer(join(root, 'bin'));
    const models = join(root, 'models');
    await mkdir(models);
    const model = join(models, 'visual-model.gguf');
    const projector = join(models, 'mmproj-visual.gguf');
    await writeFile(model, syntheticMtpModel(0));
    await writeFile(projector, syntheticMtpModel(0));
    const argv = join(root, 'argv.jsonl');
    const ctx = await startApiServer({
      prefix: 'threadshelf-vision-',
      env: {
        LLAMA_CPP_SERVER: executable,
        THREADSHELF_MODELS_PATH: models,
        FAKE_LLAMA_ARGV_LOG: argv,
      },
    });
    const post = (url) =>
      fetch(`${ctx.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'visual-model',
          stream: false,
          messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }],
        }),
      });
    try {
      const catalog = await fetch(`${ctx.baseUrl}/v1/models`).then((r) => r.json());
      assert.equal(catalog.data.length, 1);
      assert.equal(catalog.data[0].vision, true);
      assert.equal((await post('http://127.0.0.1/private.png')).status, 400);
      assert.equal((await readFile(argv, 'utf8').catch(() => '')).includes('--model'), false);
      const png =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=';
      const result = await post(png);
      assert.equal(result.status, 200, await result.clone().text());
      assert.equal((await result.json()).messages[0].content[0].image_url.url, png);
      const launches = (await readFile(argv, 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse)
        .filter((args) => args.includes('--model'));
      assert.equal(launches.length, 1);
      assert.equal(launches[0][launches[0].indexOf('--mmproj') + 1], projector);
    } finally {
      await ctx.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it(
  'an older llama-server without --mmproj is not advertised as vision-capable and refuses images before loading',
  { timeout: 180000, skip: fakeLlamaUnavailable() },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-vision-old-e2e-'));
    const executable = await createFakeLlamaServer(join(root, 'bin'));
    const models = join(root, 'models');
    await mkdir(models);
    await writeFile(join(models, 'visual-model.gguf'), syntheticMtpModel(0));
    await writeFile(join(models, 'mmproj-visual.gguf'), syntheticMtpModel(0));
    const argv = join(root, 'argv.jsonl');
    const ctx = await startApiServer({
      prefix: 'threadshelf-vision-old-',
      env: {
        LLAMA_CPP_SERVER: executable,
        THREADSHELF_MODELS_PATH: models,
        FAKE_LLAMA_ARGV_LOG: argv,
        FAKE_LLAMA_NO_MMPROJ: '1',
      },
    });
    try {
      const catalog = await fetch(`${ctx.baseUrl}/v1/models`).then((r) => r.json());
      assert.equal(catalog.data[0].vision, false);
      const response = await fetch(`${ctx.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'visual-model',
          stream: false,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=',
                  },
                },
              ],
            },
          ],
        }),
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error.message, /--mmproj/);
      assert.equal((await readFile(argv, 'utf8').catch(() => '')).includes('--model'), false);
    } finally {
      await ctx.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);
