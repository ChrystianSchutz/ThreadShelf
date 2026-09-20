import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGgufMetadata } from '../src/generation/gguf-metadata.js';
import {
  gguf,
  kvFloat,
  kvIntArray,
  kvString,
  kvStringArray,
  kvU32,
  syntheticMtpModel,
  text,
  u32,
  u64,
} from './shared/gguf.js';

const root = await mkdtemp(join(tmpdir(), 'threadshelf-gguf-'));
after(() => rm(root, { recursive: true, force: true }));

const writeModel = async (name, bytes) => {
  const path = join(root, name);
  await writeFile(path, bytes);
  return path;
};

/** Resolves within a bounded time, so a hostile header cannot stall model discovery. */
const readWithin = async (path, milliseconds = 2_000) => {
  const startedAt = performance.now();
  const metadata = await readGgufMetadata(path);
  assert.ok(
    performance.now() - startedAt < milliseconds,
    `reading ${path} took longer than ${milliseconds} ms`,
  );
  return metadata;
};

describe('GGUF metadata reader', () => {
  it('detects an MTP/NextN head after a multi-megabyte tokenizer vocabulary', async () => {
    // ~200k tokens forces reads across several 1 MiB chunk boundaries.
    const vocabulary = Array.from({ length: 200_000 }, (_, index) => `token-${index}`);
    const path = await writeModel(
      'qwen-like.gguf',
      gguf([
        kvString('general.architecture', 'qwen35'),
        kvString('general.name', 'Synthetic Qwen'),
        kvFloat('general.sampling.temp', 1),
        kvU32('qwen35.block_count', 65),
        kvU32('qwen35.context_length', 262_144),
        kvIntArray('qwen35.rope.dimension_sections', [11, 11, 10, 0]),
        kvStringArray('tokenizer.ggml.tokens', vocabulary),
        kvString('tokenizer.chat_template', '{{ messages }}'.repeat(2_000)),
        kvU32('qwen35.nextn_predict_layers', 1),
      ]),
    );
    assert.deepEqual(await readGgufMetadata(path), {
      architecture: 'qwen35',
      name: 'Synthetic Qwen',
      contextLength: 262_144,
      blockCount: 65,
      nextnPredictLayers: 1,
    });
  });

  it('reports no MTP head and resolves keys that precede general.architecture', async () => {
    const path = await writeModel(
      'gemma-like.gguf',
      gguf([
        kvU32('gemma4.context_length', 131_072),
        kvString('general.architecture', 'gemma4'),
        kvU32('llama.nextn_predict_layers', 4),
      ]),
    );
    const metadata = await readGgufMetadata(path);
    assert.equal(metadata.architecture, 'gemma4');
    assert.equal(metadata.contextLength, 131_072);
    // A key from another architecture namespace must not enable MTP.
    assert.equal(metadata.nextnPredictLayers, 0);
  });

  it('returns null for missing, non-GGUF and truncated files', async () => {
    assert.equal(await readGgufMetadata(join(root, 'missing.gguf')), null);
    assert.equal(await readGgufMetadata(await writeModel('text.gguf', 'not a model')), null);
    const complete = gguf([
      kvString('general.architecture', 'qwen35'),
      kvStringArray('tokenizer.ggml.tokens', ['a', 'b', 'c']),
      kvU32('qwen35.nextn_predict_layers', 1),
    ]);
    const truncated = await writeModel('truncated.gguf', complete.subarray(0, complete.length - 6));
    assert.equal(await readGgufMetadata(truncated), null);
  });

  it('caches metadata per file version and re-reads after an mtime or size change', async () => {
    const path = await writeModel('cached.gguf', syntheticMtpModel(1));
    const firstTime = new Date('2026-01-01T00:00:00Z');
    const secondTime = new Date('2026-02-01T00:00:00Z');
    await utimes(path, firstTime, firstTime);
    assert.equal((await readGgufMetadata(path)).nextnPredictLayers, 1);

    // Same size and mtime, different bytes: a cached read must not open the file.
    const withoutHead = syntheticMtpModel(0);
    assert.equal(withoutHead.length, syntheticMtpModel(1).length);
    await writeFile(path, withoutHead);
    await utimes(path, firstTime, firstTime);
    assert.equal((await readGgufMetadata(path)).nextnPredictLayers, 1);

    await utimes(path, secondTime, secondTime);
    assert.equal((await readGgufMetadata(path)).nextnPredictLayers, 0, 'mtime change re-reads');

    // Trailing bytes change only the size; the header parses the same way.
    await writeFile(path, Buffer.concat([syntheticMtpModel(1), Buffer.alloc(32)]));
    await utimes(path, secondTime, secondTime);
    assert.equal((await readGgufMetadata(path)).nextnPredictLayers, 1, 'size change re-reads');
  });

  describe('hostile headers', () => {
    it('rejects a declared key/value count above the limit', async () => {
      const path = await writeModel(
        'too-many-keys.gguf',
        gguf([kvString('general.architecture', 'qwen35')], { kvCount: 100_001 }),
      );
      assert.equal(await readWithin(path), null);
    });

    it('rejects strings declared longer than 64 MiB without allocating them', async () => {
      const longValue = Buffer.concat([
        text('general.architecture'),
        u32(8),
        u64(64 * 1024 * 1024 + 1),
        Buffer.from('qwen35'),
      ]);
      assert.equal(await readWithin(await writeModel('long-value.gguf', gguf([longValue]))), null);
      const longKey = Buffer.concat([u64(Number.MAX_SAFE_INTEGER), Buffer.from('key')]);
      assert.equal(await readWithin(await writeModel('long-key.gguf', gguf([longKey]))), null);
    });

    it('rejects a nested array of arrays', async () => {
      const nested = Buffer.concat([text('tokenizer.nested'), u32(9), u32(9), u64(2)]);
      const path = await writeModel(
        'nested-array.gguf',
        gguf([nested, kvString('general.architecture', 'qwen35')]),
      );
      assert.equal(await readWithin(path), null);
    });

    it('rejects GGUF v1 and huge element counts in a tiny file', async () => {
      const v1 = gguf([kvString('general.architecture', 'qwen35')], { version: 1 });
      assert.equal(await readWithin(await writeModel('v1.gguf', v1)), null);
      const hugeStringArray = Buffer.concat([
        text('tokenizer.ggml.tokens'),
        u32(9),
        u32(8),
        u64(Number.MAX_SAFE_INTEGER),
        text('a'),
      ]);
      assert.equal(
        await readWithin(await writeModel('huge-array.gguf', gguf([hugeStringArray]))),
        null,
      );
      const hugeScalarArray = Buffer.concat([
        text('qwen35.rope.dimension_sections'),
        u32(9),
        u32(12),
        u64(Number.MAX_SAFE_INTEGER),
      ]);
      assert.equal(
        await readWithin(await writeModel('huge-scalars.gguf', gguf([hugeScalarArray]))),
        null,
      );
    });
  });
});
