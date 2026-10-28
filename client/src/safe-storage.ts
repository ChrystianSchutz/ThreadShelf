import type { StateStorage } from 'zustand/middleware';

// Browser storage can be unavailable or throw on access, including during hydration.
export const safeLocalStorage: StateStorage = {
  getItem: (key) => {
    try {
      return globalThis.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      globalThis.localStorage.setItem(key, value);
    } catch {
      // UI preferences remain in memory when storage is blocked or full.
    }
  },
  removeItem: (key) => {
    try {
      globalThis.localStorage.removeItem(key);
    } catch {
      // The in-memory preference is still removed.
    }
  },
};

export const clearLegacyPrivateStorage = (): void => {
  try {
    const storage = globalThis.sessionStorage;
    storage.removeItem('threadshelf:private-chat');
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (/^threadshelf:interrupted-generations:\d{4}-\d\d-\d\dT/.test(key ?? '')) {
        storage.removeItem(key!);
      }
    }
  } catch {
    // Legacy cleanup is best effort when session storage is blocked.
  }
};
