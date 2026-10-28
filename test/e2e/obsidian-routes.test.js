import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { startApiServer } from './helpers.js';
import { startVaultProvider } from '../shared/vault-provider.js';

/** Route-level behaviour of /api/obsidian against one isolated server and temp vault. */
describe('Obsidian HTTP routes', { timeout: 120_000 }, () => {
  let ctx;
  let vault;
  const url = (path) => `${ctx.baseUrl}${path}`;
  const send = (method, path, body, headers = {}) =>
    fetch(url(path), {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  const errorOf = async (response) => (await response.json()).error;
  const noPaths = (text) => {
    assert.equal(text.includes(ctx.tempRoot), false, `leaked path: ${text}`);
    assert.equal(text.includes(vault), false, `leaked path: ${text}`);
  };

  before(async () => {
    ctx = await startApiServer({ prefix: 'threadshelf-obsidian-routes-' });
    vault = join(ctx.tempRoot, 'vault');
    await mkdir(join(vault, 'Projects'), { recursive: true });
  });
  after(async () => {
    await ctx?.stop();
  });

  it('starts disconnected and read-only', async () => {
    const response = await fetch(url('/api/obsidian/config'));
    assert.deepEqual(await response.json(), { vaultPath: '', allowWrites: false });
    assert.equal((await fetch(url('/api/obsidian/search?q=x'))).status, 400);
    assert.match(await errorOf(await fetch(url('/api/obsidian/note?path=a.md'))), /Connect/);
  });

  it('validates PUT and PATCH bodies', async () => {
    for (const body of [
      [],
      {},
      { vaultPath: 1 },
      { vaultPath: vault, allowWrites: 'yes' },
      { vaultPath: vault, extra: 1 },
      { vaultPath: 'relative' },
      { vaultPath: join(ctx.tempRoot, 'missing') },
    ])
      assert.equal(
        (await send('PUT', '/api/obsidian/config', body)).status,
        400,
        JSON.stringify(body),
      );
    for (const body of [{}, [], { allowWrites: 'true' }, { allowWrites: true, vaultPath: '/' }])
      assert.equal(
        (await send('PATCH', '/api/obsidian/config', body)).status,
        400,
        JSON.stringify(body),
      );
    assert.equal((await send('PUT', '/api/obsidian/config', '{not json')).status, 400);
    assert.deepEqual(await (await fetch(url('/api/obsidian/config'))).json(), {
      vaultPath: '',
      allowWrites: false,
    });
  });

  it('connecting a vault keeps it read-only until writes are enabled', async () => {
    const saved = await (await send('PUT', '/api/obsidian/config', { vaultPath: vault })).json();
    assert.equal(saved.allowWrites, false);
    const blocked = await send('POST', '/api/obsidian/note', { path: 'a.md', content: 'x' });
    assert.equal(blocked.status, 400);
    assert.match(await errorOf(blocked), /read-only/);
    await assert.rejects(readFile(join(vault, 'a.md')));
    const enabled = await (
      await send('PATCH', '/api/obsidian/config', { allowWrites: true })
    ).json();
    assert.deepEqual(enabled, { vaultPath: saved.vaultPath, allowWrites: true });
    assert.equal(
      (await (await send('PUT', '/api/obsidian/config', { vaultPath: vault })).json()).allowWrites,
      true,
      're-saving the same vault keeps the choice',
    );
  });

  it('creates, refuses overwrites and missing parents, and enforces the body limit', async () => {
    const created = await send('POST', '/api/obsidian/note', {
      path: 'Projects/plan.md',
      content: '# Plan\nsynthetic roadmap',
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).revision.length, 64);
    const again = await send('POST', '/api/obsidian/note', {
      path: 'Projects/plan.md',
      content: 'x',
    });
    assert.match(await errorOf(again), /already exists/);
    const parent = await send('POST', '/api/obsidian/note', { path: 'Nope/plan.md', content: 'x' });
    assert.equal(parent.status, 400);
    noPaths(await errorOf(parent));
    for (const body of [
      {},
      { path: 'a.md' },
      { path: 'a.txt', content: 'x' },
      { path: '../a.md', content: 'x' },
    ])
      assert.equal((await send('POST', '/api/obsidian/note', body)).status, 400);
    const huge = await send('POST', '/api/obsidian/note', {
      path: 'huge.md',
      content: 'x'.repeat(600_000),
    });
    assert.equal(huge.status, 413);
    await assert.rejects(readFile(join(vault, 'huge.md')));
  });

  it('reads notes and rejects unsafe paths without leaking absolute paths', async () => {
    const note = await (await fetch(url('/api/obsidian/note?path=Projects%2Fplan.md'))).json();
    assert.equal(note.content, '# Plan\nsynthetic roadmap');
    for (const path of [
      '../outside.md',
      '/etc/passwd.md',
      'C:\\x.md',
      '\\\\server\\share\\x.md',
      'plan.md:secret',
      'Projects/plan.md:stream.md',
      '.obsidian/app.md',
      'CON.md',
      'missing.md',
    ]) {
      const response = await fetch(url(`/api/obsidian/note?path=${encodeURIComponent(path)}`));
      assert.equal(response.status, 400, path);
      noPaths(await errorOf(response));
    }
    assert.equal((await fetch(url('/api/obsidian/note?path=a.md&path=b.md'))).status, 400);
    assert.equal((await fetch(url('/api/obsidian/note'))).status, 400);
  });

  it('searches live files, validates parameters and reports skipped files', async () => {
    await writeFile(join(vault, 'big.md'), `roadmap ${'x'.repeat(600 * 1024)}`);
    const result = await (await fetch(url('/api/obsidian/search?q=roadmap&limit=5'))).json();
    assert.deepEqual(
      result.hits.map((hit) => hit.path),
      ['Projects/plan.md'],
    );
    assert.equal(result.skipped, 1);
    for (const query of ['', 'q=', 'q=x&limit=0', 'q=x&limit=31', 'q=x&limit=abc', 'q=x&q=y'])
      assert.equal((await fetch(url(`/api/obsidian/search?${query}`))).status, 400, query);
  });

  it('approval decisions for unknown requests fail with 409', async () => {
    const response = await send('POST', '/api/obsidian/approvals/not-a-request', {
      token: 'a'.repeat(64),
      approve: true,
      acknowledged: true,
    });
    assert.equal(response.status, 409);
    assert.match(await errorOf(response), /expired|invalid/);
  });

  it('every route is loopback-only and rejects cross-origin browsers', async () => {
    const routes = [
      ['GET', '/api/obsidian/config'],
      ['PUT', '/api/obsidian/config', { vaultPath: '' }],
      ['PATCH', '/api/obsidian/config', { allowWrites: true }],
      ['GET', '/api/obsidian/search?q=roadmap'],
      ['GET', '/api/obsidian/note?path=Projects%2Fplan.md'],
      ['POST', '/api/obsidian/note', { path: 'remote.md', content: 'x' }],
      ['POST', '/api/obsidian/approvals/x', { token: 'a'.repeat(64), approve: false }],
    ];
    for (const headers of [
      { 'x-forwarded-for': '203.0.113.7' },
      { 'x-real-ip': '198.51.100.2' },
      { forwarded: 'for=203.0.113.9' },
      { origin: 'https://malicious.example' },
    ]) {
      for (const [method, path, body] of routes) {
        const response = await send(method, path, body, headers);
        assert.equal(response.status, 403, `${method} ${path} ${JSON.stringify(headers)}`);
      }
    }
    // fetch() cannot override Host; DNS-rebinding protection is checked with a raw request.
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(url('/api/obsidian/config'), {
        headers: { host: 'attacker.example' },
      });
      request.on('response', (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(status, 403);
    assert.equal((await fetch(url('/api/obsidian/config'))).status, 200);
    await assert.rejects(readFile(join(vault, 'remote.md')));
    assert.equal(
      (await (await fetch(url('/api/obsidian/config'))).json()).vaultPath.length > 0,
      true,
      'blocked PUT did not disconnect the vault',
    );
  });

  it('generation rejects vault tools on the non-streaming route and a non-boolean flag', async () => {
    const plain = await send('POST', '/api/generation/chat', {
      provider: 'llama-cpp',
      model: 'm',
      prompt: 'x',
      ephemeral: true,
      useObsidian: true,
    });
    assert.equal(plain.status, 400);
    const streamed = await send('POST', '/api/generation/chat/stream', {
      provider: 'llama-cpp',
      model: 'm',
      prompt: 'x',
      ephemeral: true,
      useObsidian: 'yes',
    });
    const events = (await streamed.text())
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(events.at(-1).type, 'error');
    assert.match(events.at(-1).error, /useObsidian must be a boolean/);
    assert.equal(
      events.some((event) => event.phase === 'loading-model'),
      false,
    );
  });

  it('a read-only agent run offers only search/read and cannot write', async () => {
    const model = await startVaultProvider([
      { name: 'obsidian_create', args: { path: 'agent.md', content: 'x' } },
    ]);
    try {
      await send('PATCH', '/api/obsidian/config', { allowWrites: false });
      assert.equal(
        (await send('PUT', '/api/generation/config', { llamaCpp: { baseUrl: model.baseUrl } })).ok,
        true,
      );
      const response = await send('POST', '/api/generation/chat/stream', {
        provider: 'llama-cpp',
        model: 'Synthetic Model X',
        prompt: 'Write a note.',
        ephemeral: true,
        useObsidian: true,
      });
      const events = (await response.text())
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(events.at(-1).type, 'done', JSON.stringify(events.at(-1)));
      assert.match(events.at(-1).response.content, /blocked/);
      assert.deepEqual(
        model.requests[0].tools.map((tool) => tool.function.name),
        ['obsidian_search', 'obsidian_read'],
      );
      assert.equal(JSON.stringify(model.requests).includes(vault), false);
      await assert.rejects(readFile(join(vault, 'agent.md')));
    } finally {
      await send('PUT', '/api/generation/config', { llamaCpp: { baseUrl: '' } });
      await model.close();
    }
  });

  it('a corrupt config file is reported as a server error and can be repaired', async () => {
    await writeFile(join(ctx.tempRoot, 'obsidian.json'), '{broken');
    const broken = await fetch(url('/api/obsidian/config'));
    assert.equal(broken.status, 500);
    noPaths(await errorOf(broken));
    const repaired = await send('PUT', '/api/obsidian/config', { vaultPath: vault });
    assert.equal(repaired.status, 200);
    assert.equal((await repaired.json()).allowWrites, false);
  });
});
