import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { safeLocalStorage } from './safe-storage';
import type {
  FavoriteGenerationModel,
  PinnedConversation,
  RoleFilters,
  SavedSearch,
} from './types';

export type Theme = 'dark' | 'light';

export const savedSearchSignature = (s: Omit<SavedSearch, 'id' | 'savedAt'>): string =>
  [s.q, s.collection, s.mode, s.model ?? '', s.from ?? '', s.to ?? ''].join('\0');

export const pinKey = (p: PinnedConversation): string =>
  [p.collection, p.sourceFile, p.conversationKey ?? ''].join('\0');

export const favoriteModelKey = (model: FavoriteGenerationModel): string =>
  `${model.provider}\0${model.id}`;

interface UIState {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;

  activeColl: string;
  setActiveColl: (c: string) => void;

  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;

  cmdkOpen: boolean;
  setCmdkOpen: (open: boolean) => void;

  newCollOpen: boolean;
  setNewCollOpen: (open: boolean) => void;

  roles: RoleFilters;
  toggleRole: (key: keyof RoleFilters) => void;

  modelFilter: string;
  setModelFilter: (m: string) => void;

  savedSearches: SavedSearch[];
  addSavedSearch: (s: Omit<SavedSearch, 'id' | 'savedAt'>) => void;
  removeSavedSearch: (id: string) => void;

  pinnedConversations: PinnedConversation[];
  togglePinned: (p: PinnedConversation) => void;

  favoriteGenerationModels: FavoriteGenerationModel[];
  toggleFavoriteGenerationModel: (model: FavoriteGenerationModel) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      theme: 'dark',
      toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
      setTheme: (theme) => set({ theme }),

      activeColl: 'all',
      setActiveColl: (activeColl) => set({ activeColl }),

      sidebarOpen: false,
      setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),

      cmdkOpen: false,
      setCmdkOpen: (cmdkOpen) => set({ cmdkOpen }),

      newCollOpen: false,
      setNewCollOpen: (newCollOpen) => set({ newCollOpen }),

      roles: { user: true, thinking: true, ai: true },
      toggleRole: (key) => set((s) => ({ roles: { ...s.roles, [key]: !s.roles[key] } })),

      modelFilter: '',
      setModelFilter: (modelFilter) => set({ modelFilter }),

      savedSearches: [],
      addSavedSearch: (s) =>
        set((state) => {
          const signature = savedSearchSignature(s);
          if (state.savedSearches.some((item) => savedSearchSignature(item) === signature)) {
            return state;
          }
          const saved: SavedSearch = {
            ...s,
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            savedAt: new Date().toISOString(),
          };
          // Newest first, capped so localStorage stays small.
          return { savedSearches: [saved, ...state.savedSearches].slice(0, 50) };
        }),
      removeSavedSearch: (id) =>
        set((state) => ({ savedSearches: state.savedSearches.filter((s) => s.id !== id) })),

      pinnedConversations: [],
      togglePinned: (p) =>
        set((state) => {
          const key = pinKey(p);
          const exists = state.pinnedConversations.some((item) => pinKey(item) === key);
          return {
            pinnedConversations: exists
              ? state.pinnedConversations.filter((item) => pinKey(item) !== key)
              : [p, ...state.pinnedConversations].slice(0, 100),
          };
        }),

      favoriteGenerationModels: [],
      toggleFavoriteGenerationModel: (model) =>
        set((state) => {
          const key = favoriteModelKey(model);
          const exists = state.favoriteGenerationModels.some(
            (candidate) => favoriteModelKey(candidate) === key,
          );
          return {
            favoriteGenerationModels: exists
              ? state.favoriteGenerationModels.filter(
                  (candidate) => favoriteModelKey(candidate) !== key,
                )
              : [model, ...state.favoriteGenerationModels].slice(0, 100),
          };
        }),
    }),
    {
      name: 'threadshelf:ui',
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (state) => ({
        theme: state.theme,
        activeColl: state.activeColl,
        roles: state.roles,
        savedSearches: state.savedSearches,
        pinnedConversations: state.pinnedConversations,
        favoriteGenerationModels: state.favoriteGenerationModels,
      }),
    },
  ),
);
