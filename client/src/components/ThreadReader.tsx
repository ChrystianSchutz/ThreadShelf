import { useState, useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ThreadTurn, RoleFilters } from '../types';
import { Icons } from '../icons';
import { SidebarToggle } from './SidebarToggle';
import { getProvider } from '../constants';
import {
  collLabel,
  shortPath,
  fmtModel,
  compactModel,
  fmtDate,
  copyText,
  queryHighlightRegex,
  splitHighlightedText,
  buildThreadMarkdown,
  slugify,
  downloadFile,
} from '../utils';
import { toast, confirmDialog } from '../toast';
import { api } from '../api';
import { Markdown } from './Markdown';
import { ThreadContinuation } from './ThreadContinuation';

const THREADSHELF_CHAT_PREFIX = 'threadshelf://chat/';

interface ThreadReaderProps {
  readonly sourceFile: string;
  readonly collection: string;
  readonly conversationKey?: string;
  readonly title?: string;
  readonly matchIdx?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly onBack: () => void;
  readonly onMenu: () => void;
  readonly query: string;
  readonly onSimilar?: (text: string) => void;
}

const COLLAPSE_AT = 1800;

function formatCount(n: number): string {
  return n.toLocaleString();
}

function CopyBtn({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    void copyText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <button className="copy-turn" onClick={handleCopy}>
      {copied ? 'copied' : 'copy'}
    </button>
  );
}

function Highlighted({ text, q }: { readonly text: string; readonly q: string }) {
  const regex = queryHighlightRegex(q);
  if (!regex) return <>{text}</>;
  return (
    <>
      {splitHighlightedText(text, q).map((p, i) =>
        regex.test(p) ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>,
      )}
    </>
  );
}

function getTurnRole(turn: ThreadTurn): 'user' | 'thinking' | 'ai' {
  if (turn.user !== undefined) return 'user';
  if (turn.thinking !== undefined) return 'thinking';
  return 'ai';
}

function getTurnText(turn: ThreadTurn): string {
  return turn.user ?? turn.thinking ?? turn.ai ?? '';
}

export function ThreadReader({
  sourceFile,
  collection,
  conversationKey,
  title: initialTitle,
  matchIdx,
  provider: providerKey,
  model: modelName,
  onBack,
  onMenu,
  query,
  onSimilar,
}: ThreadReaderProps) {
  const [turns, setTurns] = useState<ThreadTurn[] | null>(null);
  const [createdInThreadShelf, setCreatedInThreadShelf] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState<RoleFilters>({ user: true, thinking: false, ai: true });
  const [showThreadShelfTurns, setShowThreadShelfTurns] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const innerRef = useRef<HTMLDivElement>(null);
  const matchedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const resetId = window.setTimeout(() => {
      setTurns(null);
      setCreatedInThreadShelf(false);
      setError(null);
      setExpanded(new Set());
    }, 0);

    const col = collection === '__all__' ? 'all' : collection;
    const controller = new AbortController();

    void api
      .thread(sourceFile, col, conversationKey, controller.signal)
      .then((d) => {
        setTurns(d.turns);
        setCreatedInThreadShelf(d.createdInThreadShelf);
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : 'Unknown error');
      });

    return () => {
      window.clearTimeout(resetId);
      controller.abort();
    };
  }, [sourceFile, collection, conversationKey]);

  // Auto-open the thinking filter when the match is a reasoning turn. Kept
  // separate from the fetch effect so jumping between matches in the same
  // thread does not reset and refetch it.
  useEffect(() => {
    if (!turns || matchIdx == null) return undefined;
    const matchedTurn = turns[Number(matchIdx)];
    if (!matchedTurn || getTurnRole(matchedTurn) !== 'thinking') return undefined;
    const id = window.setTimeout(() => {
      setVisible((v) => (v.thinking ? v : { ...v, thinking: true }));
    }, 0);
    return () => window.clearTimeout(id);
  }, [turns, matchIdx]);

  useEffect(() => {
    if (matchedRef.current && innerRef.current) {
      const top = matchedRef.current.offsetTop - 140;
      innerRef.current.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  }, [turns]);

  const toggleRole = (r: keyof RoleFilters) => setVisible((v) => ({ ...v, [r]: !v[r] }));

  const toggleExpand = (i: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const jumpMatch = useCallback(() => {
    if (matchedRef.current && innerRef.current) {
      innerRef.current.scrollTo({
        top: Math.max(0, matchedRef.current.offsetTop - 140),
        behavior: 'smooth',
      });
    }
  }, []);

  const copyThread = useCallback(() => {
    if (!turns) return;
    const text = turns
      .map((t) => {
        const role = getTurnRole(t);
        const label = { user: 'User', thinking: 'Thinking', ai: 'Response' }[role];
        return `${label}:\n${getTurnText(t).trim()}`;
      })
      .filter(Boolean)
      .join('\n\n');
    void copyText(text).then((ok) =>
      ok ? toast.success('Conversation copied.') : toast.error('Clipboard unavailable.'),
    );
  }, [turns]);

  const copyMatched = useCallback(() => {
    if (turns && matchIdx != null) {
      const t = turns[matchIdx];
      if (t) void copyText(getTurnText(t));
    }
  }, [turns, matchIdx]);

  const conversationStats = turns
    ? turns.reduce(
        (acc, turn) => {
          const text = getTurnText(turn);
          acc.chars += text.length;
          acc.words += text.trim() ? text.trim().split(/\s+/).length : 0;
          return acc;
        },
        { chars: 0, words: 0 },
      )
    : { chars: 0, words: 0 };

  let title = initialTitle?.trim() || shortPath(sourceFile);
  if (turns && !initialTitle?.trim()) {
    const first = turns.find((t) => t.user !== undefined);
    if (first) {
      const txt = (first.user ?? '').trim();
      title = txt.length > 80 ? `${txt.slice(0, 77)}…` : txt || title;
    }
  }

  const queryClient = useQueryClient();
  const provColor = getProvider(providerKey).color;
  const detectedModel =
    fmtModel(modelName) || (turns ? fmtModel(turns.find((t) => t.model)?.model) : '');

  // A ThreadShelf-created conversation is addressable by its chat id, so it can
  // be deleted straight from search, not only from the Chats view.
  const threadShelfChatId = createdInThreadShelf
    ? conversationKey || sourceFile.replace(THREADSHELF_CHAT_PREFIX, '')
    : '';

  const deleteThreadShelfChat = async () => {
    if (!threadShelfChatId) return;
    const confirmed = await confirmDialog({
      title: `Delete “${title}”?`,
      message: 'The conversation and its search index entries will be permanently removed.',
      confirmLabel: 'Delete chat',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.deleteGenerationThread(threadShelfChatId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['collections'] }),
        queryClient.invalidateQueries({ queryKey: ['files'] }),
        queryClient.invalidateQueries({ queryKey: ['search'] }),
      ]);
      toast.success('Conversation deleted.');
      onBack();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Could not delete this chat.');
    }
  };

  const exportMarkdown = () => {
    if (!turns) return;
    const md = buildThreadMarkdown(title, turns, {
      model: detectedModel || modelName,
      sourceFile,
      collection: collLabel(collection),
    });
    downloadFile(`${slugify(title)}.md`, md);
    toast.success('Exported as Markdown.');
  };

  const exportJson = () => {
    if (!turns) return;
    const portableTurns = turns.map((turn) =>
      turn.model ? { ...turn, model: fmtModel(turn.model) } : turn,
    );
    const payload = {
      title,
      sourceFile,
      collection,
      conversationKey: conversationKey || undefined,
      model: detectedModel || modelName || undefined,
      exportedAt: new Date().toISOString(),
      turns: portableTurns,
    };
    downloadFile(
      `${slugify(title)}.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8',
    );
    toast.success('Exported as JSON.');
  };

  return (
    <div
      id="threadOverlay"
      className="thread"
      style={{ '--provider-color': provColor } as React.CSSProperties}
    >
      <div className="thread-bar">
        <SidebarToggle onMenu={onMenu} />
        <button id="threadClose" className="thread-back" onClick={onBack} title="Esc">
          {Icons.arrowLeft}
          <span>Back</span>
        </button>
        <span className="title-preview" title={title}>
          {turns ? title : 'Loading…'}
        </span>
        {detectedModel && (
          <span className="bar-meta">
            <span className="pdot" style={{ background: provColor }} />
            <span className="bar-model">{detectedModel}</span>
          </span>
        )}
        <span className="path-crumb" title={sourceFile}>
          <span className="coll">{collLabel(collection)}</span>
          <span className="sl">/</span>
          <span>{shortPath(sourceFile)}</span>
        </span>
        <kbd>Esc</kbd>
      </div>

      {error && (
        <div className="banner err" style={{ margin: 16 }}>
          <span className="ico">{Icons.warn}</span>
          <div className="grow">{error}</div>
        </div>
      )}

      {turns && (
        <div id="threadContent" className="thread-inner" ref={innerRef}>
          <div className="thread-hero">
            <h1>{title}</h1>
            <div className="meta-row">
              {detectedModel && (
                <>
                  <span className="item">
                    <span className="k">model</span>
                    <span className="v">{detectedModel}</span>
                  </span>
                  <span className="sep">·</span>
                </>
              )}
              <span className="item">
                <span className="k">turns</span>
                <span className="v">{turns.length}</span>
              </span>
              <span className="sep">·</span>
              <span className="item">
                <span className="k">length</span>
                <span className="v">{formatCount(conversationStats.words)} words</span>
              </span>
              <span className="sep">·</span>
              <span className="item">
                <span className="k">chars</span>
                <span className="v">{formatCount(conversationStats.chars)}</span>
              </span>
              <span className="sep">·</span>
              <span className="item">
                <span className="k">file</span>
                <span className="v">{shortPath(sourceFile)}</span>
              </span>
              {matchIdx != null && (
                <>
                  <span className="sep">·</span>
                  <span className="item">
                    <span className="k">match</span>
                    <span className="v match">turn #{matchIdx}</span>
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="thread-actions-bar">
            {matchIdx != null && (
              <button className="btn sm" onClick={jumpMatch}>
                {Icons.zap} Jump to match
              </button>
            )}
            <button className="btn sm" onClick={copyThread}>
              {Icons.copy} Copy conversation
            </button>
            <button className="btn sm" onClick={exportMarkdown}>
              {Icons.download} Export .md
            </button>
            <button className="btn sm" onClick={exportJson}>
              {Icons.download} Export .json
            </button>
            {matchIdx != null && (
              <button className="btn sm ghost" onClick={copyMatched}>
                {Icons.copy} Copy matched turn
              </button>
            )}
            {threadShelfChatId && (
              <button
                id="deleteThreadShelfChat"
                className="btn sm ghost danger"
                onClick={() => void deleteThreadShelfChat()}
              >
                {Icons.trash} Delete chat
              </button>
            )}
            <span style={{ flex: 1 }} />
            <div className="role-toggles" role="group">
              {[
                { id: 'user' as const, label: 'User' },
                { id: 'thinking' as const, label: 'Reasoning' },
                { id: 'ai' as const, label: 'Response' },
              ].map((r) => (
                <label key={r.id} className="role-toggle" data-role={r.id} data-on={visible[r.id]}>
                  <input
                    type="checkbox"
                    checked={visible[r.id]}
                    onChange={() => toggleRole(r.id)}
                  />
                  <span className="rt-dot" />
                  <span>{r.label}</span>
                </label>
              ))}
              {!createdInThreadShelf && turns.some((turn) => turn.createdInThreadShelf) && (
                <label
                  className="role-toggle"
                  data-role="threadshelf"
                  data-on={showThreadShelfTurns}
                  title="Turns generated locally in ThreadShelf as continuations of this imported thread"
                >
                  <input
                    type="checkbox"
                    checked={showThreadShelfTurns}
                    onChange={(event) => setShowThreadShelfTurns(event.target.checked)}
                  />
                  <span className="rt-dot" />
                  <span>Continuations</span>
                </label>
              )}
            </div>
          </div>

          <div className="thread-body">
            {turns.map((turn, i) => {
              const role = getTurnRole(turn);
              const text = getTurnText(turn);
              const isMatch = matchIdx != null && i === Number(matchIdx);
              const isReasoning = role === 'thinking';
              const isLong = text.length > COLLAPSE_AT;
              const isLongOpen = expanded.has(i) || isMatch;

              if (!showThreadShelfTurns && turn.createdInThreadShelf) return null;
              if (!visible[role] && !isReasoning) return null;

              if (!visible[role] && isReasoning) {
                const isOpen = expanded.has(i);
                return (
                  <div key={i} className="turn turn-stub" data-role="thinking">
                    <button
                      className="reasoning-stub"
                      data-open={isOpen}
                      onClick={() => toggleExpand(i)}
                    >
                      <span className="rs-r">R</span>
                      <span className="rs-label">reasoning</span>
                      <span className="rs-idx">#{i}</span>
                      <span className="rs-chevron">{isOpen ? '−' : '+'}</span>
                    </button>
                    {isOpen && <div className="reasoning-stub-body">{text}</div>}
                  </div>
                );
              }

              const initial = { user: 'U', thinking: 'R', ai: 'A' }[role];
              const roleTag = { user: 'user', thinking: 'reasoning', ai: 'response' }[role];

              return (
                <div
                  key={i}
                  ref={isMatch ? matchedRef : null}
                  className="turn"
                  data-role={role}
                  data-matched={isMatch}
                  data-origin={turn.createdInThreadShelf ? 'threadshelf' : 'archive'}
                >
                  <div className="turn-avatar" title={roleTag}>
                    {initial}
                  </div>
                  <div className="turn-content">
                    <div className="turn-head">
                      <span className="role-tag">{roleTag}</span>
                      <span className="turn-idx">#{i}</span>
                      {role === 'ai' && fmtModel(turn.model) && (
                        <span className="turn-model" title={turn.model}>
                          {compactModel(turn.model)}
                        </span>
                      )}
                      {turn.createdInThreadShelf && !createdInThreadShelf && (
                        <span className="threadshelf-turn-badge">ThreadShelf</span>
                      )}
                      {fmtDate(turn.createdAt) && (
                        <time className="turn-date" dateTime={turn.createdAt}>
                          {fmtDate(turn.createdAt)}
                        </time>
                      )}
                      {isMatch ? (
                        <span className="match-pill">● match</span>
                      ) : (
                        <CopyBtn text={text} />
                      )}
                      {onSimilar && (
                        <button
                          className="copy-turn"
                          title="Search for similar passages"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSimilar(text);
                          }}
                        >
                          similar
                        </button>
                      )}
                    </div>
                    <div className="turn-body" data-collapsed={isLong && !isLongOpen}>
                      {isMatch ? (
                        // The search match keeps raw text so hits can be highlighted.
                        <Highlighted text={text} q={query} />
                      ) : role === 'ai' ? (
                        <Markdown text={text} />
                      ) : (
                        text
                      )}
                    </div>
                    {isLong && (
                      <button className="show-more" onClick={() => toggleExpand(i)}>
                        {isLongOpen ? 'Show less' : 'Show more'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            <ThreadContinuation
              sourceFile={sourceFile}
              collection={collection}
              conversationKey={conversationKey}
              showThreadShelfTurns={showThreadShelfTurns}
            />

            <div className="thread-end" aria-hidden="true">
              <span className="dot" />
              <span>End of conversation</span>
              <span className="dot" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
