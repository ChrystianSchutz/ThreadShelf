import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { getStrataBaseUrl, parseStrataBaseUrl } from '../src/generation/config.js';
import { createStrataProvider, parseStrataModel } from '../src/generation/providers/strata.js';
import { validateChatRequest } from '../src/generation/service.js';
import { validateTurn } from '../src/validation.js';

const originalBaseUrl = process.env.STRATA_BASE_URL;
const originalApiKey = process.env.STRATA_API_KEY;

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.STRATA_BASE_URL;
  else process.env.STRATA_BASE_URL = originalBaseUrl;
  if (originalApiKey === undefined) delete process.env.STRATA_API_KEY;
  else process.env.STRATA_API_KEY = originalApiKey;
});

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const sseResponse = (chunks) =>
  new Response(
    [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join(
      ': keep-alive\n\n',
    ),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );

describe('Strata provider', () => {
  it('defaults to the loopback Strata port and accepts a /v1 suffix override', () => {
    delete process.env.STRATA_BASE_URL;
    assert.strictEqual(getStrataBaseUrl(), 'http://127.0.0.1:8080');
    process.env.STRATA_BASE_URL = 'http://localhost:9090/v1/';
    assert.strictEqual(getStrataBaseUrl(), 'http://localhost:9090');
  });

  it('refuses a non-loopback Strata URL', () => {
    process.env.STRATA_BASE_URL = 'http://192.168.1.10:8080';
    assert.throws(() => getStrataBaseUrl(), /loopback-only/);
  });

  it('lists the served model with its context window', async () => {
    delete process.env.STRATA_BASE_URL;
    const calls = [];
    const provider = createStrataProvider(async (url) => {
      calls.push(String(url));
      return jsonResponse({
        object: 'list',
        data: [{ id: 'qwen-test', status: { value: 'loaded' }, meta: { n_ctx: 32768 } }],
      });
    });
    const models = await provider.listModels();
    assert.deepStrictEqual(calls, ['http://127.0.0.1:8080/v1/models']);
    assert.deepStrictEqual(models, [
      {
        id: 'qwen-test',
        name: 'qwen-test',
        provider: 'strata',
        contextLength: 32768,
        loaded: true,
      },
    ]);
  });

  it('reports a clear error when Strata is not running', async () => {
    const provider = createStrataProvider(async () => {
      throw new TypeError('fetch failed');
    });
    await assert.rejects(provider.listModels(), /Strata is not running at .*START-HERE\.bat/);
    const status = await provider.status();
    assert.strictEqual(status.available, false);
    assert.strictEqual(status.local, true);
  });

  it('reports availability from /health', async () => {
    const provider = createStrataProvider(async () =>
      jsonResponse({ status: 'ok', model: 'qwen-test', loaded: true, service: 'strata' }),
    );
    const status = await provider.status();
    assert.strictEqual(status.available, true);
    assert.match(status.detail, /qwen-test/);
  });

  it('streams content and reasoning through the OpenAI-compatible endpoint', async () => {
    delete process.env.STRATA_BASE_URL;
    const calls = [];
    const provider = createStrataProvider(async (url, init) => {
      calls.push({ url: String(url), init });
      return sseResponse([
        { model: 'qwen-test', choices: [{ delta: { role: 'assistant', content: '' } }] },
        { model: 'qwen-test', choices: [{ delta: { reasoning_content: 'thinking' } }] },
        { model: 'qwen-test', choices: [{ delta: { content: 'Hello' } }] },
        { model: 'qwen-test', choices: [{ delta: { content: ' there' } }] },
        {
          model: 'qwen-test',
          choices: [],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        },
      ]);
    });
    const deltas = [];
    const response = await provider.chatStream(
      {
        provider: 'strata',
        model: 'qwen-test',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 64,
        temperature: 0.7,
      },
      (delta) => deltas.push(delta),
    );
    assert.strictEqual(calls[0].url, 'http://127.0.0.1:8080/v1/chat/completions');
    assert.strictEqual(new Headers(calls[0].init.headers).get('authorization'), null);
    assert.strictEqual(calls[0].init.redirect, 'error');
    const body = JSON.parse(calls[0].init.body);
    assert.strictEqual(body.stream, true);
    assert.strictEqual(body.max_tokens, 64);
    assert.strictEqual(response.provider, 'strata');
    assert.strictEqual(response.content, 'Hello there');
    assert.strictEqual(response.reasoning, 'thinking');
    assert.strictEqual(response.usage?.completionTokens, 3);
    assert.ok(deltas.some((delta) => delta.content === 'Hello'));
  });

  it('is accepted by chat request and stored turn validation', () => {
    const request = validateChatRequest({
      provider: 'strata',
      model: 'qwen-test',
      messages: [{ role: 'user', content: 'hi' }],
      openRouterZdr: true,
    });
    assert.strictEqual(request.provider, 'strata');
    assert.strictEqual(request.openRouterZdr, undefined);
    assert.doesNotThrow(() =>
      validateTurn({ ai: 'answer', generationProvider: 'strata' }, { index: 0 }),
    );
  });

  it('normalizes and validates STRATA_BASE_URL values', () => {
    assert.strictEqual(parseStrataBaseUrl(undefined), 'http://127.0.0.1:8080');
    assert.strictEqual(parseStrataBaseUrl('   '), 'http://127.0.0.1:8080');
    assert.strictEqual(parseStrataBaseUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
    assert.strictEqual(parseStrataBaseUrl('http://127.0.0.1:8080/V1'), 'http://127.0.0.1:8080');
    assert.strictEqual(parseStrataBaseUrl('http://[::1]:8080/v1'), 'http://[::1]:8080');
    for (const [value, pattern] of [
      ['http://example.com:8080', /loopback-only/],
      ['http://10.0.0.5:8080', /loopback-only/],
      ['http://user:secret@127.0.0.1:8080', /credentials/],
      ['http://127.0.0.1:8080/v1?token=x', /query strings/],
      ['not a url', /STRATA_BASE_URL/],
    ]) {
      assert.throws(() => parseStrataBaseUrl(value), pattern, value);
    }
  });

  it('reports an invalid STRATA_BASE_URL as unavailable instead of throwing', async () => {
    process.env.STRATA_BASE_URL = 'http://192.168.1.10:8080';
    let called = false;
    const provider = createStrataProvider(async () => {
      called = true;
      return jsonResponse({});
    });
    const status = await provider.status();
    assert.strictEqual(status.available, false);
    assert.match(status.detail, /STRATA_BASE_URL.*loopback-only/);
    assert.strictEqual(called, false, 'no request may leave for a refused URL');
    await assert.rejects(provider.listModels(), /loopback-only/);
  });

  it('treats a non-JSON or failing /health as not ready', async () => {
    delete process.env.STRATA_BASE_URL;
    let provider = createStrataProvider(
      async () => new Response('<html>Bad gateway</html>', { status: 502 }),
    );
    let status = await provider.status();
    assert.strictEqual(status.available, false);
    assert.match(status.detail, /not ready \(HTTP 502\)/);

    provider = createStrataProvider(async () => jsonResponse({ status: 'loading', loaded: false }));
    status = await provider.status();
    assert.strictEqual(status.available, false);
    assert.match(status.detail, /not ready \(loading\)/);
  });

  it('rejects malformed model lists with a clear message and drops bad or duplicate entries', async () => {
    delete process.env.STRATA_BASE_URL;
    await assert.rejects(
      createStrataProvider(async () => new Response('nope', { status: 200 })).listModels(),
      /invalid models list \(not JSON\)/,
    );
    await assert.rejects(
      createStrataProvider(async () => jsonResponse({ data: 'x' })).listModels(),
      /invalid models list/,
    );
    await assert.rejects(
      createStrataProvider(async () => jsonResponse({ error: 'boom' }, 500)).listModels(),
      /HTTP 500/,
    );
    const models = await createStrataProvider(async () =>
      jsonResponse({
        data: [
          { id: 'a' },
          { id: 'a', status: { value: 'loaded' } },
          { id: '' },
          { name: 'no id' },
          null,
          { id: 'b', status: { value: 'loading' }, meta: { n_ctx: -1 } },
        ],
      }),
    ).listModels();
    assert.deepStrictEqual(
      models.map((model) => [model.id, model.loaded, model.contextLength]),
      [
        ['a', true, undefined],
        ['b', false, undefined],
      ],
    );
    assert.deepStrictEqual(
      await createStrataProvider(async () => jsonResponse({})).listModels(),
      [],
    );
  });

  it('counts only an explicit non-loaded status as not loaded', () => {
    assert.strictEqual(parseStrataModel({ id: 'm' }).loaded, true);
    assert.strictEqual(parseStrataModel({ id: 'm', status: { value: 'loaded' } }).loaded, true);
    assert.strictEqual(parseStrataModel({ id: 'm', status: { value: 'unloaded' } }).loaded, false);
    assert.strictEqual(parseStrataModel({ id: 'm', meta: { n_ctx: 4096 } }).contextLength, 4096);
    assert.strictEqual(parseStrataModel({ id: 42 }), undefined);
  });

  it('names the URL when a chat cannot connect, but keeps a user abort an abort', async () => {
    delete process.env.STRATA_BASE_URL;
    const request = {
      provider: 'strata',
      model: 'qwen-test',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const down = createStrataProvider(async () => {
      throw new TypeError('fetch failed');
    });
    await assert.rejects(
      down.chatStream(request, () => {}),
      /Strata is not running at http:\/\/127\.0\.0\.1:8080/,
    );
    await assert.rejects(down.chat(request), /Strata is not running/);

    const controller = new AbortController();
    const aborting = createStrataProvider(async (_url, init) => {
      controller.abort();
      throw init.signal.reason ?? new DOMException('Aborted', 'AbortError');
    });
    await assert.rejects(
      aborting.chatStream(request, () => {}, controller.signal),
      (error) => {
        assert.doesNotMatch(String(error?.message), /not running/);
        return true;
      },
    );
  });

  it('refuses redirects and sends a configured key on every request', async () => {
    delete process.env.STRATA_BASE_URL;
    process.env.STRATA_API_KEY = ' strata-secret ';
    const calls = [];
    const provider = createStrataProvider(async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/health')) return jsonResponse({ status: 'ok' });
      if (String(url).endsWith('/v1/models')) return jsonResponse({ data: [{ id: 'm' }] });
      return sseResponse([{ model: 'm', choices: [{ delta: { content: 'ok' } }] }]);
    });
    await provider.status();
    await provider.listModels();
    await provider.chatStream(
      { provider: 'strata', model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      () => {},
    );
    assert.deepStrictEqual(
      calls.map(({ url }) => url.replace('http://127.0.0.1:8080', '')),
      ['/health', '/v1/models', '/v1/chat/completions'],
    );
    for (const { url, init } of calls) {
      assert.strictEqual(init.redirect, 'error', url);
      assert.strictEqual(
        new Headers(init.headers).get('authorization'),
        'Bearer strata-secret',
        url,
      );
    }
  });

  it('reports a redirecting server as not running instead of following it', async () => {
    delete process.env.STRATA_BASE_URL;
    // Real fetch with redirect: 'error' rejects with a TypeError on a 3xx.
    const provider = createStrataProvider(async (_url, init) => {
      assert.strictEqual(init.redirect, 'error');
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    });
    await assert.rejects(
      provider.chat({
        provider: 'strata',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      /Strata is not running at http:\/\/127\.0\.0\.1:8080/,
    );
  });
});
