import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startApiServer } from './helpers.js';

const readNdjson = async (response) =>
  (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

/** A loopback stand-in for a separately started Strata server. */
const startFakeStrata = async () => {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        body: body ? JSON.parse(body) : undefined,
      });
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', loaded: true, model: 'strata-model' }));
        return;
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [{ id: 'strata-model', status: { value: 'loaded' }, meta: { n_ctx: 32768 } }],
          }),
        );
        return;
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const content of ['Strata ', 'says hi']) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        }
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

describe('Strata provider (API E2E)', { timeout: 180000 }, () => {
  let strata;
  let ctx;

  before(async () => {
    strata = await startFakeStrata();
    // A `/v1` suffix and a trailing slash are both accepted.
    ctx = await startApiServer({
      prefix: 'threadshelf-strata-',
      env: { STRATA_BASE_URL: `${strata.baseUrl}/v1/` },
    });
  });

  after(async () => {
    await ctx?.stop();
    await strata?.close();
  });

  it('lists the served model with an external runtime card', async () => {
    const response = await fetch(`${ctx.baseUrl}/api/generation/models?provider=strata`);
    assert.strictEqual(response.ok, true);
    const payload = await response.json();
    assert.deepStrictEqual(
      payload.models.map((model) => [model.id, model.provider, model.contextLength, model.loaded]),
      [['strata-model', 'strata', 32768, true]],
    );
    assert.strictEqual(payload.runtime.state, 'external');
    assert.strictEqual(payload.runtime.model, 'strata-model');
    assert.strictEqual(payload.runtime.contextSize, 32768);
    assert.match(payload.runtime.detail, /Strata server at http:\/\/127\.0\.0\.1:\d+\./);
  });

  it('streams a saved chat and stores the turn as a Strata generation', async () => {
    let response = await fetch(`${ctx.baseUrl}/api/generation/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(response.status, 201);
    const chat = await response.json();

    response = await fetch(`${ctx.baseUrl}/api/generation/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'strata',
        model: 'strata-model',
        prompt: 'Hello Strata',
        threadId: chat.id,
      }),
    });
    assert.strictEqual(response.ok, true);
    const events = await readNdjson(response);
    assert.strictEqual(
      events.some((event) => /Sending to Strata/.test(event.message ?? '')),
      true,
    );
    assert.strictEqual(
      events
        .filter((event) => event.type === 'delta')
        .map((event) => event.content)
        .join(''),
      'Strata says hi',
    );
    assert.strictEqual(events.at(-1).type, 'done');
    assert.strictEqual(events.at(-1).response.provider, 'strata');

    const chatRequest = strata.requests.find((request) => request.url === '/v1/chat/completions');
    assert.strictEqual(chatRequest.body.model, 'strata-model');
    assert.strictEqual(chatRequest.body.stream, true);
    assert.strictEqual(chatRequest.body.messages.at(-1).content, 'Hello Strata');

    response = await fetch(`${ctx.baseUrl}/api/generation/threads/${encodeURIComponent(chat.id)}`);
    const saved = await response.json();
    assert.deepStrictEqual(
      saved.turns.map((turn) => [turn.user ?? turn.ai, turn.generationProvider]),
      [
        ['Hello Strata', 'strata'],
        ['Strata says hi', 'strata'],
      ],
    );
  });
});

describe('Strata provider when the server is down or misconfigured', { timeout: 180000 }, () => {
  it('reports a clear error when nothing listens at STRATA_BASE_URL', async () => {
    const strata = await startFakeStrata();
    const unused = strata.baseUrl;
    await strata.close();
    const ctx = await startApiServer({
      prefix: 'threadshelf-strata-down-',
      env: { STRATA_BASE_URL: unused },
    });
    try {
      const response = await fetch(`${ctx.baseUrl}/api/generation/models?provider=strata`);
      assert.strictEqual(response.ok, false);
      const payload = await response.json();
      assert.match(payload.error, /Strata is not running at http:\/\/127\.0\.0\.1:\d+/);
    } finally {
      await ctx.stop();
    }
  });

  it('refuses a non-loopback STRATA_BASE_URL without crashing the server', async () => {
    const ctx = await startApiServer({
      prefix: 'threadshelf-strata-remote-',
      env: { STRATA_BASE_URL: 'http://192.0.2.10:8080' },
    });
    try {
      let response = await fetch(`${ctx.baseUrl}/api/generation/models?provider=strata`);
      assert.strictEqual(response.ok, false);
      assert.match((await response.json()).error, /STRATA_BASE_URL.*loopback-only/);
      response = await fetch(`${ctx.baseUrl}/api/health`);
      assert.strictEqual(response.ok, true, 'other routes keep working');
    } finally {
      await ctx.stop();
    }
  });
});
