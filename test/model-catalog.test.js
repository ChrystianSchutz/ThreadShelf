import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  assertRepoId,
  catalogFileUrl,
  clearCatalogCacheForTests,
  getCatalogModel,
  groupCatalogQuants,
  parseGgufFileName,
  quantQualityTier,
  searchCatalogModels,
} from '../src/generation/model-catalog.js';
import { modelFolderName, planModelDownload } from '../src/generation/model-download.js';
import { judgeFit } from '../src/generation/hardware.js';

const lfs = (oid, size) => ({ oid, size });

const treeEntry = (path, size, oid) => ({
  type: 'file',
  path,
  size,
  lfs: lfs(oid ?? 'a'.repeat(64), size),
});

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => body,
});

beforeEach(() => clearCatalogCacheForTests());

describe('catalog file naming', () => {
  it('extracts quantisation labels from the common file name shapes', () => {
    assert.strictEqual(parseGgufFileName('Qwen3.5-4B-Q4_K_M.gguf').label, 'Q4_K_M');
    assert.strictEqual(parseGgufFileName('Qwen3.5-4B-IQ4_XS.gguf').label, 'IQ4_XS');
    assert.strictEqual(parseGgufFileName('Qwen3.5-4B-UD-Q4_K_XL.gguf').label, 'UD-Q4_K_XL');
    assert.strictEqual(parseGgufFileName('Qwen3.5-4B-BF16.gguf').label, 'BF16');
    assert.strictEqual(parseGgufFileName('gpt-oss-20b-MXFP4_MOE.gguf').label, 'MXFP4_MOE');
  });

  it('reads the shard index and strips it from the label', () => {
    const parsed = parseGgufFileName('Model-Q4_K_M-00001-of-00003.gguf');
    assert.strictEqual(parsed.label, 'Q4_K_M');
    assert.strictEqual(parsed.shardIndex, 1);
    assert.strictEqual(parsed.shardTotal, 3);
  });

  it('falls back to the containing folder when the file name carries no quant', () => {
    assert.strictEqual(parseGgufFileName('Q4_K_M/model-00001-of-00002.gguf').label, 'Q4_K_M');
  });
});

describe('catalog quant grouping', () => {
  it('groups shards into one downloadable quantisation and totals their size', () => {
    const { quants } = groupCatalogQuants([
      treeEntry('Model-Q4_K_M-00001-of-00002.gguf', 100, 'b'.repeat(64)),
      treeEntry('Model-Q4_K_M-00002-of-00002.gguf', 150, 'c'.repeat(64)),
      treeEntry('Model-Q8_0.gguf', 400, 'd'.repeat(64)),
    ]);

    const sharded = quants.find((quant) => quant.label === 'Q4_K_M');
    assert.strictEqual(sharded.shards, 2);
    assert.strictEqual(sharded.totalBytes, 250);
    // A sharded model is only usable if every shard is fetched.
    assert.deepStrictEqual(
      sharded.files.map((file) => file.path),
      ['Model-Q4_K_M-00001-of-00002.gguf', 'Model-Q4_K_M-00002-of-00002.gguf'],
    );
  });

  it('separates multimodal projectors from the quantisation list', () => {
    const { quants, projectors } = groupCatalogQuants([
      treeEntry('Model-Q4_K_M.gguf', 100),
      treeEntry('mmproj-F16.gguf', 20),
    ]);
    assert.deepStrictEqual(
      quants.map((quant) => quant.label),
      ['Q4_K_M'],
    );
    assert.deepStrictEqual(
      projectors.map((file) => file.path),
      ['mmproj-F16.gguf'],
    );
  });

  it('exposes the LFS oid as the verifiable SHA-256 and ignores a malformed one', () => {
    const { quants } = groupCatalogQuants([
      treeEntry('Model-Q4_K_M.gguf', 100, 'e'.repeat(64)),
      { type: 'file', path: 'Model-Q8_0.gguf', size: 10, lfs: lfs('not-a-hash', 10) },
    ]);
    assert.strictEqual(quants.find((q) => q.label === 'Q4_K_M').files[0].sha256, 'e'.repeat(64));
    assert.strictEqual(quants.find((q) => q.label === 'Q8_0').files[0].sha256, undefined);
  });

  it('marks a sensible default quantisation as recommended', () => {
    const { quants } = groupCatalogQuants([
      treeEntry('Model-BF16.gguf', 8000),
      treeEntry('Model-Q4_K_M.gguf', 2500),
      treeEntry('Model-Q8_0.gguf', 4000),
    ]);
    assert.strictEqual(quants.find((quant) => quant.recommended).label, 'Q4_K_M');
  });
});

describe('quantisation quality ranking', () => {
  it('ranks modern K-quants above same-sized legacy ones', () => {
    // Q4_1 and Q4_K_M take comparable space; only the K-quant is worth picking.
    assert.ok(quantQualityTier('Q4_K_M') > quantQualityTier('Q4_1'));
    assert.ok(quantQualityTier('UD-Q4_K_XL') > quantQualityTier('Q4_0'));
    assert.ok(quantQualityTier('IQ4_XS') > quantQualityTier('Q5_1'));
  });

  it('does not mistake Q8_0 for a legacy quantisation', () => {
    // `Q8_0` shares the `Q<digit>_<0|1>` shape with the legacy family but is the
    // highest-quality common quantisation and must stay selectable.
    assert.ok(quantQualityTier('Q8_0') > quantQualityTier('Q6_K'));
    assert.ok(quantQualityTier('Q6_K') > quantQualityTier('Q4_K_M'));
  });

  it('never auto-selects full-precision weights', () => {
    for (const label of ['BF16', 'F16', 'F32', 'FP16']) {
      assert.strictEqual(quantQualityTier(label), 0, label);
    }
  });
});

describe('catalog input safety', () => {
  it('rejects ids that are not a plain owner/name pair', () => {
    assert.strictEqual(assertRepoId('unsloth/Qwen3.5-4B-GGUF'), 'unsloth/Qwen3.5-4B-GGUF');
    for (const bad of ['../../etc', 'no-slash', 'a/b/c', 'owner/..', '/leading', 'x'.repeat(300)]) {
      assert.throws(() => assertRepoId(bad), /Invalid model id/, `expected rejection for ${bad}`);
    }
  });

  it('builds an encoded download URL on the Hugging Face origin', () => {
    const url = new URL(catalogFileUrl('unsloth/Qwen3.5-4B-GGUF', 'Qwen3.5-4B-Q4_K_M.gguf'));
    assert.strictEqual(url.origin, 'https://huggingface.co');
    assert.strictEqual(
      url.pathname,
      '/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf',
    );
  });

  it('flattens a repository id into a safe folder name', () => {
    assert.strictEqual(modelFolderName('unsloth/Qwen3.5-4B-GGUF'), 'unsloth__Qwen3.5-4B-GGUF');
  });
});

describe('catalog search and detail', () => {
  it('surfaces popularity and gating without needing a token', async () => {
    const fetchImpl = async (url) => {
      const href = String(url);
      assert.ok(href.includes('filter=gguf'));
      assert.ok(href.includes('sort=downloads'));
      // Without an explicit expand the Hub omits `gated` from list responses and
      // the browser would never warn that a repository needs a login.
      assert.ok(href.includes('expand%5B%5D=gated') || href.includes('expand[]=gated'));
      assert.ok(href.includes('downloads') && href.includes('likes'));
      return jsonResponse([
        { id: 'unsloth/Qwen3.5-4B-GGUF', downloads: 12_364_836, likes: 915, gated: false },
        { id: 'meta-llama/Llama-3.1-8B-Instruct', downloads: 500, likes: 10, gated: 'manual' },
      ]);
    };

    const { models } = await searchCatalogModels({ fetchImpl });
    assert.strictEqual(models[0].id, 'unsloth/Qwen3.5-4B-GGUF');
    assert.strictEqual(models[0].downloads, 12_364_836);
    assert.strictEqual(models[0].trustedPublisher, true);
    // Gating is known before any download is attempted, so the UI can say so.
    assert.strictEqual(models[1].gated, 'manual');
    assert.strictEqual(models[1].trustedPublisher, false);
  });

  it('plans a download whose files stay inside the target directory', async () => {
    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.includes('/tree/main')) {
        return jsonResponse([
          treeEntry('Qwen3.5-4B-Q4_K_M.gguf', 2_500_000, 'a'.repeat(64)),
          treeEntry('mmproj-F16.gguf', 500_000, 'b'.repeat(64)),
        ]);
      }
      return jsonResponse({
        id: 'unsloth/Qwen3.5-4B-GGUF',
        downloads: 1,
        gated: false,
        gguf: { context_length: 262_144, architecture: 'qwen35' },
      });
    };

    const detail = await getCatalogModel('unsloth/Qwen3.5-4B-GGUF', fetchImpl);
    assert.strictEqual(detail.contextLength, 262_144);

    const plan = await planModelDownload({
      repoId: 'unsloth/Qwen3.5-4B-GGUF',
      quant: 'Q4_K_M',
      directory: '/tmp/threadshelf-models',
      detail,
    });
    assert.strictEqual(plan.files.length, 1);
    assert.strictEqual(plan.files[0].sha256, 'a'.repeat(64));
    assert.ok(plan.primaryPath.includes('unsloth__Qwen3.5-4B-GGUF'));
    assert.strictEqual(plan.requiresToken, false);
  });

  it('reports that a gated repository needs a token before downloading', async () => {
    const fetchImpl = async (url) =>
      String(url).includes('/tree/main')
        ? jsonResponse([treeEntry('Llama-Q4_K_M.gguf', 100)])
        : jsonResponse({ id: 'meta-llama/Llama-3.1-8B-GGUF', gated: 'manual' });

    const plan = await planModelDownload({
      repoId: 'meta-llama/Llama-3.1-8B-GGUF',
      quant: 'Q4_K_M',
      directory: '/tmp/threadshelf-models',
      detail: await getCatalogModel('meta-llama/Llama-3.1-8B-GGUF', fetchImpl),
    });
    assert.strictEqual(plan.gated, 'manual');
    assert.strictEqual(plan.requiresToken, true);
  });
});

describe('memory fit', () => {
  const profile = {
    devices: [],
    detectionSource: 'llama.cpp',
    totalRamBytes: 32 * 1024 ** 3,
    freeRamBytes: 16 * 1024 ** 3,
    vramBudgetBytes: 10 * 1024 ** 3,
    modelBudgetBytes: 10 * 1024 ** 3,
    suggestedVariant: 'cuda',
  };

  it('separates a model that fits in VRAM from one that only fits in RAM', () => {
    assert.strictEqual(judgeFit(6 * 1024 ** 3, profile), 'fits');
    assert.strictEqual(judgeFit(15 * 1024 ** 3, profile), 'tight');
    assert.strictEqual(judgeFit(200 * 1024 ** 3, profile), 'too-large');
  });
});
