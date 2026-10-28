import { createLlamaCppProvider } from './providers/llama-cpp.js';
import { createOpenRouterProvider } from './providers/openrouter.js';
import { createStrataProvider } from './providers/strata.js';
import type { GenerationProvider, GenerationProviderId } from './types.js';

const providers = new Map<GenerationProviderId, GenerationProvider>([
  ['llama-cpp', createLlamaCppProvider()],
  ['openrouter', createOpenRouterProvider()],
  ['strata', createStrataProvider()],
]);

export const getGenerationProvider = (id: GenerationProviderId): GenerationProvider => {
  const provider = providers.get(id);
  if (!provider) throw new Error(`Unknown generation provider: ${id}`);
  return provider;
};

export const listGenerationProviders = (): GenerationProvider[] => [...providers.values()];

export const setGenerationProviderForTests = (
  id: GenerationProviderId,
  provider: GenerationProvider,
): (() => void) => {
  const previous = providers.get(id);
  providers.set(id, provider);
  return () => {
    if (previous) providers.set(id, previous);
    else providers.delete(id);
  };
};
