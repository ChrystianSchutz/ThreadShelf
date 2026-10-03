import { describe, it } from 'node:test';
import assert from 'node:assert';
import { __testing__ } from '../mcp/server.js';

const { HANDLERS, TOOL_DEFINITIONS, parseResourceUri, handleMessage } = __testing__;

function findTool(name) {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name);
}

describe('MCP — protocol surface', () => {
  it('declares archive tools and the four safe vault tools', () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name).sort();
    assert.deepStrictEqual(names, [
      'get_stats',
      'list_collections',
      'list_files',
      'obsidian_create',
      'obsidian_edit',
      'obsidian_read',
      'obsidian_search',
      'read_thread',
      'search',
    ]);
  });

  it('search tool requires a query', () => {
    const search = findTool('search');
    assert.deepStrictEqual(search.inputSchema.required, ['query']);
  });

  it('documents all-collections defaults for collection-aware tools', () => {
    assert.match(
      findTool('search').inputSchema.properties.collection.description,
      /Defaults to "all"/,
    );
    assert.match(
      findTool('list_files').inputSchema.properties.collection.description,
      /Defaults to "all"/,
    );
    assert.match(
      findTool('get_stats').inputSchema.properties.collection.description,
      /Defaults to "all"/,
    );
    assert.match(
      findTool('read_thread').inputSchema.properties.collection.description,
      /Defaults to "all"/,
    );
  });

  it('exposes search filters and multi-conversation thread lookup', () => {
    const searchProperties = findTool('search').inputSchema.properties;
    assert.ok(searchProperties.model);
    assert.ok(searchProperties.from);
    assert.ok(searchProperties.to);
    assert.deepStrictEqual(searchProperties.mode.enum, ['semantic', 'keyword']);
    assert.ok(findTool('read_thread').inputSchema.properties.conversationKey);
  });

  it('exposes capabilities with both tools and resources sections', async () => {
    const init = await HANDLERS.initialize();
    assert.strictEqual(init.protocolVersion, '2024-11-05');
    assert.ok(init.capabilities.tools);
    assert.ok(init.capabilities.resources);
    assert.strictEqual(init.serverInfo.name, 'threadshelf-mcp');
  });

  it('negotiates newer supported protocol versions when requested', async () => {
    const init = await HANDLERS.initialize({ protocolVersion: '2025-06-18' });
    assert.strictEqual(init.protocolVersion, '2025-06-18');
  });

  it('tools/list returns all definitions', async () => {
    const result = await HANDLERS['tools/list']();
    assert.strictEqual(result.tools.length, TOOL_DEFINITIONS.length);
  });

  it('resources/list returns templates only (no static resources)', async () => {
    const result = await HANDLERS['resources/list']();
    assert.strictEqual(Array.isArray(result.resources), true);
    assert.ok(result.resourceTemplates.length >= 3);
  });
});

describe('MCP — tools/call surface', () => {
  it('returns an MCP error envelope for unknown tools', async () => {
    const result = await HANDLERS['tools/call']({ name: 'does-not-exist', arguments: {} });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /Unknown tool/);
  });

  it('reports validation errors as MCP errors (not protocol crashes)', async () => {
    const result = await HANDLERS['tools/call']({ name: 'search', arguments: { query: '' } });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /Invalid query/);
  });

  it('rejects search with an unknown mode', async () => {
    const result = await HANDLERS['tools/call']({
      name: 'search',
      arguments: { query: 'hi', mode: 'fuzzy' },
    });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /Invalid mode/);
  });

  it('rejects search with bad n parameter', async () => {
    const result = await HANDLERS['tools/call']({
      name: 'search',
      arguments: { query: 'hi', n: -1 },
    });
    assert.strictEqual(result.isError, true);
  });

  it('rejects search with an invalid date range before querying the index', async () => {
    const result = await HANDLERS['tools/call']({
      name: 'search',
      arguments: { query: 'hi', from: '2026-12-31', to: '2026-01-01' },
    });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /Invalid date range/);
  });

  it('rejects read_thread without sourceFile', async () => {
    const result = await HANDLERS['tools/call']({ name: 'read_thread', arguments: {} });
    assert.strictEqual(result.isError, true);
  });

  it('rejects read_thread with nullbyte sourceFile', async () => {
    const result = await HANDLERS['tools/call']({
      name: 'read_thread',
      arguments: { sourceFile: 'a\0b' },
    });
    assert.strictEqual(result.isError, true);
  });

  it('rejects read_thread with a nullbyte conversationKey', async () => {
    const result = await HANDLERS['tools/call']({
      name: 'read_thread',
      arguments: { sourceFile: 'safe.json', conversationKey: 'a\0b' },
    });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /Invalid conversationKey/);
  });
});

describe('MCP — JSON-RPC dispatch', () => {
  it('rejects non-2.0 envelopes', async () => {
    const original = process.stdout.write.bind(process.stdout);
    const written = [];
    process.stdout.write = (chunk) => {
      written.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
      return true;
    };
    try {
      await handleMessage({ id: 1, method: 'initialize' });
    } finally {
      process.stdout.write = original;
    }
    assert.ok(written.some((line) => /Expected jsonrpc/.test(line)));
  });

  it('responds with method-not-found for unknown methods', async () => {
    const original = process.stdout.write.bind(process.stdout);
    const written = [];
    process.stdout.write = (chunk) => {
      written.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
      return true;
    };
    try {
      await handleMessage({ jsonrpc: '2.0', id: 2, method: 'nope' });
    } finally {
      process.stdout.write = original;
    }
    const payload = JSON.parse(written.join(''));
    assert.strictEqual(payload.error.code, -32601);
  });

  it('does not respond to notifications (id absent)', async () => {
    const original = process.stdout.write.bind(process.stdout);
    const written = [];
    process.stdout.write = (chunk) => {
      written.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
      return true;
    };
    try {
      await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
    } finally {
      process.stdout.write = original;
    }
    assert.strictEqual(written.length, 0);
  });
});

describe('MCP — resource URI parser', () => {
  it('parses the static collections URI', () => {
    assert.deepStrictEqual(parseResourceUri('threadshelf://collections'), { kind: 'collections' });
  });

  it('parses the per-collection files URI', () => {
    assert.deepStrictEqual(parseResourceUri('threadshelf://collections/foo/files'), {
      kind: 'files',
      collection: 'foo',
    });
  });

  it('url-decodes collection name', () => {
    assert.deepStrictEqual(parseResourceUri('threadshelf://collections/my%20coll/files'), {
      kind: 'files',
      collection: 'my coll',
    });
  });

  it('parses the thread URI with required path param', () => {
    const parsed = parseResourceUri('threadshelf://thread?path=%2Ftmp%2Fa.json');
    assert.deepStrictEqual(parsed, { kind: 'thread', path: '/tmp/a.json' });
  });

  it('rejects malformed URIs', () => {
    assert.strictEqual(parseResourceUri('http://example.com'), null);
    assert.strictEqual(parseResourceUri('threadshelf://thread'), null);
    assert.strictEqual(parseResourceUri(''), null);
  });
});
