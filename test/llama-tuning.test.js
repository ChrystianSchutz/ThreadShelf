import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLlamaRuntimeCapabilities } from '../src/generation/llama-process.js';
import { formatLlamaTuning, resolveLlamaTuning } from '../src/generation/llama-profile.js';
import {
  getGenerationConfig,
  llamaCppConfigChanged,
  updateGenerationConfig,
} from '../src/generation/config.js';
import { managedLlamaBuild } from '../src/generation/llama-install.js';

// Excerpt shaped like `llama-server --help` from build b10809.
const modernHelp = parseLlamaRuntimeCapabilities(
  [
    '-ctk,  --cache-type-k TYPE              KV cache data type for K',
    '-fa,   --flash-attn [on|off|auto]       set Flash Attention use',
    '-fit,  --fit [on|off]                   whether to adjust unset arguments',
    '--spec-type none,draft-simple,draft-eagle3,draft-mtp,draft-dflash,ngram-simple',
    '-np,   --parallel N                     number of server slots (default: -1, -1 = auto)',
    "-rea,  --reasoning [on|off|auto]        Use reasoning/thinking in the chat ('on', 'off')",
    '--reasoning-effort LEVEL                reasoning effort level given to the chat template',
  ].join('\n'),
);
const legacyHelp = parseLlamaRuntimeCapabilities('--n-gpu-layers N\n--flash-attn\n');

const balanced = {
  modelDirectories: [],
  defaultModelDirectories: [],
  downloadDirectory: '',
  contextSize: 65_536,
  acceleration: 'auto',
  gpuLayers: 20,
  splitMode: 'layer',
  mainGpu: 0,
  threads: -1,
  flashAttention: 'auto',
  kvCache: 'quality',
  speculative: 'auto',
  reasoningEffort: 'medium',
};
const qwen = {
  architecture: 'qwen35',
  contextLength: 262_144,
  blockCount: 65,
  nextnPredictLayers: 1,
};
const entry = (tuning, setting) =>
  tuning.entries.find((candidate) => candidate.setting === setting);

describe('llama.cpp runtime tuning', () => {
  it('parses tuning capabilities from llama-server --help', () => {
    assert.equal(modernHelp.kvCacheTypes, true);
    assert.ok(modernHelp.speculativeTypes.includes('draft-mtp'));
    assert.equal(modernHelp.parallelSlots, true);
    assert.equal(modernHelp.reasoningEffort, true);
    assert.equal(modernHelp.reasoningToggle, true);
  });

  it('builds the balanced Qwen profile on a runtime and model that support it', () => {
    const tuning = resolveLlamaTuning(balanced, modernHelp, qwen);
    assert.deepEqual(tuning.args, [
      '--cache-type-k',
      'q8_0',
      '--cache-type-v',
      'q8_0',
      '--spec-type',
      'draft-mtp',
      '--spec-draft-n-max',
      '2',
      '--reasoning-effort',
      'medium',
      '--parallel',
      '1',
    ]);
    assert.equal(tuning.flashAttention, 'on');
    assert.equal(entry(tuning, 'FA').source, 'threadshelf');
    assert.match(
      formatLlamaTuning(tuning.entries),
      /ctx 64K \(settings\) · FA on \(threadshelf: required by the quantized KV cache\) · KV q8_0×q8_0 \(settings\) · MTP 2 \(settings: 1 NextN layer\(s\) in the GGUF\)/,
    );
  });

  it('keeps MTP off for a model without an MTP head or unreadable metadata', () => {
    const plain = resolveLlamaTuning(balanced, modernHelp, { ...qwen, nextnPredictLayers: 0 });
    assert.ok(!plain.args.includes('--spec-type'));
    assert.deepEqual(
      { value: entry(plain, 'MTP').value, source: entry(plain, 'MTP').source },
      { value: 'off', source: 'model' },
    );
    const unknown = resolveLlamaTuning(balanced, modernHelp, null);
    assert.ok(!unknown.args.includes('--spec-type'));
    assert.equal(entry(unknown, 'MTP').applied, false);
  });

  it('never quantizes the KV cache when Flash Attention is explicitly off', () => {
    const tuning = resolveLlamaTuning({ ...balanced, flashAttention: 'off' }, modernHelp, qwen);
    assert.ok(!tuning.args.includes('--cache-type-k'));
    assert.equal(tuning.flashAttention, 'off');
    assert.equal(entry(tuning, 'KV').applied, false);
  });

  it('degrades to no tuning flags on an older llama-server', () => {
    const tuning = resolveLlamaTuning(balanced, legacyHelp, qwen);
    assert.deepEqual(tuning.args, []);
    assert.equal(tuning.flashAttention, 'auto');
    for (const setting of ['KV', 'MTP', 'reasoning']) {
      assert.equal(entry(tuning, setting).applied, false, setting);
    }
  });

  it('maps memory saver, aggressive MTP and reasoning off', () => {
    const tuning = resolveLlamaTuning(
      { ...balanced, kvCache: 'memory', speculative: 'aggressive', reasoningEffort: 'off' },
      modernHelp,
      qwen,
    );
    const args = tuning.args.join(' ');
    assert.match(args, /--cache-type-k q4_0 --cache-type-v q4_0/);
    assert.match(args, /--spec-draft-n-max 3/);
    assert.match(args, /--reasoning off/);
    assert.ok(!args.includes('--reasoning-effort'));
    const defaults = resolveLlamaTuning(
      { ...balanced, kvCache: 'default', speculative: 'off', reasoningEffort: 'default' },
      modernHelp,
      qwen,
    );
    assert.deepEqual(defaults.args, ['--parallel', '1']);
    assert.equal(defaults.flashAttention, 'auto');
  });

  it('flags experimental and beyond-native context sizes', () => {
    assert.equal(entry(resolveLlamaTuning(balanced, modernHelp, qwen), 'ctx').note, undefined);
    assert.match(
      entry(resolveLlamaTuning({ ...balanced, contextSize: 131_072 }, modernHelp, qwen), 'ctx')
        .note,
      /experimental/,
    );
    assert.match(
      entry(resolveLlamaTuning({ ...balanced, contextSize: 524_288 }, modernHelp, qwen), 'ctx')
        .note,
      /native 256K/,
    );
  });

  it('persists and validates the tuning settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-tuning-config-'));
    const previousPath = process.env.GENERATION_CONFIG_PATH;
    const previousKv = process.env.LLAMA_CPP_KV_CACHE;
    process.env.GENERATION_CONFIG_PATH = join(root, 'generation.json');
    delete process.env.LLAMA_CPP_KV_CACHE;
    try {
      const defaults = (await getGenerationConfig()).llamaCpp;
      assert.deepEqual(
        [defaults.kvCache, defaults.speculative, defaults.reasoningEffort],
        ['quality', 'auto', 'medium'],
      );
      const saved = (
        await updateGenerationConfig({
          llamaCpp: { kvCache: 'memory', speculative: 'off', reasoningEffort: 'xhigh' },
        })
      ).llamaCpp;
      assert.deepEqual(
        [saved.kvCache, saved.speculative, saved.reasoningEffort],
        ['memory', 'off', 'xhigh'],
      );
      await assert.rejects(updateGenerationConfig({ llamaCpp: { kvCache: 'q2' } }), /kvCache/);
      await assert.rejects(
        updateGenerationConfig({ llamaCpp: { speculative: 'always' } }),
        /speculative/,
      );
      process.env.LLAMA_CPP_KV_CACHE = 'default';
      assert.equal((await getGenerationConfig()).llamaCpp.kvCache, 'default');
    } finally {
      if (previousPath === undefined) delete process.env.GENERATION_CONFIG_PATH;
      else process.env.GENERATION_CONFIG_PATH = previousPath;
      if (previousKv === undefined) delete process.env.LLAMA_CPP_KV_CACHE;
      else process.env.LLAMA_CPP_KV_CACHE = previousKv;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats each tuning field alone as a llama.cpp restart-worthy change', () => {
    const previous = { llamaCpp: balanced };
    assert.equal(llamaCppConfigChanged(previous, { llamaCpp: { ...balanced } }), false);
    for (const [field, value] of [
      ['kvCache', 'memory'],
      ['speculative', 'off'],
      ['reasoningEffort', 'xhigh'],
    ]) {
      assert.equal(
        llamaCppConfigChanged(previous, { llamaCpp: { ...balanced, [field]: value } }),
        true,
        field,
      );
    }
  });

  it('identifies managed llama.cpp builds for update checks', () => {
    assert.deepEqual(
      managedLlamaBuild('C:\\app\\.threadshelf\\tools\\llama.cpp\\b10809-cuda\\llama-server.exe'),
      { tag: 'b10809', build: 10809, flavor: 'cuda' },
    );
    assert.equal(managedLlamaBuild('/opt/tools/llama.cpp/b9000-cpu/bin/llama-server').build, 9000);
    assert.equal(managedLlamaBuild('/usr/local/bin/llama-server'), null);
  });
});
