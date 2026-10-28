import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  resolveVisionProjector,
  assertInlineImageInputs,
  configuredVisionProjector,
  hasVisionProjector,
} from '../src/generation/vision.js';
import { discoverGgufModels, isProjectorFileName } from '../src/generation/model-discovery.js';
import { getGenerationConfig, updateGenerationConfig } from '../src/generation/config.js';
import { downloadModel } from '../src/generation/model-download.js';

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=';
const message = (url = png) => ({
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Read it' },
        { type: 'image_url', image_url: { url } },
      ],
    },
  ],
});
const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

describe('vision projector selection and local image boundary', () => {
  it('selects a unique sibling, never guesses between models or projectors, and accepts an explicit mapping', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-vision-'));
    try {
      const model = join(root, 'model.gguf');
      const projector = join(root, 'mmproj-model.gguf');
      await writeFile(model, 'model');
      assert.equal(await resolveVisionProjector(model, [root]), undefined);
      await writeFile(projector, 'projector');
      assert.equal(await resolveVisionProjector(model, [root]), await realpath(projector));
      await writeFile(join(root, 'mmproj-other.gguf'), 'other');
      assert.equal(await resolveVisionProjector(model, [root]), undefined);
      assert.equal(
        await resolveVisionProjector(model, [root], { [model]: projector }),
        await realpath(projector),
      );
      await rm(join(root, 'mmproj-other.gguf'));
      await writeFile(join(root, 'second-model.gguf'), 'second');
      assert.equal(await resolveVisionProjector(model, [root]), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects configured projectors outside model roots, including directory junction escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-vision-root-'));
    const other = await mkdtemp(join(tmpdir(), 'threadshelf-vision-outside-'));
    try {
      const model = join(root, 'model.gguf');
      const projector = join(other, 'mmproj.gguf');
      await writeFile(model, 'model');
      await writeFile(projector, 'projector');
      await assert.rejects(
        resolveVisionProjector(model, [root], { [model]: projector }),
        /outside/,
      );
      await symlink(other, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(
        resolveVisionProjector(model, [root], { [model]: join(root, 'escape', 'mmproj.gguf') }),
        /outside/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });

  it('persists normalized per-model mappings, preserves them on unrelated updates and clears explicitly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-vision-config-'));
    try {
      process.env.GENERATION_CONFIG_PATH = join(root, 'config.json');
      const mappings = { [join(root, 'model.gguf')]: join(root, 'mmproj.gguf') };
      assert.deepEqual(
        (await updateGenerationConfig({ llamaCpp: { projectorPaths: mappings } })).llamaCpp
          .projectorPaths,
        mappings,
      );
      await updateGenerationConfig({ llamaCpp: { contextSize: 16384 } });
      assert.deepEqual((await getGenerationConfig()).llamaCpp.projectorPaths, mappings);
      await assert.rejects(
        updateGenerationConfig({ llamaCpp: { projectorPaths: { model: 'https://bad/image' } } }),
      );
      await updateGenerationConfig({ llamaCpp: { projectorPaths: {} } });
      assert.deepEqual((await getGenerationConfig()).llamaCpp.projectorPaths, {});
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts OpenAI Chat, Responses and Anthropic inline image blocks', () => {
    assert.equal(assertInlineImageInputs(message()), 1);
    assert.equal(
      assertInlineImageInputs({
        input: [{ role: 'user', content: [{ type: 'input_image', image_url: png }] }],
      }),
      1,
    );
    assert.equal(
      assertInlineImageInputs({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: png.split(',')[1] },
              },
            ],
          },
        ],
      }),
      1,
    );
    assert.equal(
      assertInlineImageInputs({ messages: [{ role: 'user', content: 'Text only' }] }),
      0,
    );
  });

  it('rejects remote and filesystem URLs, forged formats and excessive image counts', () => {
    for (const url of [
      'https://example.com/a.png',
      'http://127.0.0.1/private',
      'file:///private/a.png',
      'data:image/svg+xml;base64,PHN2Zz4=',
      'data:image/png;base64,YmFk',
      png.replace('png', 'jpeg'),
    ]) {
      assert.throws(() => assertInlineImageInputs(message(url)));
    }
    assert.throws(
      () =>
        assertInlineImageInputs({
          messages: Array.from({ length: 5 }, () => message().messages[0]),
        }),
      /four images/,
    );
  });

  it('recognises projector companions by name, wherever mmproj appears as a token', () => {
    for (const name of [
      'mmproj-model-f16.gguf',
      'model-mmproj-f16.gguf',
      'Model.MMPROJ.Q8_0.gguf',
      'model_mmproj.gguf',
    ]) {
      assert.equal(isProjectorFileName(name), true, name);
    }
    for (const name of ['model-f16.gguf', 'mmprojection-model.gguf', 'summproj.gguf']) {
      assert.equal(isProjectorFileName(name), false, name);
    }
  });

  it('never lists a suffix-named projector as a chat model and still pairs it with its model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-vision-suffix-'));
    try {
      await writeFile(join(root, 'glimmer-q4.gguf'), 'x');
      await writeFile(join(root, 'glimmer-mmproj-f16.gguf'), 'x');
      const models = await discoverGgufModels([root]);
      assert.deepEqual(
        models.map((model) => model.name),
        ['glimmer-q4'],
      );
      assert.equal(
        await resolveVisionProjector(join(root, 'glimmer-q4.gguf'), [root]),
        await realpath(join(root, 'glimmer-mmproj-f16.gguf')),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not hand a folder projector to a drafter or a later shard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-vision-drafter-'));
    try {
      await writeFile(join(root, 'main-00001-of-00002.gguf'), 'x');
      await writeFile(join(root, 'main-00002-of-00002.gguf'), 'x');
      await writeFile(join(root, 'dflash-main.gguf'), 'x');
      await writeFile(join(root, 'mmproj-main.gguf'), 'x');
      assert.equal(
        await resolveVisionProjector(join(root, 'main-00001-of-00002.gguf'), [root]),
        await realpath(join(root, 'mmproj-main.gguf')),
      );
      assert.equal(await resolveVisionProjector(join(root, 'dflash-main.gguf'), [root]), undefined);
      assert.equal(
        await resolveVisionProjector(join(root, 'main-00002-of-00002.gguf'), [root]),
        undefined,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('maps a downloaded projector explicitly, so older variants in the folder keep vision on', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-vision-download-'));
    try {
      process.env.GENERATION_CONFIG_PATH = join(root, 'config.json');
      const model = join(root, 'Vision-Q4_K_M.gguf');
      const projector = join(root, 'mmproj-F16.gguf');
      // Left over from an earlier download that fetched every variant.
      await writeFile(join(root, 'mmproj-F32.gguf'), 'old');
      await writeFile(model, 'model');
      await writeFile(projector, 'proj');
      assert.equal(await hasVisionProjector(model, [root]), false);
      const file = (destination, size) => ({
        url: 'https://huggingface.co/unused',
        repoPath: basename(destination),
        destination,
        sizeBytes: size,
      });
      // Both files are already present, so nothing is fetched.
      await downloadModel({
        repoId: 'someone/Vision-GGUF',
        quant: 'Q4_K_M',
        files: [file(model, 5), file(projector, 4)],
        totalBytes: 9,
        directory: root,
        primaryPath: model,
        gated: false,
        requiresToken: false,
      });
      const { projectorPaths } = (await getGenerationConfig()).llamaCpp;
      assert.equal(projectorPaths[model], projector);
      assert.equal(await hasVisionProjector(model, [root], projectorPaths), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('matches explicit mappings case-insensitively only on Windows', () => {
    const mapping = { [join(tmpdir(), 'Models', 'A.gguf')]: 'projector.gguf' };
    const other = join(tmpdir(), 'models', 'a.gguf');
    assert.equal(configuredVisionProjector([other], mapping, 'win32'), 'projector.gguf');
    if (process.platform !== 'win32') {
      assert.equal(configuredVisionProjector([other], mapping, 'linux'), undefined);
    }
  });

  it('reports a missing mapped projector at launch but treats it as no vision in listings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-vision-missing-'));
    try {
      const model = join(root, 'model.gguf');
      await writeFile(model, 'x');
      const mapping = { [model]: join(root, 'gone-mmproj.gguf') };
      await assert.rejects(resolveVisionProjector(model, [root], mapping), /was not found/);
      assert.equal(await hasVisionProjector(model, [root], mapping), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts JPEG, jpg, GIF and string image_url parts, and checks the declared type', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString('base64');
    const gif = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1').toString('base64');
    assert.equal(assertInlineImageInputs(message(`data:image/jpeg;base64,${jpeg}`)), 1);
    assert.equal(assertInlineImageInputs(message(`data:image/jpg;base64,${jpeg}`)), 1);
    assert.equal(assertInlineImageInputs(message(`data:image/gif;base64,${gif}`)), 1);
    assert.equal(
      assertInlineImageInputs({
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: png }] }],
      }),
      1,
    );
    assert.throws(
      () => assertInlineImageInputs(message(`data:image/gif;base64,${jpeg}`)),
      /not a valid image\/gif/,
    );
  });

  it('rejects oversized images before decoding and malformed Anthropic sources', () => {
    const huge = `data:image/png;base64,${'A'.repeat(Math.ceil((8 * 1024 * 1024) / 3) * 4 + 4)}`;
    assert.throws(() => assertInlineImageInputs(message(huge)), /exceeds 8 MiB/);
    const anthropic = (source) => ({
      messages: [{ role: 'user', content: [{ type: 'image', source }] }],
    });
    assert.throws(
      () => assertInlineImageInputs(anthropic({ type: 'url', url: 'https://example.com/a.png' })),
      /base64 source/,
    );
    assert.throws(
      () => assertInlineImageInputs(anthropic({ type: 'base64', media_type: 'image/png' })),
      /string media_type and base64 data/,
    );
  });
});
