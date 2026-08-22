import type { ThreadTurn } from './types';

const SKIP = /(?:users|projects|user|message_feedback|shared_conversations|sora)\.json$/i;

export const collLabel = (c: string): string => {
  if (c === 'all' || c === '__all__') return 'All collections';
  if (c === 'chunks') return 'Chunks';
  if (c === 'threadshelf_conversations') return 'ThreadShelf conversations';
  return c;
};

export const shortPath = (p: string): string => {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : p;
};

export const fmtModel = (m: string | undefined): string => {
  if (!m) return '';
  const value = String(m).replace(/^models\//, '');
  if (/^[a-z]:[\\/]/i.test(value) || value.startsWith('/') || value.includes('\\')) {
    const pathParts = value.replace(/\\/g, '/').split('/');
    return pathParts[pathParts.length - 1]!.replace(/\.gguf$/i, '');
  }
  return value;
};

const middleEllipsis = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value;
  const available = Math.max(2, maxLength - 1);
  const start = Math.ceil(available * 0.42);
  return `${value.slice(0, start)}…${value.slice(-(available - start))}`;
};

export const compactPath = (value: string | undefined, maxLength = 25): string => {
  if (!value) return '';
  const normalized = value.replace(/\//g, '\\');
  if (normalized.length <= maxLength) return normalized;
  const root = /^[A-Za-z]:\\/.exec(normalized)?.[0] ?? '';
  const parts = normalized.split('\\').filter(Boolean);
  const leaf = parts[parts.length - 1] ?? normalized;
  return middleEllipsis(`${root}…\\${leaf}`, maxLength);
};

export const compactModel = (value: string | undefined, maxLength = 30): string => {
  if (!value) return '';
  const parts = value.replace(/^models\//, '').split(/[\\/]/);
  const leaf = parts[parts.length - 1] || value;
  return middleEllipsis(leaf.replace(/\.gguf$/i, ''), maxLength);
};

export const fmtTime = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

export const fmtDate = (value: string | undefined): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
};

/**
 * Same instant as `fmtDate`, minus the seconds. List rows repeat this value on
 * every card, where `:00` at the end is pure noise.
 */
export const fmtDateShort = (value: string | undefined): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
};

export const fmtRelative = (value: string | undefined, now: number = Date.now()): string => {
  if (!value) return '';
  const date = new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return '';
  const diff = now - ms;
  if (diff < 45_000) return 'just now';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(diff / 86_400_000);
  if (days < 7) return `${days} d ago`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
};

export const escapeRegex = (s: string): string => {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

export const queryHighlightRegex = (query: string): RegExp | null => {
  const words = query
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((word) => word.length >= 3);
  const unique = [...new Set(words.map((word) => word.toLocaleLowerCase()))];
  if (!unique.length) {
    // All words too short (e.g. "AI"): highlight the whole phrase instead of nothing.
    const phrase = query.trim();
    return phrase ? new RegExp(`(${escapeRegex(phrase)})`, 'iu') : null;
  }
  return new RegExp(`(${unique.map(escapeRegex).join('|')})`, 'iu');
};

export const splitHighlightedText = (text: string, query: string): string[] => {
  const regex = queryHighlightRegex(query);
  return regex ? text.split(regex).filter((part) => part.length > 0) : [text];
};

export const isPotentialExport = (path: string): boolean => {
  if (!path || SKIP.test(path)) return false;
  const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
  if (!name.toLowerCase().endsWith('.json') && /^file[-_]/i.test(name)) return false;
  return name.toLowerCase().endsWith('.json') || !name.includes('.');
};

/**
 * Build a "more like this" seed query from a chunk/turn text: collapsed
 * whitespace, truncated at a word boundary so the query stays URL- and
 * server-friendly while keeping enough signal for the embedding model.
 */
export const moreLikeThisQuery = (text: string, maxChars = 280): string => {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  const cut = collapsed.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).trim();
};

export const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

/**
 * Keep completed stream blocks immutable so browser text selections survive
 * subsequent tokens. Only the final block is ever extended.
 */
export const appendStableStreamChunk = (
  chunks: readonly string[],
  delta: string,
  blockSize = 96,
): string[] => {
  if (!delta) return [...chunks];
  const size = Math.max(1, blockSize);
  const next = [...chunks];
  let remaining = delta;
  const lastIndex = next.length - 1;
  if (lastIndex >= 0 && next[lastIndex]!.length < size) {
    const available = size - next[lastIndex]!.length;
    next[lastIndex] = `${next[lastIndex]}${remaining.slice(0, available)}`;
    remaining = remaining.slice(available);
  }
  while (remaining) {
    next.push(remaining.slice(0, size));
    remaining = remaining.slice(size);
  }
  return next;
};

const turnRole = (t: ThreadTurn): 'user' | 'thinking' | 'ai' => {
  if (t.user !== undefined) return 'user';
  if (t.thinking !== undefined) return 'thinking';
  return 'ai';
};

const turnText = (t: ThreadTurn): string => t.user ?? t.thinking ?? t.ai ?? '';

const MD_HEADING = { user: '### 🧑 User', thinking: '### 💭 Reasoning', ai: '### 🤖 Response' };

/** Render a thread as portable Markdown for export / sharing. */
export const buildThreadMarkdown = (
  title: string,
  turns: readonly ThreadTurn[],
  meta?: { readonly model?: string; readonly sourceFile?: string; readonly collection?: string },
): string => {
  const lines: string[] = [`# ${title || 'Conversation'}`, ''];

  const facts: string[] = [];
  if (meta?.model) facts.push(`**Model:** ${fmtModel(meta.model)}`);
  facts.push(`**Turns:** ${turns.length}`);
  if (meta?.collection) facts.push(`**Collection:** ${meta.collection}`);
  if (meta?.sourceFile) facts.push(`**Source:** \`${meta.sourceFile}\``);
  if (facts.length) {
    lines.push(facts.join('  ·  '), '', '---', '');
  }

  for (const t of turns) {
    const role = turnRole(t);
    lines.push(MD_HEADING[role]);
    if (fmtDate(t.createdAt)) lines.push(`*${fmtDate(t.createdAt)}*`, '');
    else lines.push('');
    lines.push(turnText(t).trim(), '');
  }

  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  );
};

export const slugify = (s: string): string =>
  (s || 'conversation')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'conversation';

/** Trigger a client-side file download from a string. */
export const downloadFile = (
  filename: string,
  content: string,
  mime = 'text/markdown;charset=utf-8',
): void => {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

/** Byte sizes for model files: GB once past a gigabyte, MB below it. */
export const fmtBytes = (bytes: number | undefined): string => {
  if (!bytes || bytes <= 0) return '—';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
};

/** Download counts in the compact form catalogs use: 12.4M, 58k, 940. */
export const fmtCount = (value: number | undefined): string => {
  if (!value || value <= 0) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
};
