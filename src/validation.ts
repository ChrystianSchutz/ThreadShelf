export class ValidationError extends Error {
  readonly field?: string;

  constructor(message: string, { field }: { field?: string } = {}) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

const COLLECTION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const RESERVED_COLLECTIONS = new Set(['all']);
const PROTECTED_COLLECTIONS = new Set(['all', 'chunks', 'threadshelf_conversations']);

export const MAX_QUERY_CHARS = 4000;
export const MAX_STRING_CHARS = 1_000_000;
export const MAX_SEARCH_N = 50;

export const normalizeCollectionName = (
  value: unknown,
  { field = 'collection' }: { field?: string } = {},
): string => {
  if (value === undefined || value === null) {
    throw new ValidationError(`Missing ${field}`, { field });
  }
  const slug = String(value)
    .trim()
    .replace(/[^a-z0-9_-]/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .toLowerCase()
    .slice(0, 63);
  if (!slug) {
    throw new ValidationError(`Invalid ${field}: empty after normalization`, { field });
  }
  if (!COLLECTION_PATTERN.test(slug)) {
    throw new ValidationError(`Invalid ${field}: must match ${COLLECTION_PATTERN}`, { field });
  }
  if (RESERVED_COLLECTIONS.has(slug)) {
    throw new ValidationError(`Reserved ${field}: ${slug}`, { field });
  }
  return slug;
};

export const normalizeCollectionSelector = (
  value: unknown,
  { defaultValue = 'chunks', field = 'collection' }: { defaultValue?: string; field?: string } = {},
): string => {
  if (value === undefined || value === null || value === '') return defaultValue;
  const raw = String(value).trim().toLowerCase();
  if (raw === 'all') return 'all';
  return normalizeCollectionName(raw, { field });
};

export const assertDeletableCollection = (name: unknown): string => {
  const normalized = normalizeCollectionName(name);
  if (PROTECTED_COLLECTIONS.has(normalized)) {
    throw new ValidationError(`Collection cannot be deleted: ${normalized}`, {
      field: 'collection',
    });
  }
  return normalized;
};

export const assertClearableCollection = (name: unknown): string => {
  const normalized = normalizeCollectionName(name);
  if (normalized === 'all' || normalized === 'threadshelf_conversations') {
    throw new ValidationError(`Collection cannot be cleared: ${normalized}`, {
      field: 'collection',
    });
  }
  return normalized;
};

export const normalizeQuery = (
  value: unknown,
  { field = 'q', maxLength = MAX_QUERY_CHARS }: { field?: string; maxLength?: number } = {},
): string => {
  if (value === undefined || value === null) {
    throw new ValidationError(`Missing ${field}`, { field });
  }
  if (typeof value !== 'string') {
    throw new ValidationError(`Invalid ${field}: must be a string`, { field });
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError(`Invalid ${field}: empty`, { field });
  }
  if (trimmed.length > maxLength) {
    throw new ValidationError(`Invalid ${field}: max ${maxLength} chars`, { field });
  }
  return trimmed;
};

export const normalizeCount = (
  value: unknown,
  {
    defaultValue,
    min = 1,
    max = MAX_SEARCH_N,
    field = 'n',
  }: { defaultValue?: number; min?: number; max?: number; field?: string } = {},
): number => {
  if (value === undefined || value === null || value === '') {
    if (defaultValue === undefined) {
      throw new ValidationError(`Missing ${field}`, { field });
    }
    return defaultValue;
  }
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new ValidationError(`Invalid ${field}: not a number`, { field });
  }
  if (!Number.isInteger(num)) {
    throw new ValidationError(`Invalid ${field}: must be an integer`, { field });
  }
  if (num < min) {
    throw new ValidationError(`Invalid ${field}: minimum ${min}`, { field });
  }
  if (num > max) {
    throw new ValidationError(`Invalid ${field}: maximum ${max}`, { field });
  }
  return num;
};

const ALLOWED_ROLES = new Set(['user', 'thinking', 'ai']);

export const normalizeRoles = (
  value: unknown,
  { field = 'roles' }: { field?: string } = {},
): string[] | null => {
  if (value === undefined || value === null || value === '') return null;
  let list: unknown[];
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === 'string') {
    list = value.split(',');
  } else {
    throw new ValidationError(`Invalid ${field}: must be string or array`, { field });
  }
  const normalized = list.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
  if (normalized.length === 0) return null;
  for (const role of normalized) {
    if (!ALLOWED_ROLES.has(role)) {
      throw new ValidationError(`Invalid ${field}: unknown role "${role}"`, { field });
    }
  }
  return [...new Set(normalized)];
};

export const normalizeOptionalString = (
  value: unknown,
  { field = 'value', maxLength = 200 }: { field?: string; maxLength?: number } = {},
): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError(`Invalid ${field}: must be a string`, { field });
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) {
    throw new ValidationError(`Invalid ${field}: max ${maxLength} chars`, { field });
  }
  return trimmed;
};

export const normalizeOptionalIsoDate = (
  value: unknown,
  { field = 'date', endOfDay = false }: { field?: string; endOfDay?: boolean } = {},
): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError(`Invalid ${field}: must be a string`, { field });
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : trimmed;
  const timestamp = Date.parse(normalized);
  if (Number.isNaN(timestamp)) {
    throw new ValidationError(`Invalid ${field}: must be an ISO-like date string`, { field });
  }
  return new Date(timestamp).toISOString();
};

export const normalizeDateRange = (
  fromValue: unknown,
  toValue: unknown,
): { readonly from?: string; readonly to?: string } => {
  const from = normalizeOptionalIsoDate(fromValue, { field: 'from' });
  const to = normalizeOptionalIsoDate(toValue, { field: 'to', endOfDay: true });
  if (from && to && from > to) {
    throw new ValidationError('Invalid date range: from must be before to', { field: 'from' });
  }
  return { from, to };
};

export type SearchMode = 'semantic' | 'keyword';

export const normalizeSearchMode = (
  value: unknown,
  { field = 'mode' }: { field?: string } = {},
): SearchMode => {
  if (value === undefined || value === null || value === '') return 'semantic';
  const mode = String(value).trim().toLowerCase();
  if (mode === 'semantic' || mode === 'keyword') return mode;
  throw new ValidationError(`Invalid ${field}: expected "semantic" or "keyword"`, { field });
};

export const normalizeBoolean = (
  value: unknown,
  { defaultValue = false, field = 'flag' }: { defaultValue?: boolean; field?: string } = {},
): boolean => {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
  }
  throw new ValidationError(`Invalid ${field}: expected boolean`, { field });
};

export interface NormalizedTurn {
  readonly role: string;
  readonly text: string;
  readonly model?: string;
  readonly createdAt?: string;
}

export interface Turn {
  readonly user?: string;
  readonly thinking?: string;
  readonly ai?: string;
  readonly model?: string;
  readonly createdAt?: string;
  readonly createdInThreadShelf?: boolean;
  readonly generationProvider?: 'llama-cpp' | 'openrouter' | 'strata';
}

export const validateTurn = (turn: unknown, { index }: { index?: number } = {}): NormalizedTurn => {
  if (!turn || typeof turn !== 'object' || Array.isArray(turn)) {
    throw new ValidationError(`Invalid turn at index ${index}: must be an object`);
  }
  const t = turn as Record<string, unknown>;
  const roleKeys = (['user', 'thinking', 'ai'] as const).filter((key) => t[key] !== undefined);
  if (roleKeys.length !== 1) {
    throw new ValidationError(
      `Invalid turn at index ${index}: must have exactly one of user/thinking/ai (had ${roleKeys.join(', ') || 'none'})`,
    );
  }
  const role = roleKeys[0]!;
  if (typeof t[role] !== 'string') {
    throw new ValidationError(`Invalid turn at index ${index}: ${role} must be a string`);
  }
  if ((t[role] as string).length === 0) {
    throw new ValidationError(`Invalid turn at index ${index}: ${role} must not be empty`);
  }
  if (t.model !== undefined && (typeof t.model !== 'string' || !(t.model as string).trim())) {
    throw new ValidationError(
      `Invalid turn at index ${index}: model must be a non-empty string when present`,
    );
  }
  if (
    t.createdAt !== undefined &&
    (typeof t.createdAt !== 'string' || Number.isNaN(Date.parse(t.createdAt as string)))
  ) {
    throw new ValidationError(
      `Invalid turn at index ${index}: createdAt must be an ISO-like date string when present`,
    );
  }
  if (t.createdInThreadShelf !== undefined && typeof t.createdInThreadShelf !== 'boolean') {
    throw new ValidationError(
      `Invalid turn at index ${index}: createdInThreadShelf must be a boolean when present`,
    );
  }
  if (
    t.generationProvider !== undefined &&
    !['llama-cpp', 'openrouter', 'strata'].includes(String(t.generationProvider))
  ) {
    throw new ValidationError(
      `Invalid turn at index ${index}: generationProvider must be llama-cpp, openrouter or strata`,
    );
  }
  const normalized: NormalizedTurn = {
    role,
    text: t[role] as string,
    model: t.model as string | undefined,
  };
  if (t.createdAt !== undefined) {
    return { ...normalized, createdAt: t.createdAt as string };
  }
  return normalized;
};

export const validateTurns = (turns: unknown): Turn[] => {
  if (!Array.isArray(turns)) {
    throw new ValidationError('Invalid turns: expected an array');
  }
  turns.forEach((turn, index) => validateTurn(turn, { index }));
  return turns as Turn[];
};

export const isSafeRelativePath = (input: unknown): boolean => {
  if (typeof input !== 'string' || input.length === 0) return false;
  if (input.length > 1024) return false;
  if (input.includes('\0')) return false;
  const normalized = input.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(normalized)) return false;
  const segments = normalized.split('/');
  return segments.every((segment) => segment !== '..' && segment.length <= 255);
};
