import { effectiveModelDirectories, getGenerationConfig, generationPathExists } from '../config.js';
import { findLlamaExecutables } from '../llama-install.js';
import {
  getLlamaFailureContext,
  getManagedLlamaStatus,
  llamaVisionSupported,
  withLlamaServer,
} from '../llama-process.js';
import { discoverGgufModels, localGgufModelName } from '../model-discovery.js';
import { openAiCompatibleChat, openAiCompatibleChatStream } from '../openai-compatible.js';
import { hasVisionProjector } from '../vision.js';
import type { GenerationProvider } from '../types.js';

export const createLlamaCppProvider = (fetchImpl: typeof fetch = fetch): GenerationProvider => ({
  id: 'llama-cpp',
  label: 'llama.cpp',
  local: true,

  async status() {
    const config = await getGenerationConfig();
    const executable = config.llamaCpp.executablePath
      ? generationPathExists(config.llamaCpp.executablePath)
        ? config.llamaCpp.executablePath
        : undefined
      : (await findLlamaExecutables())[0];
    const available = Boolean(config.llamaCpp.baseUrl || executable);
    return {
      id: 'llama-cpp',
      label: 'llama.cpp',
      available,
      local: true,
      detail: config.llamaCpp.baseUrl
        ? `External local server: ${config.llamaCpp.baseUrl}`
        : executable
          ? `Executable: ${executable}`
          : 'llama-server not found; run npm run setup:llama or set its path.',
    };
  },

  async listModels() {
    const config = await getGenerationConfig();
    if (config.llamaCpp.baseUrl) {
      const response = await fetchImpl(`${config.llamaCpp.baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`llama.cpp models request failed (${response.status})`);
      const payload = (await response.json()) as { data?: readonly { id?: string }[] };
      const props = await fetchImpl(`${config.llamaCpp.baseUrl}/props`, {
        signal: AbortSignal.timeout(2000),
      })
        .then(async (response) =>
          response.ok
            ? ((await response.json()) as { modalities?: { vision?: boolean } })
            : undefined,
        )
        .catch(() => undefined);
      return (payload.data ?? [])
        .filter((model): model is { id: string } => Boolean(model.id))
        .map((model) => ({
          id: model.id,
          name: model.id,
          provider: 'llama-cpp' as const,
          loaded: true,
          vision: props?.modalities?.vision,
        }));
    }
    const [models, runtime, visionSupported] = await Promise.all([
      discoverGgufModels(effectiveModelDirectories(config.llamaCpp)),
      Promise.resolve(getManagedLlamaStatus()),
      llamaVisionSupported(),
    ]);
    return Promise.all(
      models.map(async (model) => ({
        ...model,
        // A build without --mmproj skips the projector at launch, so the model
        // must not be advertised (or accept images at /v1) as vision-capable.
        vision:
          visionSupported !== false &&
          (await hasVisionProjector(
            model.id,
            effectiveModelDirectories(config.llamaCpp),
            config.llamaCpp.projectorPaths,
          )),
        loaded:
          runtime.state !== 'stopped' && runtime.model !== undefined && model.id === runtime.model,
      })),
    );
  },

  async chat(request, signal) {
    const managed = !(await getGenerationConfig()).llamaCpp.baseUrl;
    try {
      const response = await withLlamaServer(request.model, (baseUrl) =>
        openAiCompatibleChat({
          provider: 'llama-cpp',
          baseUrl,
          request,
          signal,
          fetchImpl,
        }),
      );
      return {
        ...response,
        model: managed ? localGgufModelName(request.model) : response.model,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const context = managed ? getLlamaFailureContext() : undefined;
      throw new Error(
        [`llama.cpp generation failed: ${message}`, context].filter(Boolean).join('\n\n'),
        { cause: error },
      );
    }
  },

  async chatStream(request, onDelta, signal) {
    const managed = !(await getGenerationConfig()).llamaCpp.baseUrl;
    const model = managed ? localGgufModelName(request.model) : request.model;
    try {
      const response = await withLlamaServer(request.model, (baseUrl) =>
        openAiCompatibleChatStream(
          {
            provider: 'llama-cpp',
            baseUrl,
            request,
            signal,
            fetchImpl,
          },
          (delta) => onDelta({ ...delta, model: managed ? model : delta.model }),
        ),
      );
      return { ...response, model: managed ? model : response.model };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const context = managed ? getLlamaFailureContext() : undefined;
      throw new Error(
        [`llama.cpp generation failed: ${message}`, context].filter(Boolean).join('\n\n'),
        { cause: error },
      );
    }
  },
});
