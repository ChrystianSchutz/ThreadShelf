import { freemem, totalmem } from 'os';
import { findLlamaExecutables } from './llama-install.js';
import { inspectLlamaDevices } from './llama-process.js';
import { runCommandCapture } from './llama-install.js';
import type { LlamaDeviceInfo } from './types.js';

/**
 * What the model catalog needs to answer "will this fit?": accelerator memory
 * when it can be detected, system memory always.
 */
export interface HardwareProfile {
  readonly devices: readonly LlamaDeviceInfo[];
  readonly detectionSource: 'llama.cpp' | 'nvidia-smi' | 'none';
  readonly totalRamBytes: number;
  readonly freeRamBytes: number;
  /** Largest usable accelerator budget, or 0 when generation would run on CPU. */
  readonly vramBudgetBytes: number;
  /** Budget used to judge fit, falling back to system RAM without a GPU. */
  readonly modelBudgetBytes: number;
  readonly suggestedVariant: 'cpu' | 'cuda' | 'vulkan';
}

/**
 * Weights are not the whole story: the KV cache, compute buffers and the OS all
 * want memory too. Judging fit against the raw device size would recommend
 * models that load and then immediately thrash.
 */
const VRAM_HEADROOM = 0.85;
const RAM_HEADROOM = 0.6;

export type FitVerdict = 'fits' | 'tight' | 'too-large';

export const judgeFit = (sizeBytes: number, profile: HardwareProfile): FitVerdict => {
  const budget = profile.modelBudgetBytes;
  if (budget <= 0) return 'too-large';
  if (sizeBytes <= budget) return 'fits';
  // Above the accelerator budget a model still runs, just partly on CPU.
  if (sizeBytes <= profile.totalRamBytes * RAM_HEADROOM) return 'tight';
  return 'too-large';
};

const parseNvidiaSmi = (output: string): LlamaDeviceInfo[] =>
  output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [name, total, free] = line.split(',').map((part) => part.trim());
      const totalMiB = Number(total);
      const freeMiB = Number(free);
      if (!name || !Number.isFinite(totalMiB)) return null;
      return {
        id: `CUDA${index}`,
        name,
        totalBytes: totalMiB * 1024 ** 2,
        freeBytes: (Number.isFinite(freeMiB) ? freeMiB : totalMiB) * 1024 ** 2,
      };
    })
    .filter((device): device is LlamaDeviceInfo => device !== null);

export const inspectHardware = async (): Promise<HardwareProfile> => {
  const totalRamBytes = totalmem();
  const freeRamBytes = freemem();
  let devices: readonly LlamaDeviceInfo[] = [];
  let detectionSource: HardwareProfile['detectionSource'] = 'none';

  // An installed llama-server reports exactly the devices it would itself use,
  // which beats guessing from vendor tools.
  const executable = (await findLlamaExecutables())[0];
  if (executable) {
    const inspection = await inspectLlamaDevices(executable).catch(() => null);
    if (inspection?.devices.length) {
      devices = inspection.devices;
      detectionSource = 'llama.cpp';
    }
  }

  if (devices.length === 0) {
    const output = await runCommandCapture('nvidia-smi', [
      '--query-gpu=name,memory.total,memory.free',
      '--format=csv,noheader,nounits',
    ]).catch(() => '');
    const parsed = parseNvidiaSmi(output);
    if (parsed.length > 0) {
      devices = parsed;
      detectionSource = 'nvidia-smi';
    }
  }

  const largest = devices.reduce(
    (best, device) => Math.max(best, device.freeBytes || device.totalBytes),
    0,
  );
  const vramBudgetBytes = Math.floor(largest * VRAM_HEADROOM);
  const modelBudgetBytes =
    vramBudgetBytes > 0 ? vramBudgetBytes : Math.floor(totalRamBytes * RAM_HEADROOM);

  const suggestedVariant: HardwareProfile['suggestedVariant'] =
    process.platform === 'darwin'
      ? 'cpu'
      : detectionSource === 'nvidia-smi' ||
          devices.some((device) => /^cuda/i.test(device.id) || /nvidia|geforce|rtx|quadro|tesla/i.test(device.name))
        ? 'cuda'
        : devices.length > 0
          ? 'vulkan'
          : 'cpu';

  return {
    devices,
    detectionSource,
    totalRamBytes,
    freeRamBytes,
    vramBudgetBytes,
    modelBudgetBytes,
    suggestedVariant,
  };
};
