import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { CollectionStats, MasterPromptCollection } from './types';

// Report "backend unreachable" only after consecutive failed pings — during a
// heavy ingest the server event loop can miss a single ping while still alive.
let healthFailureStreak = 0;

export const useHealthQuery = () => {
  return useQuery({
    queryKey: ['health'],
    queryFn: async ({ signal }) => {
      const ok = await api.health(signal);
      healthFailureStreak = ok ? 0 : healthFailureStreak + 1;
      return ok || healthFailureStreak < 2;
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
};

export const useCollectionsQuery = () => {
  return useQuery({
    queryKey: ['collections'],
    queryFn: async ({ signal }) => {
      const { collections } = await api.collections(signal);
      const normalized = [...new Set(['all', ...collections])];
      const stats: Record<string, CollectionStats> = {};
      try {
        const allStats = await api.allCollectionStats(signal);
        for (const item of allStats.collections ?? []) {
          if (item.collection) stats[item.collection] = item;
        }
      } catch {
        // Collections can still render without stats; the next refetch will retry.
      }

      return { collections: normalized, stats };
    },
    staleTime: 15_000,
  });
};

export const useInsightsQuery = (collection: string) => {
  return useQuery({
    queryKey: ['insights', collection],
    queryFn: ({ signal }) => api.insights(collection, signal),
    staleTime: 60_000,
  });
};

export const useFilesQuery = (collection: string, enabled: boolean) => {
  return useQuery({
    queryKey: ['files', collection],
    queryFn: ({ signal }) => api.files(collection, signal),
    enabled,
    staleTime: 30_000,
  });
};

export const LOCAL_API_STATUS_KEY = ['local-api-status'] as const;

export const useLocalApiStatusQuery = () => {
  return useQuery({
    queryKey: LOCAL_API_STATUS_KEY,
    queryFn: ({ signal }) => api.localApiStatus(signal),
    staleTime: 30_000,
  });
};

export const useGenerationThreadsQuery = () => {
  return useQuery({
    queryKey: ['generation-threads'],
    queryFn: ({ signal }) => api.generationThreads(signal),
    staleTime: 10_000,
  });
};

export const useSearchQuery = (params: {
  q: string;
  collection: string;
  roles: string | undefined;
  keywordBoost: boolean;
  model: string | undefined;
  from: string | undefined;
  to: string | undefined;
  n: number;
  mode?: string;
  origin?: 'threadshelf' | 'archive';
}) => {
  return useQuery({
    queryKey: ['search', params],
    queryFn: ({ signal }) => api.search(params, signal),
    enabled: params.q.trim().length > 0,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
};

export const useThreadQuery = (
  sourceFile: string,
  collection: string,
  conversationKey?: string,
) => {
  return useQuery({
    queryKey: ['thread', sourceFile, collection, conversationKey],
    queryFn: ({ signal }) => api.thread(sourceFile, collection, conversationKey, signal),
    enabled: !!sourceFile,
    staleTime: 5 * 60_000,
  });
};

// Master prompts live on the local server, so the composer chip and the editor
// share one cache entry and every mutation returns the whole collection.
export const useMasterPromptsQuery = () => {
  return useQuery({
    queryKey: ['master-prompts'],
    queryFn: ({ signal }) => api.masterPrompts(signal),
    staleTime: 60_000,
  });
};

export const useActiveMasterPromptText = (): string => {
  const { data } = useMasterPromptsQuery();
  return data?.prompts.find((prompt) => prompt.id === data.activeId)?.text ?? '';
};

export const useMasterPromptMutation = <TInput>(
  mutationFn: (input: TInput) => Promise<MasterPromptCollection>,
) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (collection) => queryClient.setQueryData(['master-prompts'], collection),
  });
};

export const useDeleteCollectionMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.deleteCollection(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['files'] });
      void queryClient.invalidateQueries({ queryKey: ['search'] });
      void queryClient.invalidateQueries({ queryKey: ['thread'] });
    },
  });
};

export const useClearCollectionMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.clearCollection(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void queryClient.invalidateQueries({ queryKey: ['files'] });
      void queryClient.invalidateQueries({ queryKey: ['search'] });
      void queryClient.invalidateQueries({ queryKey: ['thread'] });
    },
  });
};

export const useCreateCollectionMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.createCollection(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
    },
  });
};
