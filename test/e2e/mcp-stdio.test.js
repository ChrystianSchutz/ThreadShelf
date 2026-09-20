/**
 * End-to-end MCP smoke test. Spawns mcp/server.ts as a subprocess and drives
 * it over stdio with real JSON-RPC frames. Exercises:
 *   initialize → tools/list → tools/call(search) → resources/list
 * The collection list call also doubles as a sanity test against a fresh
 * LanceDB directory (no tables ⇒ tool still returns ["chunks"]).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { once } from 'events';
import { createInterface } from 'readline';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..', '..');

function makeClient(child) {
  const rl = createInterface({ input: child.stdout });
  const queue = [];
  const waiters = [];
  // stdout is the JSON-RPC channel: any other output corrupts client framing.
  const noise = [];
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      noise.push(line);
      return;
    }
    if (waiters.length) waiters.shift()(msg);
    else queue.push(msg);
  });

  let nextId = 1;

  function send(method, params) {
    const id = nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    child.stdin.write(`${payload}\n`);
    return new Promise((resolve) => {
      const pump = () => {
        if (queue.length) {
          const match = queue.findIndex((m) => m.id === id);
          if (match >= 0) {
            const [msg] = queue.splice(match, 1);
            resolve(msg);
            return;
          }
        }
        waiters.push((msg) => {
          if (msg.id === id) resolve(msg);
          else {
            queue.push(msg);
            pump();
          }
        });
      };
      pump();
    });
  }

  function notify(method, params) {
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    child.stdin.write(`${payload}\n`);
  }

  return { send, notify, noise };
}

describe('MCP stdio E2E', () => {
  it(
    'initializes, lists tools, and answers list_collections without a real DB',
    { timeout: 120_000 },
    async () => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'threadshelf-mcp-'));
      const child = spawn(process.execPath, ['--import', 'tsx', 'mcp/server.ts'], {
        cwd: repoRoot,
        env: { ...process.env, LANCEDB_PATH: join(tempRoot, '.lancedb') },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stderr = [];
      child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

      try {
        const client = makeClient(child);

        const init = await client.send('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
        });
        assert.strictEqual(init.result.serverInfo.name, 'threadshelf-mcp');
        client.notify('notifications/initialized', {});

        const tools = await client.send('tools/list', {});
        assert.ok(Array.isArray(tools.result.tools));
        const toolNames = tools.result.tools.map((tool) => tool.name).sort();
        assert.deepStrictEqual(toolNames, [
          'get_stats',
          'list_collections',
          'list_files',
          'read_thread',
          'search',
        ]);

        const listCall = await client.send('tools/call', {
          name: 'list_collections',
          arguments: {},
        });
        assert.strictEqual(listCall.result.isError, false);
        const payload = JSON.parse(listCall.result.content[0].text);
        assert.ok(payload.includes('chunks'));

        const statsCall = await client.send('tools/call', { name: 'get_stats', arguments: {} });
        assert.strictEqual(statsCall.result.isError, false);
        const statsPayload = JSON.parse(statsCall.result.content[0].text);
        assert.strictEqual(statsPayload.collection, 'all');

        // Unknown tool returns isError instead of crashing.
        const badCall = await client.send('tools/call', { name: 'no-such-tool', arguments: {} });
        assert.strictEqual(badCall.result.isError, true);

        // Validation error on search with empty query.
        const badSearch = await client.send('tools/call', {
          name: 'search',
          arguments: { query: '' },
        });
        assert.strictEqual(badSearch.result.isError, true);

        const resources = await client.send('resources/list', {});
        assert.ok(Array.isArray(resources.result.resourceTemplates));
        assert.ok(resources.result.resourceTemplates.length >= 3);
        assert.deepStrictEqual(client.noise, [], 'MCP stdout must contain only JSON-RPC frames');
      } catch (e) {
        e.message += `\nMCP stderr:\n${stderr.join('')}`;
        throw e;
      } finally {
        child.kill();
        await once(child, 'exit');
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );
});
