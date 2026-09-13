import type { LlamaCppConfig, LlamaFlashAttention } from './config.js';
import type { GgufModelMetadata } from './gguf-metadata.js';
import type { LlamaRuntimeCapabilities } from './llama-process.js';
import type { LlamaRuntimeProfileEntry } from './types.js';

// Only symmetric pairs: stock CUDA builds compile Flash Attention kernels for
// q8_0/q8_0 and q4_0/q4_0, while other combinations can fall back to slow paths.
const KV_CACHE_TYPE = { quality: 'q8_0', memory: 'q4_0' } as const;
const MTP_DRAFT_TOKENS = { auto: 2, aggressive: 3 } as const;

/** Above this, current CUDA builds have reported severe decode slowdowns. */
export const LONG_CONTEXT_WARNING_TOKENS = 65_536;

export interface LlamaTuning {
  /** Effective Flash Attention mode; a quantized KV cache requires it on. */
  readonly flashAttention: LlamaFlashAttention;
  readonly args: readonly string[];
  readonly entries: readonly LlamaRuntimeProfileEntry[];
}

const formatTokens = (value: number): string =>
  value % 1024 === 0 ? `${value / 1024}K` : value.toLocaleString('en-US');

/**
 * Turns the saved performance settings into llama-server flags. Every option is
 * gated on what this executable advertises in `--help` and on the GGUF header, so
 * an unsupported choice is reported as skipped instead of breaking server startup.
 * Sampling (temperature/top-p/top-k) is deliberately never touched here.
 */
export const resolveLlamaTuning = (
  config: LlamaCppConfig,
  capabilities: LlamaRuntimeCapabilities,
  model: GgufModelMetadata | null,
): LlamaTuning => {
  const args: string[] = [];
  const entries: LlamaRuntimeProfileEntry[] = [];
  const skipped = (setting: string, value: string, note: string): LlamaRuntimeProfileEntry => ({
    setting,
    value,
    source: 'runtime',
    applied: false,
    note,
  });

  const contextNotes = [
    model?.contextLength && config.contextSize > model.contextLength
      ? `exceeds the model's native ${formatTokens(model.contextLength)}`
      : '',
    config.contextSize > LONG_CONTEXT_WARNING_TOKENS
      ? 'experimental: very long contexts can decode much slower'
      : '',
  ].filter(Boolean);
  entries.push({
    setting: 'ctx',
    value: formatTokens(config.contextSize),
    source: 'settings',
    applied: true,
    ...(contextNotes.length ? { note: contextNotes.join('; ') } : {}),
  });

  let flashAttention = config.flashAttention;
  let kvEntry: LlamaRuntimeProfileEntry | undefined;
  const kvCache = config.kvCache ?? 'default';
  if (kvCache !== 'default') {
    const type = KV_CACHE_TYPE[kvCache];
    const value = `${type}×${type}`;
    if (!capabilities.kvCacheTypes) {
      kvEntry = skipped('KV', value, 'this llama-server has no --cache-type-k');
    } else if (config.flashAttention === 'off') {
      kvEntry = skipped('KV', value, 'a quantized KV cache needs Flash Attention, which is off');
    } else if (!capabilities.flashAttentionValues) {
      kvEntry = skipped('KV', value, 'this llama-server cannot force Flash Attention on');
    } else {
      args.push('--cache-type-k', type, '--cache-type-v', type);
      kvEntry = { setting: 'KV', value, source: 'settings', applied: true };
      flashAttention = 'on';
    }
  }
  entries.push({
    setting: 'FA',
    value: flashAttention,
    applied: true,
    ...(flashAttention === config.flashAttention
      ? { source: 'settings' as const }
      : { source: 'threadshelf' as const, note: 'required by the quantized KV cache' }),
  });
  if (kvEntry) entries.push(kvEntry);

  const speculative = config.speculative ?? 'off';
  if (speculative === 'off') {
    entries.push({ setting: 'MTP', value: 'off', source: 'settings', applied: true });
  } else {
    const draft = String(MTP_DRAFT_TOKENS[speculative]);
    if (!capabilities.speculativeTypes.includes('draft-mtp')) {
      entries.push(skipped('MTP', draft, 'this llama-server has no draft-mtp decoding'));
    } else if (!model) {
      entries.push(skipped('MTP', draft, 'GGUF metadata could not be read'));
    } else if (model.nextnPredictLayers < 1) {
      entries.push({
        setting: 'MTP',
        value: 'off',
        source: 'model',
        applied: true,
        note: 'the model has no MTP/NextN head',
      });
    } else {
      args.push('--spec-type', 'draft-mtp', '--spec-draft-n-max', draft);
      entries.push({
        setting: 'MTP',
        value: draft,
        source: 'settings',
        applied: true,
        note: `${model.nextnPredictLayers} NextN layer(s) in the GGUF`,
      });
    }
  }

  const reasoning = config.reasoningEffort ?? 'default';
  if (reasoning === 'off') {
    if (capabilities.reasoningToggle) {
      args.push('--reasoning', 'off');
      entries.push({ setting: 'reasoning', value: 'off', source: 'settings', applied: true });
    } else {
      entries.push(skipped('reasoning', 'off', 'this llama-server has no --reasoning switch'));
    }
  } else if (reasoning !== 'default') {
    if (capabilities.reasoningEffort) {
      args.push('--reasoning-effort', reasoning);
      entries.push({ setting: 'reasoning', value: reasoning, source: 'settings', applied: true });
    } else {
      entries.push(skipped('reasoning', reasoning, 'this llama-server has no --reasoning-effort'));
    }
  }

  if (capabilities.parallelSlots) {
    args.push('--parallel', '1');
    entries.push({
      setting: 'slots',
      value: '1',
      source: 'threadshelf',
      applied: true,
      note: 'single local user; concurrent chats queue',
    });
  }

  return { flashAttention, args, entries };
};

/** One human-readable line: value, where it came from, and why anything was skipped. */
export const formatLlamaTuning = (entries: readonly LlamaRuntimeProfileEntry[]): string =>
  entries
    .map(
      (entry) =>
        `${entry.setting} ${entry.value} (${entry.applied ? entry.source : 'skipped'}${
          entry.note ? `: ${entry.note}` : ''
        })`,
    )
    .join(' · ');
