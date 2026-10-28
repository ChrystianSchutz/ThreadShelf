import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usePrivateChatStore } from '../client/src/private-chat-memory.ts';
import { clearLegacyPrivateStorage, safeLocalStorage } from '../client/src/safe-storage.ts';

test('private chat keeps messages, draft, and recovery in memory until cleared', () => {
  const store = usePrivateChatStore.getState();
  const firstId = store.session.id;
  store.setMessages([{ role: 'user', content: 'Synthetic private question' }]);
  store.setDraft('Synthetic unsent draft');
  store.addInterruptedGeneration({
    id: 'synthetic-attempt',
    prompt: 'Synthetic failed prompt',
    content: 'Synthetic partial answer',
    reasoning: '',
    model: 'synthetic.gguf',
    provider: 'llama-cpp',
    error: 'Synthetic failure',
    stopped: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(usePrivateChatStore.getState().session.messages.length, 1);
  assert.equal(usePrivateChatStore.getState().session.draft, 'Synthetic unsent draft');
  assert.equal(usePrivateChatStore.getState().session.interruptedGenerations.length, 1);
  store.clear();
  assert.notEqual(usePrivateChatStore.getState().session.id, firstId);
  assert.deepEqual(usePrivateChatStore.getState().session.messages, []);
  assert.equal(usePrivateChatStore.getState().session.draft, '');
  assert.deepEqual(usePrivateChatStore.getState().session.interruptedGenerations, []);
});

test('blocked browser storage does not throw during preference access or legacy cleanup', () => {
  const localDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const sessionDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  try {
    for (const name of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() {
          throw new Error('Storage blocked');
        },
      });
    }
    assert.equal(safeLocalStorage.getItem('threadshelf:ui'), null);
    assert.doesNotThrow(() => safeLocalStorage.setItem('threadshelf:ui', '{}'));
    assert.doesNotThrow(() => safeLocalStorage.removeItem('threadshelf:ui'));
    assert.doesNotThrow(clearLegacyPrivateStorage);
  } finally {
    for (const [name, descriptor] of [
      ['localStorage', localDescriptor],
      ['sessionStorage', sessionDescriptor],
    ]) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});
