import { create } from 'zustand';
import type { ContinuationMessage, GenerationProviderId } from './types';

export interface InterruptedGeneration {
  readonly id: string;
  readonly prompt: string;
  readonly content: string;
  readonly reasoning: string;
  readonly model: string;
  readonly provider: GenerationProviderId;
  readonly error: string;
  readonly stopped: boolean;
  readonly createdAt: string;
}

interface PrivateChatSession {
  readonly id: string;
  readonly messages: readonly ContinuationMessage[];
  readonly draft: string;
  readonly interruptedGenerations: readonly InterruptedGeneration[];
}

interface PrivateChatState {
  readonly session: PrivateChatSession;
  readonly setMessages: (messages: readonly ContinuationMessage[]) => void;
  readonly setDraft: (draft: string) => void;
  readonly addInterruptedGeneration: (attempt: InterruptedGeneration) => void;
  readonly dismissInterruptedGeneration: (id: string) => void;
  readonly clear: () => void;
}

const newSession = (): PrivateChatSession => ({
  id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
  messages: [],
  draft: '',
  interruptedGenerations: [],
});

// This store has no persistence middleware. A full reload or another tab starts empty.
export const usePrivateChatStore = create<PrivateChatState>((set) => ({
  session: newSession(),
  setMessages: (messages) => set((state) => ({ session: { ...state.session, messages } })),
  setDraft: (draft) => set((state) => ({ session: { ...state.session, draft } })),
  addInterruptedGeneration: (attempt) =>
    set((state) => ({
      session: {
        ...state.session,
        interruptedGenerations: [...state.session.interruptedGenerations, attempt].slice(-8),
      },
    })),
  dismissInterruptedGeneration: (id) =>
    set((state) => ({
      session: {
        ...state.session,
        interruptedGenerations: state.session.interruptedGenerations.filter(
          (attempt) => attempt.id !== id,
        ),
      },
    })),
  clear: () => set({ session: newSession() }),
}));
