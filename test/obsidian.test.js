import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, link, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getVaultConfig,
  saveVaultConfig,
  setVaultWritePermission,
} from '../src/obsidian/config.js';
import {
  createVaultNote,
  editVaultNote,
  readVaultNote,
  searchVault,
  inVault,
} from '../src/obsidian/vault.js';
import { requestVaultDeletion, decideVaultDeletion } from '../src/obsidian/approvals.js';
import { callVaultTool } from '../src/obsidian/tools.js';
import {
  openAiCompatibleChatStream,
  openAiCompatibleChat,
} from '../src/generation/openai-compatible.js';
import { generateObsidianChat } from '../src/generation/obsidian-agent.js';
import { setGenerationProviderForTests } from '../src/generation/registry.js';

let temporary;
let vault;
let oldConfig;
beforeEach(async () => {
  oldConfig = process.env.OBSIDIAN_CONFIG_PATH;
  temporary = await mkdtemp(join(tmpdir(), 'threadshelf-vault-unit-'));
  vault = join(temporary, 'vault');
  await mkdir(join(vault, 'Projects'), { recursive: true });
  process.env.OBSIDIAN_CONFIG_PATH = join(temporary, 'config.json');
  await saveVaultConfig({ vaultPath: vault, allowWrites: true });
});
afterEach(async () => {
  if (oldConfig === undefined) delete process.env.OBSIDIAN_CONFIG_PATH;
  else process.env.OBSIDIAN_CONFIG_PATH = oldConfig;
  await rm(temporary, { recursive: true, force: true });
});

const proposal = async (paths) => {
  const controller = new AbortController();
  let emit;
  const ready = new Promise((resolve) => {
    emit = resolve;
  });
  const result = requestVaultDeletion(
    paths,
    'Synthetic Model X',
    (event) => emit(event.approval),
    controller.signal,
  );
  return { approval: await ready, result, controller };
};
describe('Obsidian vault policy', () => {
  it('policy toggles preserve the current vault, including across queued saves', async () => {
    const other = join(temporary, 'other-vault');
    await mkdir(other);
    await saveVaultConfig({ vaultPath: other, allowWrites: true });
    await setVaultWritePermission(false);
    assert.deepEqual(await getVaultConfig(), { vaultPath: other, allowWrites: false });
    await assert.rejects(setVaultWritePermission('false'), /boolean/);
  });
  it('defaults to enabled writes but no connected vault', async () => {
    await rm(process.env.OBSIDIAN_CONFIG_PATH);
    assert.deepEqual(await getVaultConfig(), { vaultPath: '', allowWrites: true });
    await assert.rejects(createVaultNote('note.md', 'text'), /Connect/);
  });
  it('searches live text and paths while skipping hidden data and attachments', async () => {
    await createVaultNote(
      'Projects/Decision.md',
      '---\ntags: [design]\n---\n# Decision\nUse local search.\n[[Other#Heading|link]]',
    );
    await mkdir(join(vault, '.obsidian'));
    await writeFile(join(vault, '.obsidian', 'secret.md'), 'local search');
    await writeFile(join(vault, 'attachment.txt'), 'local search');
    let result = await searchVault('local search');
    assert.equal(result.scanned, 1);
    assert.equal(result.hits[0].path, 'Projects/Decision.md');
    assert.equal(result.hits[0].line, 5);
    assert.equal((await searchVault('Projects design')).hits.length, 1);
    await writeFile(join(vault, 'Projects', 'Decision.md'), '# Updated\nDifferent contents');
    result = await searchVault('local search');
    assert.equal(result.hits.length, 0);
  });
  it('rejects traversal, absolute paths, hidden paths, ADS and reserved names', async () => {
    for (const path of [
      '../escape.md',
      '/escape.md',
      'C:\\escape.md',
      '.obsidian/config.md',
      'Projects/../escape.md',
      'note:secret.md',
      'CON.md',
      'Projects./note.md',
      'note\0.md',
    ]) {
      await assert.rejects(createVaultNote(path, 'test'));
      await assert.rejects(readVaultNote(path));
    }
    await assert.rejects(createVaultNote('NotExisting/note.md', 'test'));
    await assert.rejects(createVaultNote('note.txt', 'test'));
  });
  it('rejects junctions and hard-linked notes outside the vault', async () => {
    const outside = join(temporary, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'private.md'), 'Synthetic outside data');
    await symlink(
      outside,
      join(vault, 'Linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await link(join(outside, 'private.md'), join(vault, 'hardlink.md'));
    await assert.rejects(readVaultNote('Linked/private.md'));
    await assert.rejects(createVaultNote('Linked/new.md', 'test'));
    await assert.rejects(readVaultNote('hardlink.md'));
    assert.equal((await searchVault('Synthetic')).hits.length, 0);
    await assert.rejects(
      saveVaultConfig({ vaultPath: join(vault, 'Linked'), allowWrites: true }),
      /junctions/,
    );
  });
  it('never overwrites on create and uses revisions for edits', async () => {
    const initial = await createVaultNote('note.md', '# Original\n[[link]]');
    await assert.rejects(createVaultNote('note.md', 'overwrite'), /already exists/);
    const edited = await editVaultNote('note.md', '# Changed\n[[link]]', initial.revision);
    assert.notEqual(edited.revision, initial.revision);
    await assert.rejects(editVaultNote('note.md', 'lost change', initial.revision), /changed/);
    assert.equal((await readVaultNote('note.md')).content, '# Changed\n[[link]]');
  });
  it('read-only immediately blocks all writes, including previously pending deletion', async () => {
    const note = await createVaultNote('note.md', 'preserved');
    const pending = await proposal(['note.md']);
    await saveVaultConfig({ vaultPath: vault, allowWrites: false });
    assert.equal((await readVaultNote('note.md')).content, 'preserved');
    await assert.rejects(createVaultNote('new.md', 'test'), /read-only/);
    await assert.rejects(editVaultNote('note.md', 'test', note.revision), /read-only/);
    await assert.rejects(
      decideVaultDeletion(pending.approval.id, {
        token: pending.approval.token,
        approve: true,
        acknowledged: true,
      }),
      /read-only/,
    );
    assert.match((await pending.result).error, /read-only/);
    assert.equal((await readVaultNote('note.md')).content, 'preserved');
  });
  it('requires the browser capability AND checkbox, then moves notes to trash exactly once', async () => {
    await createVaultNote('note.md', 'recover me');
    const pending = await proposal(['note.md']);
    assert.equal((await readVaultNote('note.md')).content, 'recover me');
    await assert.rejects(
      decideVaultDeletion(pending.approval.id, {
        token: '0'.repeat(64),
        approve: true,
        acknowledged: true,
      }),
      /token/,
    );
    await assert.rejects(
      decideVaultDeletion(pending.approval.id, {
        token: pending.approval.token,
        approve: true,
        confirmed: true,
      }),
      /box/,
    );
    await decideVaultDeletion(pending.approval.id, {
      token: pending.approval.token,
      approve: true,
      acknowledged: true,
    });
    const result = await pending.result;
    assert.deepEqual(result.deleted, ['note.md']);
    assert.equal(await readFile(join(vault, result.trash, '0-note.md'), 'utf8'), 'recover me');
    await assert.rejects(readVaultNote('note.md'));
    await assert.rejects(
      decideVaultDeletion(pending.approval.id, {
        token: pending.approval.token,
        approve: true,
        acknowledged: true,
      }),
      /expired/,
    );
  });
  it('cancellation and disconnect preserve notes and expire the capability', async () => {
    await createVaultNote('note.md', 'keep');
    let pending = await proposal(['note.md']);
    await decideVaultDeletion(pending.approval.id, {
      token: pending.approval.token,
      approve: false,
    });
    assert.equal((await pending.result).cancelled, true);
    pending = await proposal(['note.md']);
    pending.controller.abort();
    assert.equal((await pending.result).cancelled, true);
    await assert.rejects(
      decideVaultDeletion(pending.approval.id, {
        token: pending.approval.token,
        approve: true,
        acknowledged: true,
      }),
    );
    assert.equal((await readVaultNote('note.md')).content, 'keep');
  });
  it('rejects a stale batch before moving any files', async () => {
    await createVaultNote('one.md', 'one');
    await createVaultNote('two.md', 'two');
    const pending = await proposal(['one.md', 'two.md']);
    await writeFile(join(vault, 'two.md'), 'changed by Obsidian');
    await assert.rejects(
      decideVaultDeletion(pending.approval.id, {
        token: pending.approval.token,
        approve: true,
        acknowledged: true,
      }),
      /changed/,
    );
    await pending.result;
    assert.equal((await readVaultNote('one.md')).content, 'one');
    assert.equal((await readVaultNote('two.md')).content, 'changed by Obsidian');
  });
  it('pins agent operations to the original vault and denies MCP deletion', async () => {
    const other = join(temporary, 'other');
    await mkdir(other);
    await saveVaultConfig({ vaultPath: other, allowWrites: true });
    await assert.rejects(
      inVault(vault, () => createVaultNote('no.md', 'test')),
      /Vault changed/,
    );
    assert.deepEqual(await readdir(other), []);
    await assert.rejects(callVaultTool('obsidian_delete', { paths: ['note.md'] }), /interactive/);
    await assert.rejects(
      callVaultTool('obsidian_create', { path: 'note.md', content: '', confirmed: true }),
      /Unexpected/,
    );
  });
});

const request = {
  provider: 'llama-cpp',
  model: 'synthetic-model',
  messages: [{ role: 'user', content: 'Find context in the vault' }],
};
const call = (name, args, id = 'call-1') => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
describe('Obsidian model tools', () => {
  it('rejects provider tool calls when tools are disabled and bounds malformed calls', async () => {
    await assert.rejects(
      openAiCompatibleChat({
        provider: 'llama-cpp',
        baseUrl: 'http://localhost',
        request,
        fetchImpl: async () =>
          Response.json({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [call('obsidian_create', { path: 'no.md', content: 'test' })],
                },
              },
            ],
          }),
      }),
      /tools are disabled/,
    );
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 16 }] } }] })}\n\n`,
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(
      openAiCompatibleChatStream(
        {
          provider: 'llama-cpp',
          baseUrl: 'http://localhost',
          request: { ...request, tools: [] },
          fetchImpl: async () => new Response(stream),
        },
        () => {},
      ),
      /index/,
    );
    assert.equal(cancelled, true);
    await assert.rejects(readFile(join(vault, 'no.md')));
  });
  it('assembles fragmented tool calls and accepts tool-only provider responses', async () => {
    let sent;
    const events = [
      {
        choices: [
          {
            delta: {
              reasoning_details: [
                { type: 'reasoning.encrypted', data: 'synthetic-signature', index: 0 },
              ],
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  function: { name: 'obsidian_search', arguments: '{"query":' },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"local"}' } }] } }] },
    ];
    const fetchImpl = async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
      );
    };
    const response = await openAiCompatibleChatStream(
      {
        provider: 'llama-cpp',
        baseUrl: 'http://localhost',
        request: {
          ...request,
          tools: [{ type: 'function', function: { name: 'obsidian_search', parameters: {} } }],
        },
        fetchImpl,
      },
      () => {},
    );
    assert.equal(sent.parallel_tool_calls, false);
    assert.equal(sent.tools.length, 1);
    assert.deepEqual(response.toolCalls, [call('obsidian_search', { query: 'local' })]);
    assert.equal(response.content, '');
    assert.equal(response.reasoningDetails[0].data, 'synthetic-signature');
    const complete = await openAiCompatibleChat({
      provider: 'llama-cpp',
      baseUrl: 'http://localhost',
      request: {
        ...request,
        tools: [{ type: 'function', function: { name: 'obsidian_read', parameters: {} } }],
      },
      fetchImpl: async () =>
        Response.json({
          choices: [
            {
              message: { content: null, tool_calls: [call('obsidian_read', { path: 'note.md' })] },
            },
          ],
        }),
    });
    assert.equal(complete.toolCalls.length, 1);
  });
  it('executes search, returns source data as a tool message, and streams the answer', async () => {
    await createVaultNote('source.md', '# Source\nlocal context');
    const requests = [];
    const events = [];
    let text = '';
    const restore = setGenerationProviderForTests('llama-cpp', {
      chatStream: async (input, onDelta) => {
        requests.push(input);
        if (requests.length === 1)
          return {
            provider: 'llama-cpp',
            model: 'synthetic-model',
            content: '',
            toolCalls: [call('obsidian_search', { query: 'local' })],
            reasoningDetails: [{ type: 'reasoning.encrypted', data: 'synthetic-signature' }],
          };
        await onDelta({ content: 'See [[source]].' });
        assert.equal(
          input.messages.find((message) => message.tool_calls)?.reasoning_details[0].data,
          'synthetic-signature',
        );
        return { provider: 'llama-cpp', model: 'synthetic-model', content: 'See [[source]].' };
      },
    });
    try {
      const response = await generateObsidianChat(
        request,
        (delta) => {
          text += delta.content || '';
        },
        (event) => events.push(event),
        new AbortController().signal,
      );
      assert.equal(response.content, text);
      assert.equal(text, 'See [[source]].');
      assert.equal(requests[1].messages.at(-1).role, 'tool');
      assert.match(requests[1].messages.at(-1).content, /source.md/);
      assert.equal(events.filter((event) => event.type === 'vault-tool').length, 2);
    } finally {
      restore();
    }
  });
  it('does not expose write tools when read-only and does not honor invented consent', async () => {
    await createVaultNote('source.md', 'preserve');
    await saveVaultConfig({ vaultPath: vault, allowWrites: false });
    let round = 0;
    const seen = [];
    const restore = setGenerationProviderForTests('llama-cpp', {
      chatStream: async (input, onDelta) => {
        seen.push(input.tools.map((tool) => tool.function.name));
        if (++round === 1)
          return {
            provider: 'llama-cpp',
            model: request.model,
            content: '',
            toolCalls: [call('obsidian_delete', { paths: ['source.md'], confirmed: true })],
          };
        assert.match(input.messages.at(-1).content, /unavailable/);
        await onDelta({ content: 'Writes are disabled.' });
        return { provider: 'llama-cpp', model: request.model, content: 'Writes are disabled.' };
      },
    });
    try {
      await generateObsidianChat(
        request,
        () => {},
        (event) => {
          assert.notEqual(event.type, 'vault-approval');
        },
        new AbortController().signal,
      );
    } finally {
      restore();
    }
    assert.deepEqual(seen[0], ['obsidian_search', 'obsidian_read']);
    assert.equal((await readVaultNote('source.md')).content, 'preserve');
  });
});
