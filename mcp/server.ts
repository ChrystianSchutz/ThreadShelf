#!/usr/bin/env tsx
import { createInterface } from 'readline';
import { searchAcrossCollections } from '../src/services/search.js';
import { loadThread } from '../src/services/thread.js';
import { getAllCollections } from '../src/services/collections.js';
import { getStatsForCollection } from '../src/services/stats.js';
import { listSourceFilesInCollection } from '../src/store.js';
import { recoverPendingIndexes, startIndexRecovery } from '../src/store.js';
import {
  ValidationError,
  normalizeCollectionSelector,
  normalizeCollectionName,
  normalizeQuery,
  normalizeCount,
  normalizeRoles,
  normalizeBoolean,
  normalizeOptionalString,
  normalizeDateRange,
  normalizeSearchMode,
} from '../src/validation.js';
import { createRequire } from 'node:module';
import { packagePath } from '../src/paths.js';

// Read at runtime rather than `import ... with { type: 'json' }`: a JSON import
// makes tsc copy package.json into dist/, which would shadow the real package
// root when resolving bundled assets.
const pkg = createRequire(import.meta.url)(packagePath('package.json')) as { version: string };

const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', DEFAULT_PROTOCOL_VERSION] as const;
const SERVER_INFO = { name: 'threadshelf-mcp', version: pkg.version };

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'list_collections',
    description: 'List all LanceDB collections discovered locally.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_files',
    description: 'List unique source files indexed inside a collection.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: {
          type: 'string',
          description:
            'Collection name. Use "all" to list across every collection. Defaults to "all".',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_stats',
    description:
      'Return chunk, file, role, and per-collection stats for a collection or all collections.',
    inputSchema: {
      type: 'object',
      properties: {
        collection: {
          type: 'string',
          description:
            'Collection name. Use "all" to aggregate every collection. Defaults to "all".',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description:
      'Semantic search over the chosen collection. Returns ranked text snippets with source metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language query (any language).' },
        collection: { type: 'string', description: 'Collection name or "all". Defaults to "all".' },
        n: { type: 'integer', description: 'Max results (1-50). Default 15.' },
        roles: {
          type: 'array',
          items: { type: 'string', enum: ['user', 'thinking', 'ai'] },
          description: 'Restrict to a subset of roles.',
        },
        keywordBoost: {
          type: 'boolean',
          description: 'When true, re-rank so chunks containing the exact query text appear first.',
        },
        mode: {
          type: 'string',
          enum: ['semantic', 'keyword'],
          description:
            'Search mode. "semantic" (default) ranks by embedding similarity; "keyword" returns exact case-insensitive substring matches (best for identifiers, error strings, code).',
        },
        model: { type: 'string', description: 'Restrict results to models containing this text.' },
        from: { type: 'string', description: 'Inclusive ISO date or YYYY-MM-DD lower bound.' },
        to: { type: 'string', description: 'Inclusive ISO date or YYYY-MM-DD upper bound.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_thread',
    description: 'Load and parse a full export file, returning the normalized turn array.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceFile: { type: 'string', description: 'Absolute path to an indexed export file.' },
        collection: {
          type: 'string',
          description:
            'Restrict the lookup to a specific collection (or "all"). Defaults to "all".',
        },
        conversationKey: {
          type: 'string',
          description: 'Conversation key returned by search for multi-conversation export files.',
        },
      },
      required: ['sourceFile'],
      additionalProperties: false,
    },
  },
];

interface ResourceTemplate {
  readonly uriTemplate: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

const RESOURCE_TEMPLATES: ResourceTemplate[] = [
  {
    uriTemplate: 'threadshelf://collections',
    name: 'collections',
    description: 'JSON list of all collections.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'threadshelf://collections/{collection}/files',
    name: 'collection-files',
    description: 'JSON list of indexed source files within a collection.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'threadshelf://thread?path={absolutePath}',
    name: 'thread',
    description: 'Parsed turn-by-turn thread for an indexed source file.',
    mimeType: 'application/json',
  },
];

const ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const jsonRpcResult = (id: number | string | null | undefined, result: unknown): string => {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
};

const jsonRpcError = (
  id: number | string | null | undefined,
  code: number,
  message: string,
  data?: unknown,
): string => {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return JSON.stringify({ jsonrpc: '2.0', id, error });
};

const writeMessage = (payload: string): void => {
  process.stdout.write(`${payload}\n`);
};

const asTextContent = (value: unknown): Array<{ type: string; text: string }> => {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return [{ type: 'text', text }];
};

const toolListFiles = async (args: Record<string, unknown> = {}): Promise<unknown> => {
  const collection = normalizeCollectionSelector(args.collection, { defaultValue: 'all' });
  if (collection === 'all') {
    const collections = await getAllCollections();
    return Promise.all(
      collections.map(async (name) => ({
        collection: name,
        files: await listSourceFilesInCollection(name),
      })),
    );
  }
  const files = await listSourceFilesInCollection(collection);
  return { collection, files };
};

const toolGetStats = async (args: Record<string, unknown> = {}): Promise<unknown> => {
  const collection = normalizeCollectionSelector(args.collection, { defaultValue: 'all' });
  return getStatsForCollection(collection);
};

const toolSearch = async (args: Record<string, unknown> = {}): Promise<unknown> => {
  const query = normalizeQuery(args.query, { field: 'query' });
  const collection = normalizeCollectionSelector(args.collection, { defaultValue: 'all' });
  const n = normalizeCount(args.n, { defaultValue: 15 });
  const roles = normalizeRoles(args.roles);
  const keywordBoost = normalizeBoolean(args.keywordBoost, { field: 'keywordBoost' });
  const model = normalizeOptionalString(args.model, { field: 'model' });
  const { from, to } = normalizeDateRange(args.from, args.to);
  const mode = normalizeSearchMode(args.mode);

  // Bounded catch-up; failed jobs keep their backoff and never re-embed per query.
  await recoverPendingIndexes({ collection });
  const results = await searchAcrossCollections(query, collection, {
    n,
    roles: roles ?? undefined,
    keywordBoost,
    model,
    from,
    to,
    mode,
  });
  return { collection, results };
};

const toolReadThread = async (args: Record<string, unknown> = {}): Promise<unknown> => {
  if (!args || typeof args.sourceFile !== 'string' || !args.sourceFile.trim()) {
    throw new ValidationError('Missing sourceFile', { field: 'sourceFile' });
  }
  const sourceFile = args.sourceFile;
  if (sourceFile.length > 4096 || sourceFile.includes('\0')) {
    throw new ValidationError('Invalid sourceFile', { field: 'sourceFile' });
  }
  const collection = normalizeCollectionSelector(args.collection, { defaultValue: 'all' });
  let conversationKey: string | undefined;
  if (args.conversationKey !== undefined && args.conversationKey !== null) {
    if (
      typeof args.conversationKey !== 'string' ||
      args.conversationKey.length > 4096 ||
      args.conversationKey.includes('\0')
    ) {
      throw new ValidationError('Invalid conversationKey', { field: 'conversationKey' });
    }
    conversationKey = args.conversationKey || undefined;
  }
  return loadThread(sourceFile, collection, conversationKey);
};

interface ParsedResourceUri {
  kind: 'collections' | 'files' | 'thread';
  collection?: string;
  path?: string;
}

const parseResourceUri = (uri: string): ParsedResourceUri | null => {
  const match = /^threadshelf:\/\/(.+)$/.exec(uri || '');
  if (!match) return null;
  const rest = match[1]!;

  if (rest === 'collections') return { kind: 'collections' };

  const filesMatch = /^collections\/([^/]+)\/files$/.exec(rest);
  if (filesMatch) return { kind: 'files', collection: decodeURIComponent(filesMatch[1]!) };

  if (rest.startsWith('thread')) {
    const query = rest.split('?')[1] || '';
    const params = new URLSearchParams(query);
    const path = params.get('path');
    if (!path) return null;
    return { kind: 'thread', path };
  }
  return null;
};

const readResource = async (
  uri: string,
): Promise<{ uri: string; mimeType: string; text: string }> => {
  const parsed = parseResourceUri(uri);
  if (!parsed) throw new ValidationError(`Unknown resource URI: ${uri}`, { field: 'uri' });

  if (parsed.kind === 'collections') {
    const collections = await getAllCollections();
    return { uri, mimeType: 'application/json', text: JSON.stringify(collections) };
  }
  if (parsed.kind === 'files') {
    const collection = normalizeCollectionName(parsed.collection!);
    const files = await listSourceFilesInCollection(collection);
    return { uri, mimeType: 'application/json', text: JSON.stringify({ collection, files }) };
  }
  if (parsed.kind === 'thread') {
    const thread = await loadThread(parsed.path!, 'all');
    return { uri, mimeType: 'application/json', text: JSON.stringify(thread) };
  }
  throw new ValidationError('Unsupported resource', { field: 'uri' });
};

type Handler = (params: Record<string, unknown>) => Promise<unknown>;

const HANDLERS: Record<string, Handler> = {
  async initialize(params = {}) {
    const requestedVersion =
      typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(
      requestedVersion as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number],
    )
      ? requestedVersion
      : DEFAULT_PROTOCOL_VERSION;

    return {
      protocolVersion,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: SERVER_INFO,
    };
  },
  async 'tools/list'() {
    return { tools: TOOL_DEFINITIONS };
  },
  async 'tools/call'(params) {
    const { name, arguments: args } = params as {
      name: string;
      arguments?: Record<string, unknown>;
    };
    try {
      let payload: unknown;
      switch (name) {
        case 'list_collections':
          payload = await getAllCollections();
          break;
        case 'list_files':
          payload = await toolListFiles(args ?? {});
          break;
        case 'get_stats':
          payload = await toolGetStats(args ?? {});
          break;
        case 'search':
          payload = await toolSearch(args ?? {});
          break;
        case 'read_thread':
          payload = await toolReadThread(args ?? {});
          break;
        default:
          throw new ValidationError(`Unknown tool: ${name}`, { field: 'name' });
      }
      return { content: asTextContent(payload), isError: false };
    } catch (e) {
      const message =
        e instanceof ValidationError ? e.message : `Tool failed: ${(e as Error).message}`;
      return { content: asTextContent({ error: message }), isError: true };
    }
  },
  async 'resources/list'() {
    return { resources: [], resourceTemplates: RESOURCE_TEMPLATES };
  },
  async 'resources/read'(params) {
    const { uri } = params as { uri: string };
    try {
      const contents = await readResource(uri);
      return { contents: [contents] };
    } catch (e) {
      throw e instanceof ValidationError
        ? e
        : new ValidationError(`Resource read failed: ${(e as Error).message}`, { field: 'uri' });
    }
  },
  async 'notifications/initialized'() {
    return null;
  },
  async ping() {
    return {};
  },
};

const handleMessage = async (message: JsonRpcMessage): Promise<void> => {
  if (message.jsonrpc !== '2.0') {
    if (message.id !== undefined) {
      writeMessage(jsonRpcError(message.id, ERROR_CODES.invalidRequest, 'Expected jsonrpc 2.0'));
    }
    return;
  }

  const handler = message.method ? HANDLERS[message.method] : undefined;
  const isNotification = message.id === undefined;

  if (!handler) {
    if (!isNotification) {
      writeMessage(
        jsonRpcError(message.id, ERROR_CODES.methodNotFound, `Method not found: ${message.method}`),
      );
    }
    return;
  }

  try {
    const result = await handler(message.params ?? {});
    if (!isNotification) {
      writeMessage(jsonRpcResult(message.id, result ?? {}));
    }
  } catch (e) {
    if (isNotification) return;
    const code =
      e instanceof ValidationError ? ERROR_CODES.invalidParams : ERROR_CODES.internalError;
    writeMessage(jsonRpcError(message.id, code, (e as Error).message));
  }
};

export const runServer = ({ input = process.stdin }: { input?: NodeJS.ReadableStream } = {}): {
  close: () => void;
} => {
  const rl = createInterface({ input, terminal: false });
  rl.on('line', (raw) => {
    const line = raw.trim();
    if (!line) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      writeMessage(jsonRpcError(null, ERROR_CODES.parseError, 'Invalid JSON in request'));
      return;
    }
    handleMessage(message).catch((e: Error) => {
      writeMessage(jsonRpcError(message.id ?? null, ERROR_CODES.internalError, e.message));
    });
  });
  return { close: () => rl.close() };
};

export const __testing__ = {
  HANDLERS,
  TOOL_DEFINITIONS,
  RESOURCE_TEMPLATES,
  parseResourceUri,
  toolListFiles,
  toolGetStats,
  toolSearch,
  toolReadThread,
  readResource,
  handleMessage,
};

const isEntrypoint = (() => {
  try {
    const argvUrl = new URL(`file://${process.argv[1]!.replace(/\\/g, '/')}`).href;
    return import.meta.url === argvUrl;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  const stopRecovery = startIndexRecovery();
  process.stdin.once('end', stopRecovery);
  runServer();
}
