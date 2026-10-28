import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startApiServer } from './helpers.js';
import { startVaultProvider } from '../shared/vault-provider.js';

it(
  'Obsidian API + native agent search/read/create/edit/delete use isolated data and browser approval',
  { timeout: 90_000 },
  async () => {
    const model = await startVaultProvider([
      { name: 'obsidian_search', args: { query: 'synthetic' } },
      { name: 'obsidian_read', args: { path: 'source.md' } },
      { name: 'obsidian_create', args: { path: 'note.md', content: '# New note\n[[source]]' } },
      {
        name: 'obsidian_edit',
        args: (results) => ({
          path: 'note.md',
          content: '# Updated\n[[source]]',
          revision: results[2].revision,
        }),
      },
      { name: 'obsidian_delete', args: { paths: ['note.md'] } },
    ]);
    const ctx = await startApiServer();
    const json = (body) => ({
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    try {
      const vault = join(ctx.tempRoot, 'vault');
      await mkdir(vault);
      assert.equal(
        (
          await fetch(`${ctx.baseUrl}/api/obsidian/config`, {
            headers: { 'x-forwarded-for': '203.0.113.1' },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(`${ctx.baseUrl}/api/obsidian/config`, {
            headers: { origin: 'https://malicious.example' },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(
            `${ctx.baseUrl}/api/obsidian/config`,
            json({ vaultPath: vault, allowWrites: true }),
          )
        ).ok,
        true,
      );
      assert.equal(
        (
          await fetch(
            `${ctx.baseUrl}/api/generation/config`,
            json({ llamaCpp: { baseUrl: model.baseUrl } }),
          )
        ).ok,
        true,
      );
      const source = await fetch(`${ctx.baseUrl}/api/obsidian/note`, {
        ...json({ path: 'source.md', content: '# Synthetic source\nKeep this context.' }),
        method: 'POST',
      });
      assert.equal(source.status, 201);
      const search = await (await fetch(`${ctx.baseUrl}/api/obsidian/search?q=synthetic`)).json();
      assert.equal(search.hits[0].path, 'source.md');
      const traversal = await fetch(`${ctx.baseUrl}/api/obsidian/note?path=../outside.md`);
      assert.equal(traversal.status, 400);
      const response = await fetch(`${ctx.baseUrl}/api/generation/chat/stream`, {
        ...json({
          provider: 'llama-cpp',
          model: 'Synthetic Model X',
          prompt: 'Create, update and delete the test note using vault context.',
          ephemeral: true,
          useObsidian: true,
        }),
        method: 'POST',
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const events = [];
      let token;
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          events.push(event);
          if (event.type === 'vault-approval') {
            token = event.approval.token;
            assert.equal(await readFile(join(vault, 'note.md'), 'utf8'), '# Updated\n[[source]]');
            const url = `${ctx.baseUrl}/api/obsidian/approvals/${event.approval.id}`;
            assert.equal(
              (await fetch(url, { ...json({ token, approve: true }), method: 'POST' })).status,
              409,
            );
            assert.equal(
              (
                await fetch(url, {
                  ...json({ token, approve: true, acknowledged: true }),
                  method: 'POST',
                })
              ).ok,
              true,
            );
          }
        }
        if (done) break;
      }
      assert.equal(events.at(-1).type, 'done');
      assert.match(events.at(-1).response.content, /completed/);
      assert.equal(
        events.some((event) => event.phase === 'saving'),
        false,
      );
      assert.equal(
        (await (await fetch(`${ctx.baseUrl}/api/generation/threads`)).json()).threads.length,
        0,
      );
      await assert.rejects(readFile(join(vault, 'note.md')));
      assert.equal(
        await readFile(join(vault, 'source.md'), 'utf8'),
        '# Synthetic source\nKeep this context.',
      );
      assert.equal(
        JSON.stringify(model.requests).includes(token),
        false,
        'Browser approval capability must never be sent to the model',
      );
      assert.equal(model.requests.length, 6);
      const readOnly = await fetch(`${ctx.baseUrl}/api/obsidian/config`, {
        ...json({ allowWrites: false }),
        method: 'PATCH',
      });
      assert.equal(readOnly.ok, true);
      assert.equal((await readOnly.json()).vaultPath, vault);
      const blocked = await fetch(`${ctx.baseUrl}/api/obsidian/note`, {
        ...json({ path: 'blocked.md', content: 'test' }),
        method: 'POST',
      });
      assert.equal(blocked.status, 400);
      await assert.rejects(readFile(join(vault, 'blocked.md')));
    } finally {
      await ctx.stop();
      await model.close();
    }
  },
);
