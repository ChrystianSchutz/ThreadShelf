import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from '@lancedb/lancedb';
import { ingestViaNdjson, repoRoot, startApiServer } from './helpers.js';

const startOpenRouterStub = async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (req.url.startsWith('/api/v1/models')) {
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'test/live-model',
              name: 'Live Model',
              context_length: 65536,
              pricing: { prompt: '0.000001', completion: '0.000002' },
            },
            {
              id: 'test/free-model:free',
              name: 'Free Model',
              context_length: 32768,
              created: 1_700_000_000,
              pricing: { prompt: '0', completion: '0' },
            },
          ],
        }),
      );
      return;
    }
    if (req.url === '/api/v1/chat/completions') {
      if (body?.stream === true) {
        res.setHeader('content-type', 'text/event-stream');
        res.write(
          'data: {"model":"test/live-model","choices":[{"delta":{"content":"Stubbed "}}]}\n\n',
        );
        res.write('data: {"choices":[{"delta":{"content":"continuation"}}]}\n\n');
        res.write(
          'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":3,"total_tokens":23},"timings":{"prompt_per_second":120.5,"predicted_per_second":42.25,"predicted_ms":71}}\n\n',
        );
        res.end('data: [DONE]\n\n');
        return;
      }
      res.end(
        JSON.stringify({
          model: 'test/live-model',
          choices: [{ message: { content: 'Stubbed continuation' } }],
          usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
          timings: {
            prompt_per_second: 120.5,
            predicted_per_second: 42.25,
            predicted_ms: 71,
          },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    llamaBaseUrl: `http://127.0.0.1:${port}`,
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

describe('generation API E2E', () => {
  it(
    'configures a session-only key, discovers current models, and continues a stored thread privately',
    { timeout: 180_000 },
    async () => {
      const openRouter = await startOpenRouterStub();
      const ctx = await startApiServer({
        prefix: 'threadshelf-generation-',
        env: { OPENROUTER_BASE_URL: openRouter.baseUrl },
      });
      try {
        let response = await fetch(`${ctx.baseUrl}/api/generation/config`);
        assert.strictEqual(response.ok, true);
        let config = await response.json();
        assert.strictEqual('experimentalAlpha' in config.config, false);
        assert.strictEqual(config.config.openRouter.apiKeyConfigured, false);
        assert.strictEqual(JSON.stringify(config).includes('session-secret'), false);

        response = await fetch(`${ctx.baseUrl}/api/generation/config`, {
          headers: { 'x-forwarded-for': '203.0.113.7' },
        });
        assert.strictEqual(response.status, 403, 'remote clients must not read local config');
        response = await fetch(`${ctx.baseUrl}/api/generation/models?provider=openrouter`, {
          headers: { 'x-forwarded-for': '203.0.113.7' },
        });
        assert.strictEqual(response.status, 403, 'remote clients must not invoke model discovery');

        response = await fetch(`${ctx.baseUrl}/api/generation/config`, {
          method: 'PUT',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': '203.0.113.7',
          },
          body: JSON.stringify({ openRouter: { apiKey: 'remote-secret' } }),
        });
        assert.strictEqual(response.status, 403);

        response = await fetch(`${ctx.baseUrl}/api/generation/config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            openRouter: {
              apiKey: 'session-secret',
              enforceZdr: true,
              denyDataCollection: true,
            },
          }),
        });
        assert.strictEqual(response.ok, true);
        config = await response.json();
        assert.strictEqual(config.config.openRouter.apiKeyConfigured, true);
        assert.strictEqual(JSON.stringify(config).includes('session-secret'), false);

        response = await fetch(`${ctx.baseUrl}/api/generation/config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            llamaCpp: { executablePath: '\\\\host\\share\\llama-server.exe' },
          }),
        });
        assert.strictEqual(response.status, 400);

        response = await fetch(`${ctx.baseUrl}/api/generation/models?provider=openrouter`);
        assert.strictEqual(response.ok, true);
        const modelData = await response.json();
        assert.deepStrictEqual(
          modelData.models.map((model) => model.id),
          ['test/live-model', 'test/free-model:free'],
        );
        assert.strictEqual(modelData.runtime.state, 'remote');

        response = await fetch(
          `${ctx.baseUrl}/api/generation/models?provider=openrouter&sort=most-popular&free=1`,
        );
        const freeModelData = await response.json();
        assert.deepStrictEqual(
          freeModelData.models.map((model) => model.id),
          ['test/free-model:free'],
        );
        assert.ok(openRouter.requests.some((request) => request.url.includes('sort=most-popular')));

        response = await fetch(`${ctx.baseUrl}/api/generation/runtime`);
        assert.strictEqual((await response.json()).runtime.state, 'stopped');
        response = await fetch(`${ctx.baseUrl}/api/generation/runtime/logs`);
        assert.strictEqual(response.ok, true);
        assert.ok((await response.json()).offload);
        response = await fetch(`${ctx.baseUrl}/api/generation/runtime/logs`, {
          headers: { 'x-forwarded-for': '203.0.113.7' },
        });
        assert.strictEqual(response.status, 403);
        response = await fetch(`${ctx.baseUrl}/api/generation/runtime/eject`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        assert.strictEqual((await response.json()).runtime.state, 'stopped');

        response = await fetch(`${ctx.baseUrl}/api/generation/config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ llamaCpp: { baseUrl: openRouter.llamaBaseUrl } }),
        });
        assert.strictEqual(response.ok, true);
        response = await fetch(`${ctx.baseUrl}/api/generation/runtime`);
        assert.strictEqual((await response.json()).runtime.model, undefined);
        response = await fetch(`${ctx.baseUrl}/api/generation/runtime/eject`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        assert.strictEqual(response.status, 409);
        assert.match((await response.json()).error, /No model is loaded/);
        response = await fetch(`${ctx.baseUrl}/api/generation/config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ llamaCpp: { baseUrl: '' } }),
        });
        assert.strictEqual(response.ok, true);

        response = await fetch(
          `${ctx.baseUrl}/api/generation/directories?path=${encodeURIComponent(ctx.tempRoot)}`,
        );
        assert.strictEqual(response.ok, true);
        assert.strictEqual((await response.json()).path, ctx.tempRoot);

        const exportsDir = join(ctx.tempRoot, 'single-export');
        await mkdir(exportsDir);
        await copyFile(
          join(repoRoot, 'test', 'fixtures', 'lmstudio-polish.json'),
          join(exportsDir, 'conversation.json'),
        );
        await ingestViaNdjson(ctx.baseUrl, exportsDir, 'generation_fixture', true);
        response = await fetch(`${ctx.baseUrl}/api/files?collection=generation_fixture`);
        const files = await response.json();
        const thread = files.files[0];
        assert.ok(thread?.sourceFile);

        response = await fetch(`${ctx.baseUrl}/api/generation/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            provider: 'openrouter',
            model: 'test/live-model',
            prompt: 'Continue safely',
            systemPrompt: 'Master prompt: stay terse.',
            sourceFile: thread.sourceFile,
            collection: 'generation_fixture',
            conversationKey: thread.conversationKey,
            continuation: [
              { role: 'user', content: 'Session follow-up' },
              { role: 'assistant', content: 'Session response' },
            ],
          }),
        });
        assert.strictEqual(response.ok, true);
        const generated = await response.json();
        assert.strictEqual(generated.content, 'Stubbed continuation');
        assert.strictEqual(generated.persistence.saved, true);
        assert.strictEqual(generated.persistence.indexed, true);

        response = await fetch(
          `${ctx.baseUrl}/api/thread?collection=generation_fixture&sourceFile=${encodeURIComponent(thread.sourceFile)}&conversationKey=${encodeURIComponent(thread.conversationKey)}`,
        );
        const continuedThread = await response.json();
        assert.deepStrictEqual(
          continuedThread.turns.slice(-2).map((turn) => ({
            text: turn.user ?? turn.ai,
            createdInThreadShelf: turn.createdInThreadShelf,
            generationProvider: turn.generationProvider,
            model: turn.model,
          })),
          [
            {
              text: 'Continue safely',
              createdInThreadShelf: true,
              generationProvider: 'openrouter',
              model: 'test/live-model',
            },
            {
              text: 'Stubbed continuation',
              createdInThreadShelf: true,
              generationProvider: 'openrouter',
              model: 'test/live-model',
            },
          ],
        );

        response = await fetch(
          `${ctx.baseUrl}/api/search?q=${encodeURIComponent('Continue safely')}&collection=generation_fixture&mode=keyword&origin=threadshelf`,
        );
        let originResults = await response.json();
        assert.strictEqual(originResults.results[0].metadata.createdInThreadShelf, true);
        assert.strictEqual(originResults.results[0].metadata.provider, 'threadshelf');
        response = await fetch(
          `${ctx.baseUrl}/api/search?q=${encodeURIComponent('Continue safely')}&collection=generation_fixture&mode=keyword&origin=archive`,
        );
        originResults = await response.json();
        assert.deepStrictEqual(originResults.results, []);
        response = await fetch(`${ctx.baseUrl}/api/files?collection=generation_fixture`);
        const continuedFiles = await response.json();
        assert.strictEqual(continuedFiles.files[0].createdInThreadShelf, false);
        assert.strictEqual(continuedFiles.files[0].hasThreadShelfTurns, true);
        response = await fetch(
          `${ctx.baseUrl}/api/search?q=test&collection=generation_fixture&origin=invalid`,
        );
        assert.strictEqual(response.status, 400);

        const chatRequest = openRouter.requests.find((request) =>
          request.url.endsWith('/chat/completions'),
        );
        assert.strictEqual(chatRequest.headers.authorization, 'Bearer session-secret');
        assert.deepStrictEqual(chatRequest.body.provider, {
          zdr: true,
          data_collection: 'deny',
        });
        assert.strictEqual(
          chatRequest.body.messages.some((message) => message.content.includes('Rozbijam')),
          false,
          'archived thinking must not be sent to generation providers',
        );
        assert.deepStrictEqual(
          chatRequest.body.messages.slice(-3).map((message) => message.content),
          ['Session follow-up', 'Session response', 'Continue safely'],
        );
        // The master prompt leads the request but is never stored with the thread.
        assert.deepStrictEqual(chatRequest.body.messages[0], {
          role: 'system',
          content: 'Master prompt: stay terse.',
        });
        assert.strictEqual(
          continuedThread.turns.some((turn) =>
            [turn.user, turn.ai, turn.thinking].some((text) =>
              String(text ?? '').includes('Master prompt'),
            ),
          ),
          false,
          'the master prompt must not be persisted into the archived thread',
        );

        response = await fetch(`${ctx.baseUrl}/api/generation/chat/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            provider: 'openrouter',
            model: 'test/live-model',
            prompt: 'Stream safely',
            sourceFile: thread.sourceFile,
            collection: 'generation_fixture',
            conversationKey: thread.conversationKey,
          }),
        });
        assert.strictEqual(response.ok, true);
        assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
        const events = (await response.text())
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert.deepStrictEqual(
          events.filter((event) => event.type === 'status').map((event) => event.phase),
          ['preparing', 'connecting', 'generating', 'saving'],
        );
        assert.strictEqual(
          events
            .filter((event) => event.type === 'delta')
            .map((event) => event.content)
            .join(''),
          'Stubbed continuation',
        );
        assert.strictEqual(events.at(-1).type, 'done');
        assert.strictEqual(events.at(-1).response.usage.totalTokens, 23);
        assert.strictEqual(events.at(-1).response.performance.completionTokensPerSecond, 42.25);

        response = await fetch(`${ctx.baseUrl}/api/generation/chat/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            provider: 'openrouter',
            model: 'test/live-model',
            prompt: 'Private question',
            ephemeral: true,
            continuation: [{ role: 'user', content: 'Private context' }],
          }),
        });
        assert.strictEqual(response.ok, true);
        const privateEvents = (await response.text())
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert.match(privateEvents[0].message, /private in-memory chat/);
        assert.strictEqual(
          privateEvents.some((event) => event.phase === 'saving'),
          false,
        );
        assert.strictEqual(privateEvents.at(-1).response.persistence, undefined);
        response = await fetch(`${ctx.baseUrl}/api/generation/threads`);
        assert.deepStrictEqual((await response.json()).threads, []);
        const privateDatabase = await connect(join(ctx.tempRoot, '.lancedb'));
        const privateThreads = await privateDatabase.openTable('__threads');
        assert.strictEqual(
          await privateThreads.countRows("collection = 'threadshelf_conversations'"),
          0,
        );
        assert.strictEqual(
          (await privateDatabase.tableNames()).includes('threadshelf_conversations'),
          false,
        );

        response = await fetch(`${ctx.baseUrl}/api/generation/threads`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': '203.0.113.7',
          },
          body: '{}',
        });
        assert.strictEqual(response.status, 403, 'remote clients must not create local chats');

        response = await fetch(`${ctx.baseUrl}/api/generation/threads`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        assert.strictEqual(response.status, 201);
        const createdChat = await response.json();
        assert.strictEqual(createdChat.title, 'New chat');
        assert.strictEqual(createdChat.createdInThreadShelf, true);
        assert.strictEqual(createdChat.turnCount, 0);
        assert.deepStrictEqual(createdChat.turns, []);

        response = await fetch(`${ctx.baseUrl}/api/generation/threads`);
        assert.strictEqual(response.ok, true);
        let savedChats = await response.json();
        assert.deepStrictEqual(
          savedChats.threads.map((chat) => chat.id),
          [createdChat.id],
        );
        response = await fetch(`${ctx.baseUrl}/api/files?collection=threadshelf_conversations`);
        const emptyChatFiles = await response.json();
        assert.strictEqual(response.ok, true);
        assert.deepStrictEqual(
          emptyChatFiles.files.map((file) => [file.conversationKey, file.turnCount]),
          [[createdChat.id, 0]],
          'an empty saved chat must be listed before any embedding chunks exist',
        );

        response = await fetch(`${ctx.baseUrl}/api/generation/chat/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            provider: 'openrouter',
            model: 'test/live-model',
            prompt: 'A durable first message',
            threadId: createdChat.id,
          }),
        });
        assert.strictEqual(response.ok, true);
        const chatEvents = (await response.text())
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert.match(chatEvents[0].message, /locally saved ThreadShelf chat/);
        assert.strictEqual(
          chatEvents.some((event) => event.phase === 'saving'),
          true,
        );
        assert.strictEqual(chatEvents.at(-1).type, 'done');
        assert.strictEqual(chatEvents.at(-1).response.persistence.indexed, true);

        response = await fetch(
          `${ctx.baseUrl}/api/generation/threads/${encodeURIComponent(createdChat.id)}`,
        );
        assert.strictEqual(response.ok, true);
        let savedChat = await response.json();
        assert.strictEqual(savedChat.createdInThreadShelf, true);
        assert.strictEqual(savedChat.title, 'A durable first message');
        assert.strictEqual(savedChat.model, 'test/live-model');
        assert.deepStrictEqual(
          savedChat.turns.map((turn) => turn.user ?? turn.ai),
          ['A durable first message', 'Stubbed continuation'],
        );
        assert.ok(savedChat.turns.every((turn) => turn.createdInThreadShelf === true));

        response = await fetch(`${ctx.baseUrl}/api/collections`);
        assert.ok((await response.json()).collections.includes('threadshelf_conversations'));
        response = await fetch(`${ctx.baseUrl}/api/collections/threadshelf_conversations`, {
          method: 'DELETE',
        });
        assert.strictEqual(response.status, 400);
        response = await fetch(`${ctx.baseUrl}/api/collections/threadshelf_conversations/clear`, {
          method: 'POST',
        });
        assert.strictEqual(response.status, 400);
        response = await fetch(`${ctx.baseUrl}/api/files?collection=threadshelf_conversations`);
        const createdFiles = await response.json();
        assert.strictEqual(createdFiles.files[0].createdInThreadShelf, true);
        assert.strictEqual(createdFiles.files[0].hasThreadShelfTurns, true);

        response = await fetch(
          `${ctx.baseUrl}/api/search?q=${encodeURIComponent('durable first message')}&collection=threadshelf_conversations&origin=threadshelf`,
        );
        const semanticChatSearch = await response.json();
        assert.ok(semanticChatSearch.results.length > 0);
        assert.strictEqual(semanticChatSearch.results[0].metadata.createdInThreadShelf, true);
        assert.strictEqual(semanticChatSearch.results[0].metadata.collection, undefined);

        response = await fetch(`${ctx.baseUrl}/api/generation/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            provider: 'openrouter',
            model: 'test/live-model',
            prompt: 'Use the saved context',
            threadId: createdChat.id,
          }),
        });
        assert.strictEqual(response.ok, true);
        const latestChatRequest = openRouter.requests
          .filter((request) => request.url.endsWith('/chat/completions'))
          .at(-1);
        assert.deepStrictEqual(
          latestChatRequest.body.messages.map((message) => message.content),
          ['A durable first message', 'Stubbed continuation', 'Use the saved context'],
        );

        response = await fetch(
          `${ctx.baseUrl}/api/generation/threads/${encodeURIComponent(createdChat.id)}`,
        );
        savedChat = await response.json();
        assert.strictEqual(savedChat.turnCount, 4);
        response = await fetch(`${ctx.baseUrl}/api/generation/threads`);
        savedChats = await response.json();
        assert.strictEqual(savedChats.threads[0].createdInThreadShelf, true);
        assert.strictEqual(savedChats.threads[0].turnCount, 4);
        assert.strictEqual(savedChats.threads[0].model, 'test/live-model');

        response = await fetch(`${ctx.baseUrl}/api/generation/threads`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            turns: [
              { user: 'Promoted private question', model: 'test/live-model' },
              { ai: 'Promoted private answer', model: 'test/live-model' },
            ],
          }),
        });
        assert.strictEqual(response.status, 201);
        const promotedChat = await response.json();
        assert.strictEqual(promotedChat.title, 'Promoted private question');
        assert.strictEqual(promotedChat.turnCount, 2);
        response = await fetch(`${ctx.baseUrl}/api/collections/threadshelf_conversations/stats`);
        const chatStats = await response.json();
        assert.strictEqual(chatStats.conversations, 2);

        response = await fetch(
          `${ctx.baseUrl}/api/generation/threads/${encodeURIComponent(promotedChat.id)}`,
          { method: 'DELETE' },
        );
        assert.strictEqual(response.ok, true);
        response = await fetch(`${ctx.baseUrl}/api/generation/threads`);
        savedChats = await response.json();
        assert.deepStrictEqual(
          savedChats.threads.map((item) => item.id),
          [createdChat.id],
        );

        response = await fetch(`${ctx.baseUrl}/api/generation/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            provider: 'openrouter',
            model: 'test/live-model',
            prompt: 'Reject duplicate client history',
            threadId: createdChat.id,
            continuation: [],
          }),
        });
        assert.strictEqual(response.status, 400);
        assert.match((await response.json()).error, /stored history/);

        response = await fetch(`${ctx.baseUrl}/api/generation/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'unknown' }),
        });
        assert.strictEqual(response.status, 400);
      } finally {
        await ctx.stop();
        await openRouter.close();
      }
    },
  );

  it('stores master prompts server-side and keeps them loopback-only', async () => {
    const ctx = await startApiServer({ prefix: 'threadshelf-master-prompts-' });
    try {
      const post = (path, method, body) =>
        fetch(`${ctx.baseUrl}${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });

      let response = await fetch(`${ctx.baseUrl}/api/generation/prompts`);
      assert.strictEqual(response.ok, true);
      assert.deepStrictEqual(await response.json(), { prompts: [], activeId: '' });

      response = await post('/api/generation/prompts', 'POST', {
        name: 'Terse',
        text: 'Answer in one sentence.',
      });
      assert.strictEqual(response.status, 201);
      let collection = await response.json();
      const promptId = collection.prompts[0].id;
      assert.strictEqual(collection.activeId, promptId);

      response = await post('/api/generation/prompts', 'POST', { text: '  ' });
      assert.strictEqual(response.status, 400);
      assert.match((await response.json()).error, /cannot be empty/);

      // The literal 'active' segment must not be read as a prompt id.
      response = await post('/api/generation/prompts/active', 'PUT', { id: '' });
      assert.strictEqual((await response.json()).activeId, '');
      response = await post('/api/generation/prompts/active', 'PUT', { id: promptId });
      assert.strictEqual((await response.json()).activeId, promptId);
      response = await post('/api/generation/prompts/active', 'PUT', { id: 'nope' });
      assert.strictEqual(response.status, 400);

      response = await post(`/api/generation/prompts/${promptId}`, 'PATCH', {
        text: 'Answer in two sentences.',
      });
      collection = await response.json();
      assert.strictEqual(collection.prompts[0].text, 'Answer in two sentences.');

      // A restart is the whole reason this is not browser storage.
      response = await fetch(`${ctx.baseUrl}/api/generation/prompts`);
      assert.deepStrictEqual(await response.json(), collection);

      for (const [path, method] of [
        ['/api/generation/prompts', 'GET'],
        ['/api/generation/prompts', 'POST'],
        [`/api/generation/prompts/${promptId}`, 'DELETE'],
      ]) {
        response = await fetch(`${ctx.baseUrl}${path}`, {
          method,
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
          body: method === 'POST' ? JSON.stringify({ text: 'remote' }) : undefined,
        });
        assert.strictEqual(response.status, 403, `${method} ${path} must reject remote clients`);
      }

      response = await post(`/api/generation/prompts/${promptId}`, 'DELETE');
      assert.deepStrictEqual(await response.json(), { prompts: [], activeId: '' });
    } finally {
      await ctx.stop();
    }
  });
});
