import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createEmbedder, embed, getDimension } from '../src/embedding.js';

describe('embedding lightweight behavior', () => {
  it('exposes the configured vector dimension', () => {
    assert.strictEqual(getDimension(), 384);
  });

  it('returns immediately for an empty batch without loading a model', async () => {
    assert.deepStrictEqual(await embed([]), []);
  });

  it('shares one model load between concurrent calls and retries after a failed load', async () => {
    let loads = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const pipe = async (texts) => ({
      data: Float32Array.from((Array.isArray(texts) ? texts : [texts]).flatMap(() => [1, 0])),
      dims: [Array.isArray(texts) ? texts.length : 1, 2],
    });
    const embedder = createEmbedder(async () => {
      loads++;
      if (loads === 1) throw new Error('synthetic load failure');
      await gate;
      return pipe;
    });

    await assert.rejects(embedder(['first']), /synthetic load failure/);
    const pending = [embedder(['a']), embedder(['b', 'c']), embedder(['d'])];
    release();
    const results = await Promise.all(pending);
    assert.strictEqual(loads, 2);
    assert.deepStrictEqual(results[1], [
      [1, 0],
      [1, 0],
    ]);
  });
});
