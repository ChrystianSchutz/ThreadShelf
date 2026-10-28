import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { saveVaultConfig, setVaultWritePermission } from '../src/obsidian/config.js';
import { READ_ONLY_VAULT_TOOLS, VAULT_TOOLS, callVaultTool } from '../src/obsidian/tools.js';
import { decideVaultDeletion } from '../src/obsidian/approvals.js';
import {
  MAX_AGENT_ROUNDS,
  MAX_AGENT_TOOL_CALLS,
  generateObsidianChat,
  withVaultSystemPrompt,
} from '../src/generation/obsidian-agent.js';
import { setGenerationProviderForTests } from '../src/generation/registry.js';
import { __testing__ } from '../mcp/server.js';
import { useTempVault } from './shared/vault-env.js';

const ctx = useTempVault();
const { TOOL_DEFINITIONS, HANDLERS } = __testing__;
const sha = (text) =>
  import('node:crypto').then((c) => c.createHash('sha256').update(text).digest('hex'));

describe('vault tool definitions', () => {
  it('every schema is closed, and required keys are declared properties', () => {
    for (const tool of VAULT_TOOLS) {
      const { parameters, name, description } = tool.function;
      assert.equal(tool.type, 'function');
      assert.match(name, /^obsidian_[a-z]+$/);
      assert.ok(description.length > 20);
      assert.equal(parameters.type, 'object');
      assert.equal(parameters.additionalProperties, false);
      for (const key of parameters.required)
        assert.ok(key in parameters.properties, `${name}.${key}`);
    }
    assert.deepEqual(
      VAULT_TOOLS.map((tool) => tool.function.name),
      ['obsidian_search', 'obsidian_read', 'obsidian_create', 'obsidian_edit', 'obsidian_delete'],
    );
    assert.deepEqual([...READ_ONLY_VAULT_TOOLS], ['obsidian_search', 'obsidian_read']);
  });

  it('MCP exposes the same schemas but never deletion', () => {
    const mcp = TOOL_DEFINITIONS.filter((tool) => tool.name.startsWith('obsidian_'));
    assert.deepEqual(
      mcp.map((tool) => tool.name),
      ['obsidian_search', 'obsidian_read', 'obsidian_create', 'obsidian_edit'],
    );
    for (const tool of mcp) {
      const source = VAULT_TOOLS.find((entry) => entry.function.name === tool.name);
      assert.deepEqual(tool.inputSchema, source.function.parameters);
    }
  });
});

describe('callVaultTool argument validation', () => {
  it('requires an object of declared arguments for a known tool', async () => {
    for (const args of [null, undefined, [], 'text', 42])
      await assert.rejects(callVaultTool('obsidian_search', args), /object/);
    await assert.rejects(callVaultTool('obsidian_shell', {}), /Unknown/);
    await assert.rejects(callVaultTool('search', {}), /Unknown/);
    await assert.rejects(callVaultTool('obsidian_search', { query: 'x', root: '/' }), /Unexpected/);
    await assert.rejects(
      callVaultTool('obsidian_read', JSON.parse('{"path":"a.md","__proto__":{}}')),
      /Unexpected/,
    );
    await assert.rejects(
      callVaultTool('obsidian_edit', { path: 'a.md', content: 'x', revision: 'r', force: true }),
      /Unexpected/,
    );
  });

  it('validates each tool’s values', async () => {
    await assert.rejects(callVaultTool('obsidian_search', {}), /1–1000/);
    await assert.rejects(callVaultTool('obsidian_search', { query: 'x', limit: '5' }), /limit/);
    await assert.rejects(callVaultTool('obsidian_read', {}), /relative \.md/);
    await assert.rejects(callVaultTool('obsidian_read', { path: '/etc/passwd' }), /relative \.md/);
    await assert.rejects(callVaultTool('obsidian_create', { path: 'a.md' }), /512 KiB/);
    await assert.rejects(
      callVaultTool('obsidian_edit', { path: 'a.md', content: 'x' }),
      /revision/,
    );
    await assert.rejects(callVaultTool('obsidian_delete', { paths: ['a.md'] }), /interactive/);
  });

  it('search defaults to ten results and reports skipped files', async () => {
    for (let i = 0; i < 12; i++) await writeFile(join(ctx.vault, `n${i}.md`), 'needle');
    const result = await callVaultTool('obsidian_search', { query: 'needle' });
    assert.equal(result.hits.length, 10);
    assert.equal(result.scanned, 12);
    assert.equal(result.skipped, 0);
  });

  it('create/edit return revisions without echoing content', async () => {
    const created = await callVaultTool('obsidian_create', { path: 'a.md', content: 'one' });
    assert.deepEqual(created, { path: 'a.md', revision: await sha('one'), created: true });
    const edited = await callVaultTool('obsidian_edit', {
      path: 'a.md',
      content: 'two',
      revision: created.revision,
    });
    assert.deepEqual(edited, { path: 'a.md', revision: await sha('two'), edited: true });
  });

  it('long notes are truncated for the model and carry no edit revision', async () => {
    await writeFile(join(ctx.vault, 'long.md'), 'x'.repeat(70_000));
    const result = await callVaultTool('obsidian_read', { path: 'long.md' });
    assert.equal(result.truncated, true);
    assert.equal(result.content.length, 60_000);
    assert.equal('revision' in result, false);
    await writeFile(join(ctx.vault, 'short.md'), 'x'.repeat(60_000));
    assert.equal((await callVaultTool('obsidian_read', { path: 'short.md' })).revision.length, 64);
  });

  it('read-only policy blocks create/edit but keeps search/read', async () => {
    await writeFile(join(ctx.vault, 'a.md'), 'needle');
    await setVaultWritePermission(false);
    assert.equal((await callVaultTool('obsidian_search', { query: 'needle' })).hits.length, 1);
    assert.equal((await callVaultTool('obsidian_read', { path: 'a.md' })).content, 'needle');
    await assert.rejects(
      callVaultTool('obsidian_create', { path: 'b.md', content: 'x' }),
      /read-only/,
    );
  });

  it('honours an aborted signal before doing anything', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      callVaultTool(
        'obsidian_create',
        { path: 'a.md', content: 'x' },
        { signal: controller.signal, requestDelete: async () => ({}) },
      ),
      { name: 'AbortError' },
    );
    await assert.rejects(readFile(join(ctx.vault, 'a.md')));
  });
});

const baseRequest = {
  provider: 'llama-cpp',
  model: 'synthetic-model',
  messages: [{ role: 'user', content: 'Use the vault' }],
};
const toolCall = (name, args, id = `call-${name}`) => ({
  id,
  type: 'function',
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});
/** A scripted provider: each step returns tool calls, or a final text answer. */
const scripted = (steps) => {
  const requests = [];
  const restore = setGenerationProviderForTests('llama-cpp', {
    chatStream: async (input, onDelta) => {
      requests.push(structuredClone(input));
      const step = steps[Math.min(requests.length - 1, steps.length - 1)];
      const value = typeof step === 'function' ? await step(input) : step;
      if (typeof value === 'string') {
        await onDelta({ content: value });
        return {
          provider: 'llama-cpp',
          model: 'synthetic-model',
          content: value,
          usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        };
      }
      return {
        provider: 'llama-cpp',
        model: 'synthetic-model',
        content: '',
        toolCalls: value,
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      };
    },
  });
  return { requests, restore };
};
const run = async (steps, { request = baseRequest, signal, onEvent } = {}) => {
  const provider = scripted(steps);
  const events = [];
  try {
    const response = await generateObsidianChat(
      request,
      () => {},
      (event) => {
        events.push(event);
        onEvent?.(event);
      },
      signal ?? new AbortController().signal,
    );
    return { response, events, requests: provider.requests };
  } finally {
    provider.restore();
  }
};
const toolResults = (request) =>
  request.messages
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.parse(message.content));

describe('Obsidian agent loop', () => {
  it('merges a master prompt into the single leading system message', () => {
    const merged = withVaultSystemPrompt([
      { role: 'system', content: 'Master prompt' },
      { role: 'user', content: 'Hi' },
    ]);
    assert.equal(merged.filter((message) => message.role === 'system').length, 1);
    assert.match(merged[0].content, /Obsidian[\s\S]*Master prompt$/);
    assert.equal(withVaultSystemPrompt([{ role: 'user', content: 'Hi' }])[0].role, 'system');
  });

  it('requires a connected vault', async () => {
    await saveVaultConfig({ vaultPath: '' });
    await assert.rejects(run(['never']), /Connect an Obsidian vault/);
  });

  it('returns malformed JSON arguments to the model and keeps going', async () => {
    const { response, requests, events } = await run([
      [toolCall('obsidian_search', '{"query": "x"')],
      'Recovered.',
    ]);
    assert.equal(response.content, 'Recovered.');
    assert.match(toolResults(requests[1])[0].error, /not valid JSON/);
    assert.deepEqual(
      events.map((event) => event.state),
      ['running', 'error'],
    );
  });

  it('treats empty arguments as an empty object and non-object JSON as an error', async () => {
    const { requests } = await run([
      [toolCall('obsidian_search', ''), toolCall('obsidian_read', '[1]', 'second')],
      'Done.',
    ]);
    const [empty, array] = toolResults(requests[1]);
    assert.match(empty.error, /1–1000/);
    assert.match(array.error, /object/);
  });

  it('rejects tools outside the offered set and invented consent arguments', async () => {
    await writeFile(join(ctx.vault, 'keep.md'), 'keep');
    await setVaultWritePermission(false);
    const { requests, events } = await run([
      [
        toolCall('obsidian_delete', { paths: ['keep.md'], confirmed: true }, 'a'),
        toolCall('obsidian_create', { path: 'n.md', content: 'x' }, 'b'),
        toolCall('obsidian_approve', {}, 'c'),
      ],
      'Blocked.',
    ]);
    assert.deepEqual(
      requests[0].tools.map((tool) => tool.function.name),
      ['obsidian_search', 'obsidian_read'],
    );
    for (const result of toolResults(requests[1])) assert.match(result.error, /unavailable/);
    assert.equal(
      events.some((event) => event.type === 'vault-approval'),
      false,
    );
    assert.equal(await readFile(join(ctx.vault, 'keep.md'), 'utf8'), 'keep');
    await assert.rejects(readFile(join(ctx.vault, 'n.md')));
  });

  it('applies a read-only switch made during the run', async () => {
    const { requests } = await run([
      async () => {
        await setVaultWritePermission(false);
        return [toolCall('obsidian_create', { path: 'n.md', content: 'x' })];
      },
      'Stopped.',
    ]);
    assert.equal(requests[0].tools.length, VAULT_TOOLS.length);
    assert.match(toolResults(requests[1])[0].error, /read-only|unavailable/);
    assert.equal(requests[1].tools.length, 2);
    await assert.rejects(readFile(join(ctx.vault, 'n.md')));
  });

  it('stops when the vault is switched during the run', async () => {
    const other = join(ctx.temporary, 'other');
    await mkdir(other);
    await assert.rejects(
      run([
        async () => {
          await saveVaultConfig({ vaultPath: other, allowWrites: true });
          return [toolCall('obsidian_create', { path: 'n.md', content: 'x' })];
        },
        'never',
      ]),
      /Vault changed/,
    );
    await assert.rejects(readFile(join(other, 'n.md')));
    await assert.rejects(readFile(join(ctx.vault, 'n.md')));
  });

  it(`enforces the ${MAX_AGENT_ROUNDS}-round limit`, async () => {
    await assert.rejects(
      run([[toolCall('obsidian_search', { query: 'x' })]]),
      new RegExp(`${MAX_AGENT_ROUNDS}-round limit`),
    );
  });

  it(`enforces the ${MAX_AGENT_TOOL_CALLS}-call limit across rounds`, async () => {
    const many = (round) =>
      Array.from({ length: 6 }, (_, i) =>
        toolCall('obsidian_search', { query: 'x' }, `${round}-${i}`),
      );
    await assert.rejects(
      run([many(1), many(2), many(3), 'never']),
      new RegExp(`${MAX_AGENT_TOOL_CALLS}-operation limit`),
    );
  });

  it('sums usage over rounds, keeps reasoning state only inside the loop', async () => {
    await writeFile(join(ctx.vault, 'a.md'), 'needle');
    const { response, requests } = await run([
      [toolCall('obsidian_search', { query: 'needle' })],
      [toolCall('obsidian_read', { path: 'a.md' })],
      'Answer from [[a]].',
    ]);
    assert.deepEqual(response.usage, { promptTokens: 3, completionTokens: 6, totalTokens: 9 });
    assert.equal(response.toolCalls, undefined);
    assert.equal(requests[2].messages.filter((message) => message.role === 'tool').length, 2);
    assert.equal(toolResults(requests[2])[1].content, 'needle');
    assert.equal(
      requests.every((request) => request.persistDiagnostics === false),
      true,
    );
  });

  it('never puts the absolute vault path into model-visible messages', async () => {
    await writeFile(join(ctx.vault, 'a.md'), 'needle');
    const { requests } = await run([
      [
        toolCall('obsidian_read', { path: 'missing.md' }, '1'),
        toolCall('obsidian_read', { path: '../escape.md' }, '2'),
        toolCall('obsidian_search', { query: 'needle' }, '3'),
      ],
      'Done.',
    ]);
    assert.equal(JSON.stringify(requests).includes(ctx.vault), false);
  });

  it('an abort during a tool round rejects instead of reporting a tool error', async () => {
    const controller = new AbortController();
    await assert.rejects(
      run(
        [
          async () => {
            controller.abort();
            return [toolCall('obsidian_search', { query: 'x' })];
          },
          'never',
        ],
        { signal: controller.signal },
      ),
      { name: 'AbortError' },
    );
  });

  it('runs browser-approved deletion end to end and gives the model the real result', async () => {
    await writeFile(join(ctx.vault, 'old.md'), 'old');
    const { requests, events } = await run(
      [[toolCall('obsidian_delete', { paths: ['old.md'] })], 'Deleted.'],
      {
        onEvent: (event) => {
          if (event.type === 'vault-approval')
            void decideVaultDeletion(event.approval.id, {
              token: event.approval.token,
              approve: true,
              acknowledged: true,
            });
        },
      },
    );
    const [result] = toolResults(requests[1]);
    assert.deepEqual(result.deleted, ['old.md']);
    assert.equal(
      JSON.stringify(requests).includes(events.find((e) => e.approval).approval.token),
      false,
    );
    await assert.rejects(readFile(join(ctx.vault, 'old.md')));
  });
});

describe('MCP vault tool calls (in-process)', () => {
  const callTool = async (name, args) => {
    const result = await HANDLERS['tools/call']({ name, arguments: args });
    return { isError: result.isError, payload: JSON.parse(result.content[0].text) };
  };

  it('search/read/create/edit share the vault policy; deletion is not callable', async () => {
    await setVaultWritePermission(false);
    let result = await callTool('obsidian_create', { path: 'm.md', content: 'x' });
    assert.equal(result.isError, true);
    assert.match(result.payload.error, /read-only/);
    await setVaultWritePermission(true);
    result = await callTool('obsidian_create', { path: 'm.md', content: 'x' });
    assert.equal(result.isError, false);
    assert.equal(result.payload.created, true);
    result = await callTool('obsidian_read', { path: 'm.md' });
    assert.equal(result.payload.content, 'x');
    result = await callTool('obsidian_edit', {
      path: 'm.md',
      content: 'y',
      revision: result.payload.revision,
    });
    assert.equal(result.payload.edited, true);
    result = await callTool('obsidian_search', { query: 'y' });
    assert.equal(result.payload.hits[0].path, 'm.md');
    result = await callTool('obsidian_delete', { paths: ['m.md'] });
    assert.equal(result.isError, true);
    assert.match(result.payload.error, /Unknown tool/);
    assert.equal(await readFile(join(ctx.vault, 'm.md'), 'utf8'), 'y');
  });

  it('reports invalid arguments as tool errors without leaking paths', async () => {
    for (const [name, args] of [
      ['obsidian_read', { path: '../outside.md' }],
      ['obsidian_read', { path: 'missing.md' }],
      ['obsidian_search', { query: '' }],
      ['obsidian_edit', { path: 'missing.md', content: 'x', revision: 'a'.repeat(64) }],
    ]) {
      const result = await callTool(name, args);
      assert.equal(result.isError, true, name);
      assert.equal(JSON.stringify(result.payload).includes(ctx.vault), false);
    }
  });
});
