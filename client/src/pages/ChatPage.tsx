import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useUIStore } from '../store';
import { api } from '../api';
import type {
  ContinuationMessage,
  ThreadShelfChat,
  ThreadShelfChatSummary,
  ThreadTurn,
} from '../types';
import { Icons } from '../icons';
import { fmtRelative } from '../utils';
import { confirmDialog, toast } from '../toast';
import { Topbar } from '../components/Topbar';
import { ThreadContinuation } from '../components/ThreadContinuation';
import { usePrivateChatStore } from '../private-chat-memory';
import { clearLegacyPrivateStorage } from '../safe-storage';

const PRIVATE_SESSION_ID = 'private-session';
const DRAFT_SAVED_ID = 'draft-saved';

const newDraftScope = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

const continuationFromTurns = (turns: readonly ThreadTurn[]): ContinuationMessage[] => {
  const messages: ContinuationMessage[] = [];
  let reasoning: string | undefined;
  for (const turn of turns) {
    if (turn.user !== undefined) {
      messages.push({ role: 'user', content: turn.user, model: turn.model });
      reasoning = undefined;
    } else if (turn.thinking !== undefined) {
      reasoning = turn.thinking;
    } else if (turn.ai !== undefined) {
      messages.push({
        role: 'assistant',
        content: turn.ai,
        model: turn.model,
        reasoning,
      });
      reasoning = undefined;
    }
  }
  return messages;
};

// Display-only label for the unsaved private session (chat header + rail entry),
// never persisted — so a short cut is correct here, unlike the stored titles
// derived in `src/generation/threads.ts`.
const titleFromMessages = (messages: readonly ContinuationMessage[]): string => {
  const prompt = messages.find((message) => message.role === 'user')?.content.trim();
  if (!prompt) return 'New chat';
  const compact = prompt.replace(/\s+/g, ' ');
  return compact.length > 52 ? `${compact.slice(0, 49)}…` : compact;
};

export function ChatPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const chatSearch = useSearch({ from: '/chat' });
  const activeColl = useUIStore((state) => state.activeColl);
  const setSidebarOpen = useUIStore((state) => state.setSidebarOpen);
  const [threads, setThreads] = useState<ThreadShelfChatSummary[]>([]);
  const privateSession = usePrivateChatStore((state) => state.session);
  const setPrivateMessages = usePrivateChatStore((state) => state.setMessages);
  const clearPrivateSession = usePrivateChatStore((state) => state.clear);
  const [activeId, setActiveId] = useState(() =>
    chatSearch.draft
      ? DRAFT_SAVED_ID
      : chatSearch.private
        ? PRIVATE_SESSION_ID
        : chatSearch.thread
          ? chatSearch.thread
          : privateSession.messages.length || privateSession.interruptedGenerations.length
            ? PRIVATE_SESSION_ID
            : '',
  );
  const [chat, setChat] = useState<ThreadShelfChat>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Only the setter is read directly; the id is consumed via the functional
  // updater in handleDraftCompleted to avoid a stale-closure race.
  const [, setDraftRealId] = useState('');
  const [draftAttemptScope, setDraftAttemptScope] = useState(
    () => chatSearch.draft ?? newDraftScope(),
  );
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  const loadList = useCallback(
    async (signal?: AbortSignal) => {
      const result = await api.generationThreads(signal);
      setThreads(result.threads);
      queryClient.setQueryData(['generation-threads'], result);
      return result.threads;
    },
    [queryClient],
  );

  useEffect(() => clearLegacyPrivateStorage(), []);

  useEffect(() => {
    const controller = new AbortController();
    void api
      .generationThreads(controller.signal)
      .then((result) => {
        setThreads(result.threads);
        queryClient.setQueryData(['generation-threads'], result);
        setActiveId((current) => current || result.threads[0]?.id || '');
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(cause instanceof Error ? cause.message : 'Could not load local chats.');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [queryClient]);

  useEffect(() => {
    if (activeId === PRIVATE_SESSION_ID || activeId === DRAFT_SAVED_ID || !activeId) {
      return undefined;
    }
    const controller = new AbortController();
    void api
      .generationThread(activeId, controller.signal)
      .then(setChat)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setError(cause instanceof Error ? cause.message : 'Could not open this chat.');
      });
    return () => controller.abort();
  }, [activeId]);

  const openPrivateChat = useCallback(() => {
    setChat(undefined);
    setActiveId(PRIVATE_SESSION_ID);
    setError('');
  }, []);

  // Lazy create: "New chat" is a UI-only draft. The database row is created
  // on the first message (handleCreateDraftThread), so abandoned chats leave no
  // ghost rows in the list or the collection.
  const startSavedChat = useCallback((scope?: string) => {
    setChat(undefined);
    setDraftRealId('');
    setDraftAttemptScope(scope ?? newDraftScope());
    setEditingTitle(false);
    setActiveId(DRAFT_SAVED_ID);
    setError('');
  }, []);

  useEffect(() => {
    if (!chatSearch.draft) return undefined;
    const timeout = window.setTimeout(() => startSavedChat(chatSearch.draft), 0);
    return () => window.clearTimeout(timeout);
  }, [chatSearch.draft, startSavedChat]);

  useEffect(() => {
    if (!chatSearch.private) return undefined;
    const timeout = window.setTimeout(openPrivateChat, 0);
    return () => window.clearTimeout(timeout);
  }, [chatSearch.private, openPrivateChat]);

  useEffect(() => {
    if (!chatSearch.thread) return undefined;
    // Reopening the chat that is already shown keeps it: resetting would clear
    // it without a refetch, because activeId does not change.
    if (chatSearch.thread === activeId) return undefined;
    const timeout = window.setTimeout(() => {
      setChat(undefined);
      setEditingTitle(false);
      setError('');
      setActiveId(chatSearch.thread ?? '');
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [chatSearch.thread, activeId]);

  useEffect(() => {
    document.querySelector<HTMLElement>('.main-scroll')?.scrollTo({ top: 0 });
  }, [activeId]);

  const handleCreateDraftThread = useCallback(async (): Promise<string> => {
    const created = await api.createGenerationThread('New chat');
    setThreads((current) => [created, ...current.filter((item) => item.id !== created.id)]);
    queryClient.setQueryData<{ threads: ThreadShelfChatSummary[] }>(
      ['generation-threads'],
      (current) => ({
        threads: [created, ...(current?.threads ?? []).filter((item) => item.id !== created.id)],
      }),
    );
    setDraftRealId(created.id);
    await queryClient.invalidateQueries({ queryKey: ['collections'] });
    return created.id;
  }, [queryClient]);

  const handleDraftCompleted = useCallback(async () => {
    try {
      await loadList();
    } catch {
      // A refresh failure is non-fatal; the draft view keeps the live messages.
    }
    // Hand the finished draft over to the normal saved-chat path (idle remount).
    setDraftRealId((id) => {
      if (id) {
        setActiveId(id);
        void navigate({ to: '/chat', search: { thread: id } });
      }
      return '';
    });
  }, [loadList, navigate]);

  const startRename = () => {
    if (!chat) return;
    setTitleDraft(chat.title);
    setEditingTitle(true);
  };

  const saveRename = async () => {
    const next = titleDraft.replace(/\s+/g, ' ').trim();
    setEditingTitle(false);
    if (!chat || !next || next === chat.title) return;
    try {
      const updated = await api.renameGenerationThread(chat.id, next);
      setChat(updated);
      setThreads((current) =>
        current.map((item) => (item.id === updated.id ? { ...item, title: updated.title } : item)),
      );
      await queryClient.invalidateQueries({ queryKey: ['generation-threads'] });
      toast.success('Chat renamed.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not rename this chat.');
    }
  };

  const clearPrivateChat = async () => {
    if (
      privateSession.messages.length ||
      privateSession.interruptedGenerations.length ||
      privateSession.draft
    ) {
      const confirmed = await confirmDialog({
        title: 'Delete this private chat?',
        message: 'This unsaved session and its recovery attempts will be removed from this tab.',
        confirmLabel: 'Delete chat',
        danger: true,
      });
      if (!confirmed) return;
    }
    clearPrivateSession();
    setChat(undefined);
    setActiveId(threads[0]?.id ?? '');
    toast.success('Private chat deleted.');
  };

  const deleteChat = async (thread: ThreadShelfChatSummary) => {
    const confirmed = await confirmDialog({
      title: `Delete “${thread.title}”?`,
      message: 'The conversation and its search index entries will be permanently removed.',
      confirmLabel: 'Delete chat',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.deleteGenerationThread(thread.id);
      const remaining = threads.filter((item) => item.id !== thread.id);
      setThreads(remaining);
      if (activeId === thread.id) {
        setChat(undefined);
        const nextId = remaining[0]?.id ?? '';
        setActiveId(nextId);
        void navigate({ to: '/chat', search: nextId ? { thread: nextId } : {} });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['collections'] }),
        queryClient.invalidateQueries({ queryKey: ['generation-threads'] }),
      ]);
      toast.success('Conversation deleted.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete this chat.');
    }
  };

  const refreshActive = useCallback(async () => {
    if (activeId === PRIVATE_SESSION_ID) return;
    try {
      const [updated] = await Promise.all([api.generationThread(activeId), loadList()]);
      setChat(updated);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'The chat was saved but could not refresh.',
      );
    }
  }, [activeId, loadList]);

  const isPrivate = activeId === PRIVATE_SESSION_ID;
  const isDraft = activeId === DRAFT_SAVED_ID;
  const messages = useMemo(
    () =>
      isPrivate
        ? [...privateSession.messages]
        : isDraft
          ? []
          : continuationFromTurns(chat?.turns ?? []),
    [chat?.turns, isDraft, isPrivate, privateSession.messages],
  );
  const title = isPrivate
    ? titleFromMessages(privateSession.messages)
    : isDraft
      ? 'New chat'
      : (chat?.title ?? 'Chat');

  return (
    <>
      <Topbar view="chat" activeColl={activeColl} onMenu={() => setSidebarOpen(true)} />
      <div className="main-scroll">
        <div className="chat-page">
          <main className="chat-workspace">
            {error && <div className="banner err">{error}</div>}
            {!activeId && !loading && (
              <div className="chat-empty">
                <span className="chat-empty-icon">{Icons.plus}</span>
                <h1>Start a new conversation</h1>
                <p>
                  Chats created here are separate from your imported archive. They stay local and
                  become searchable after each complete response.
                </p>
                <button className="btn primary" onClick={() => startSavedChat()}>
                  {Icons.plus} New chat
                </button>
              </div>
            )}
            {(isPrivate || isDraft || chat) && (
              <>
                <header className="chat-hero">
                  <div className="chat-title-row">
                    {editingTitle && chat ? (
                      <input
                        id="chatTitleInput"
                        className="chat-title-input"
                        aria-label="Chat title"
                        autoFocus
                        value={titleDraft}
                        onChange={(event) => setTitleDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void saveRename();
                          } else if (event.key === 'Escape') {
                            setEditingTitle(false);
                          }
                        }}
                        onBlur={() => void saveRename()}
                      />
                    ) : (
                      <h1
                        title={chat ? 'Double-click to rename' : title}
                        onDoubleClick={chat ? startRename : undefined}
                      >
                        {title}
                      </h1>
                    )}
                    {isPrivate ? (
                      <span className="chat-storage-badge private">{Icons.ghost} Private</span>
                    ) : (
                      <span
                        className="chat-storage-badge saved"
                        title="Stored locally and indexed for search"
                      >
                        Saved locally
                      </span>
                    )}
                  </div>
                  <div className="chat-hero-actions">
                    <span className="chat-storage-status">
                      {isPrivate
                        ? 'Not saved or indexed · removed on reload or when this tab closes'
                        : isDraft
                          ? 'Not saved yet · a chat is created on your first message'
                          : chat?.updatedAt
                            ? `Updated ${fmtRelative(chat.updatedAt) || 'just now'}`
                            : 'Saved locally by default'}
                    </span>
                    {isPrivate ? (
                      <div className="saved-chat-actions">
                        <button className="btn sm ghost" onClick={() => void clearPrivateChat()}>
                          {Icons.trash} Delete
                        </button>
                      </div>
                    ) : (
                      chat && (
                        <div className="saved-chat-actions">
                          <button
                            id="renameChatButton"
                            className="btn sm ghost"
                            onClick={startRename}
                          >
                            Rename
                          </button>
                          <button className="btn sm ghost" onClick={() => void deleteChat(chat)}>
                            {Icons.trash} Delete
                          </button>
                        </div>
                      )
                    )}
                  </div>
                </header>
                <div className="chat-conversation">
                  <ThreadContinuation
                    key={
                      isPrivate
                        ? privateSession.id
                        : isDraft
                          ? `draft:${draftAttemptScope}`
                          : chat!.id
                    }
                    threadId={isPrivate || isDraft ? undefined : chat!.id}
                    attemptScope={
                      isPrivate
                        ? privateSession.id
                        : isDraft
                          ? `draft:${draftAttemptScope}`
                          : chat!.id
                    }
                    ephemeral={isPrivate}
                    draftSaved={isDraft}
                    onCreateThread={isDraft ? handleCreateDraftThread : undefined}
                    initialMessages={messages}
                    onMessagesChanged={isPrivate ? setPrivateMessages : undefined}
                    onCompleted={
                      isPrivate
                        ? undefined
                        : isDraft
                          ? () => void handleDraftCompleted()
                          : () => void refreshActive()
                    }
                  />
                </div>
              </>
            )}
          </main>
        </div>
      </div>
    </>
  );
}
