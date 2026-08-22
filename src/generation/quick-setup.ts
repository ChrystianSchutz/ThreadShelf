import { inspectHardware, judgeFit, type HardwareProfile } from './hardware.js';
import {
  defaultLlamaInstallRoot,
  findLlamaExecutables,
  installLlamaCpp,
  readInstalledSource,
  resolveLlamaRelease,
  sourceFromRelease,
  type InstallSource,
  type LlamaVariant,
} from './llama-install.js';
import {
  getCatalogModel,
  quantQualityTier,
  searchCatalogModels,
  TRUSTED_PUBLISHERS,
  type CatalogModelDetail,
} from './model-catalog.js';
import { downloadModel, planModelDownload, type ModelDownloadPlan } from './model-download.js';
import { updateGenerationConfig } from './config.js';

/**
 * One screen, one consent: everything that will be downloaded is resolved and
 * shown up front — URLs, digests, sizes and destinations — so a single button
 * press is still informed consent rather than a blind "trust me".
 */

export interface QuickSetupRuntimeStep {
  readonly action: 'install' | 'reuse';
  readonly variant: LlamaVariant;
  readonly tag: string;
  readonly url?: string;
  readonly sha256?: string;
  readonly sizeBytes?: number;
  readonly companions: readonly {
    readonly url: string;
    readonly sha256: string;
    readonly sizeBytes?: number;
  }[];
  readonly destination: string;
  readonly executablePath?: string;
  readonly releaseUrl?: string;
}

export interface QuickSetupModelStep {
  readonly action: 'download' | 'reuse';
  readonly repoId: string;
  readonly quant: string;
  readonly totalBytes: number;
  readonly directory: string;
  readonly files: readonly {
    readonly url: string;
    readonly sha256?: string;
    readonly sizeBytes: number;
  }[];
  readonly license?: string;
  readonly contextLength?: number;
  readonly fit: 'fits' | 'tight' | 'too-large';
}

export interface QuickSetupPlan {
  readonly hardware: HardwareProfile;
  readonly runtime: QuickSetupRuntimeStep;
  readonly model?: QuickSetupModelStep;
  readonly totalDownloadBytes: number;
  readonly warnings: readonly string[];
}

export type QuickSetupProgress =
  | { readonly step: 'runtime'; readonly phase: string; readonly percent?: number }
  | {
      readonly step: 'model';
      readonly phase: string;
      readonly percent?: number;
      readonly file?: string;
    }
  | { readonly step: 'done'; readonly executablePath: string; readonly modelPath?: string };

const CANDIDATE_LIMIT = 8;

const percentOf = (done: number, total?: number): number | undefined =>
  total && total > 0 ? Math.min(100, Math.round((done / total) * 100)) : undefined;

const findExistingInstall = async (
  variant: LlamaVariant,
  tag: string,
): Promise<string | undefined> => {
  const executables = await findLlamaExecutables();
  for (const executable of executables) {
    // The install directory is `<root>/llama.cpp/<tag>-<flavor>`; matching on the
    // recorded metadata is more reliable than parsing that path back apart.
    const marker = executable.match(/^(.*[\\/]llama\.cpp[\\/][^\\/]+)[\\/]/);
    if (!marker?.[1]) continue;
    const installed = await readInstalledSource(marker[1]);
    if (installed?.tag === tag && (installed.flavor ?? 'cpu') === variant) return executable;
  }
  return undefined;
};

/**
 * Picks the most-downloaded GGUF repository from a trusted publisher whose
 * recommended quantisation fits the detected memory budget.
 */
export const chooseSetupModel = async (
  profile: HardwareProfile,
  fetchImpl: typeof fetch = fetch,
): Promise<{ detail: CatalogModelDetail; quant: string } | null> => {
  const { models } = await searchCatalogModels({ limit: 40, sort: 'downloads', fetchImpl });
  const candidates = models
    .filter((model) => model.trustedPublisher && model.gated === false)
    .slice(0, CANDIDATE_LIMIT);

  for (const candidate of candidates) {
    const detail = await getCatalogModel(candidate.id, fetchImpl).catch(() => null);
    if (!detail) continue;
    // Best quality tier that fits, then the largest file within that tier. Going
    // by size alone would happily pick a legacy `Q4_1` over a better `Q4_K_M`.
    const fitting = detail.quants
      .filter(
        (quant) =>
          quantQualityTier(quant.label) > 1 && judgeFit(quant.totalBytes, profile) === 'fits',
      )
      .sort(
        (a, b) =>
          quantQualityTier(b.label) - quantQualityTier(a.label) || b.totalBytes - a.totalBytes,
      )[0];
    if (fitting) return { detail, quant: fitting.label };
  }
  return null;
};

export const buildQuickSetupPlan = async ({
  variant,
  repoId,
  quant,
  fetchImpl = fetch,
}: {
  variant?: LlamaVariant;
  repoId?: string;
  quant?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<QuickSetupPlan> => {
  const hardware = await inspectHardware();
  const warnings: string[] = [];

  const chosenVariant: LlamaVariant =
    variant ?? (process.platform === 'darwin' ? 'cpu' : hardware.suggestedVariant);
  const release = await resolveLlamaRelease({ fetchImpl });

  let source: InstallSource;
  try {
    source = sourceFromRelease(release, { variant: chosenVariant });
  } catch (error) {
    // A GPU build may simply not exist for this platform in this release.
    warnings.push(
      `${chosenVariant.toUpperCase()} build unavailable (${error instanceof Error ? error.message : 'unknown'}); falling back to CPU.`,
    );
    source = sourceFromRelease(release, { variant: 'cpu' });
  }
  const effectiveVariant = source.flavor ?? 'cpu';
  const existingExecutable = await findExistingInstall(effectiveVariant, source.tag);

  const runtime: QuickSetupRuntimeStep = {
    action: existingExecutable ? 'reuse' : 'install',
    variant: effectiveVariant,
    tag: source.tag,
    url: existingExecutable ? undefined : source.url,
    sha256: existingExecutable ? undefined : source.sha256,
    sizeBytes: existingExecutable ? undefined : source.sizeBytes,
    companions: existingExecutable
      ? []
      : (source.companions ?? []).map((companion) => ({
          url: companion.url,
          sha256: companion.sha256,
          sizeBytes: companion.sizeBytes,
        })),
    destination: defaultLlamaInstallRoot(),
    executablePath: existingExecutable,
    releaseUrl: source.releaseUrl,
  };

  let model: QuickSetupModelStep | undefined;
  const selection = repoId
    ? { detail: await getCatalogModel(repoId, fetchImpl), quant }
    : await chooseSetupModel(hardware, fetchImpl);

  if (!selection) {
    warnings.push(
      'No catalog model matched the detected memory budget. Pick one manually from the model browser.',
    );
  } else {
    const downloadPlan = await planModelDownload({
      repoId: selection.detail.id,
      quant: selection.quant,
      detail: selection.detail,
      fetchImpl,
    });
    model = {
      action: 'download',
      repoId: downloadPlan.repoId,
      quant: downloadPlan.quant,
      totalBytes: downloadPlan.totalBytes,
      directory: downloadPlan.directory,
      files: downloadPlan.files.map((file) => ({
        url: file.url,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
      })),
      license: downloadPlan.license,
      contextLength: downloadPlan.contextLength,
      fit: judgeFit(downloadPlan.totalBytes, hardware),
    };
    if (downloadPlan.requiresToken) {
      warnings.push(`${downloadPlan.repoId} is gated and needs HF_TOKEN before it can download.`);
    }
  }

  if (hardware.detectionSource === 'none') {
    warnings.push('No accelerator detected. Generation will run on CPU.');
  }

  // The figure on the confirm button must cover every byte the run will fetch,
  // runtime archive and companions included — not just the model.
  const runtimeBytes =
    runtime.action === 'install'
      ? (runtime.sizeBytes ?? 0) +
        runtime.companions.reduce((sum, companion) => sum + (companion.sizeBytes ?? 0), 0)
      : 0;

  return {
    hardware,
    runtime,
    model,
    totalDownloadBytes:
      runtimeBytes + (model?.action === 'download' ? model.totalBytes : 0),
    warnings,
  };
};

export const runQuickSetupPlan = async (
  plan: QuickSetupPlan,
  {
    onProgress,
    signal,
    fetchImpl = fetch,
  }: {
    onProgress?: (progress: QuickSetupProgress) => void;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<{ readonly executablePath: string; readonly modelPath?: string }> => {
  let executablePath = plan.runtime.executablePath;

  if (plan.runtime.action === 'install') {
    onProgress?.({ step: 'runtime', phase: 'resolving' });
    // The plan is re-resolved rather than trusted: a client must not be able to
    // hand the server an arbitrary URL to fetch and execute.
    const release = await resolveLlamaRelease({ tag: plan.runtime.tag, fetchImpl });
    const source = sourceFromRelease(release, { variant: plan.runtime.variant });
    const result = await installLlamaCpp(source, {
      onProgress: (progress) =>
        onProgress?.({
          step: 'runtime',
          phase: progress.phase,
          percent: percentOf(progress.downloadedBytes ?? 0, progress.totalBytes),
        }),
    });
    executablePath = result.executablePath;
  }
  if (!executablePath) throw new Error('llama.cpp setup did not produce an executable');

  let modelPath: string | undefined;
  if (plan.model) {
    signal?.throwIfAborted();
    onProgress?.({ step: 'model', phase: 'resolving' });
    const downloadPlan: ModelDownloadPlan = await planModelDownload({
      repoId: plan.model.repoId,
      quant: plan.model.quant,
      fetchImpl,
    });
    const result = await downloadModel(downloadPlan, {
      signal,
      onProgress: (progress) =>
        onProgress?.({
          step: 'model',
          phase: progress.phase,
          file: 'file' in progress ? progress.file : undefined,
          percent:
            progress.phase === 'downloading'
              ? percentOf(progress.downloadedBytes, progress.totalBytes)
              : undefined,
        }),
    });
    modelPath = result.primaryPath;
  }

  // Pin the executable so later runs do not re-discover a different build.
  await updateGenerationConfig({ llamaCpp: { executablePath } }).catch(() => undefined);
  onProgress?.({ step: 'done', executablePath, modelPath });
  return { executablePath, modelPath };
};

export const trustedSetupPublishers = TRUSTED_PUBLISHERS;
