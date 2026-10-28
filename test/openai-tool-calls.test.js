import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  openAiCompatibleChat,
  openAiCompatibleChatStream,
} from '../src/generation/openai-compatible.js';

const tool = (name) => ({
  type: 'function',
  function: {
    name,
    description: 'Synthetic tool',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
});
const request = {
  provider: 'llama-cpp',
  model: 'synthetic-model',
  messages: [{ role: 'user', content: 'Hi' }],
  tools: [tool('obsidian_search'), tool('obsidian_read')],
};
const sse = (events, { crlf = false, done = true } = {}) => {
  const eol = crlf ? '\r\n' : '\n';
  return (
    events.map((event) => `data: ${JSON.stringify(event)}${eol}${eol}`).join('') +
    (done ? `data: [DONE]${eol}${eol}` : '')
  );
};
const deltas = (...toolCalls) =>
  toolCalls.map((calls) => ({ choices: [{ delta: { tool_calls: calls } }] }));

/** Streams the body byte by byte to exercise line reassembly across chunk boundaries. */
const byteStream = (text) => {
  const bytes = new TextEncoder().encode(text);
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= bytes.length) controller.close();
      else controller.enqueue(bytes.subarray(index, ++index));
    },
  });
};
const stream = async (body, input = request) => {
  let sent;
  const response = await openAiCompatibleChatStream(
    {
      provider: 'llama-cpp',
      baseUrl: 'http://127.0.0.1:1',
      request: input,
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(init.body);
        return new Response(body);
      },
    },
    () => {},
  );
  return { response, sent };
};
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: args } });

describe('OpenAI-compatible tool-call streaming', () => {
  it('sends tools with auto choice and no parallel calls only when tools are requested', async () => {
    const { sent } = await stream(sse([{ choices: [{ delta: { content: 'hi' } }] }]));
    assert.equal(sent.tool_choice, 'auto');
    assert.equal(sent.parallel_tool_calls, false);
    assert.equal(sent.tools.length, 2);
    const plain = await stream(sse([{ choices: [{ delta: { content: 'hi' } }] }]), {
      ...request,
      tools: undefined,
    });
    assert.equal('tools' in plain.sent, false);
    assert.equal('tool_choice' in plain.sent, false);
  });

  it('reassembles calls split across bytes, CRLF lines and many fragments', async () => {
    const body = sse(
      deltas(
        [{ index: 0, id: 'call_a', function: { name: 'obsidian_', arguments: '' } }],
        [{ index: 0, function: { name: 'search', arguments: '{"qu' } }],
        [{ index: 0, function: { arguments: 'ery":"ża' } }],
        [{ index: 0, function: { arguments: 'ółć"}' } }],
      ),
      { crlf: true },
    );
    const { response } = await stream(byteStream(body));
    assert.deepEqual(response.toolCalls, [call('call_a', 'obsidian_search', '{"query":"żaółć"}')]);
    assert.equal(response.content, '');
  });

  it('keeps several indexed calls in index order', async () => {
    const { response } = await stream(
      sse(
        deltas(
          [{ index: 1, id: 'b', function: { name: 'obsidian_read', arguments: '{"path":' } }],
          [{ index: 0, id: 'a', function: { name: 'obsidian_search', arguments: '{}' } }],
          [{ index: 1, function: { arguments: '"a.md"}' } }],
        ),
      ),
    );
    assert.deepEqual(response.toolCalls, [
      call('a', 'obsidian_search', '{}'),
      call('b', 'obsidian_read', '{"path":"a.md"}'),
    ]);
  });

  it('tolerates repeated ids/names and a duplicated final copy of complete arguments', async () => {
    const repeat = (args) => [
      { index: 0, id: 'x', function: { name: 'obsidian_search', arguments: args } },
    ];
    const { response } = await stream(
      sse(deltas(repeat('{"query":'), repeat('"a"}'), repeat('{"query":"a"}'))),
    );
    assert.deepEqual(response.toolCalls, [call('x', 'obsidian_search', '{"query":"a"}')]);
  });

  it('assigns calls when a server omits index, and generates missing ids', async () => {
    const { response } = await stream(
      sse(
        deltas(
          [{ id: 'first', function: { name: 'obsidian_search', arguments: '{"query"' } }],
          [{ function: { arguments: ':"a"}' } }],
          [{ id: 'second', function: { name: 'obsidian_read', arguments: '{}' } }],
        ),
      ),
    );
    assert.deepEqual(response.toolCalls, [
      call('first', 'obsidian_search', '{"query":"a"}'),
      call('second', 'obsidian_read', '{}'),
    ]);
    const anonymous = await stream(
      sse(deltas([{ index: 0, function: { name: 'obsidian_read', arguments: '{}' } }])),
    );
    assert.deepEqual(anonymous.response.toolCalls, [call('call_0', 'obsidian_read', '{}')]);
  });

  it('returns text and tool calls together, plus reasoning state only with tools', async () => {
    const body = sse([
      {
        choices: [
          {
            delta: {
              content: 'Let me look.',
              reasoning_details: [{ type: 'reasoning.text', text: 'plan' }],
              tool_calls: [
                { index: 0, id: 'a', function: { name: 'obsidian_search', arguments: '{}' } },
              ],
            },
          },
        ],
      },
    ]);
    const { response } = await stream(body);
    assert.equal(response.content, 'Let me look.');
    assert.equal(response.toolCalls.length, 1);
    assert.deepEqual(response.reasoningDetails, [{ type: 'reasoning.text', text: 'plan' }]);
  });

  const createCall = deltas([
    {
      index: 0,
      id: 'a',
      function: { name: 'obsidian_create', arguments: '{"path":"a.md","content":"x"}' },
    },
  ]);
  const finish = (reason) => [{ choices: [{ delta: {}, finish_reason: reason }] }];

  it('rejects tool calls from a stream that ended without [DONE] or a finish reason', async () => {
    await assert.rejects(stream(sse(createCall, { done: false })), /ended before/);
  });

  it('rejects tool calls from a response cut off by the token limit', async () => {
    await assert.rejects(stream(sse([...createCall, ...finish('length')])), /token limit/);
    await assert.rejects(
      stream(sse([...createCall, ...finish('length')], { done: false })),
      /token limit/,
    );
  });

  it('accepts a stream that omits [DONE] after a finishing finish_reason', async () => {
    for (const reason of ['tool_calls', 'stop']) {
      const { response } = await stream(sse([...createCall, ...finish(reason)], { done: false }));
      assert.equal(response.toolCalls.length, 1);
    }
  });

  it('keeps malformed JSON arguments as text for the agent to report', async () => {
    const { response } = await stream(
      sse(deltas([{ index: 0, id: 'a', function: { name: 'obsidian_search', arguments: '{"q' } }])),
    );
    assert.equal(response.toolCalls[0].function.arguments, '{"q');
  });

  for (const [label, body, pattern] of [
    [
      'an out-of-range index',
      sse(deltas([{ index: 16, id: 'a', function: { name: 'obsidian_read', arguments: '{}' } }])),
      /index/,
    ],
    [
      'a negative index',
      sse(deltas([{ index: -1, id: 'a', function: { name: 'obsidian_read', arguments: '{}' } }])),
      /index/,
    ],
    [
      'a fractional index',
      sse(deltas([{ index: 0.5, id: 'a', function: { name: 'obsidian_read', arguments: '{}' } }])),
      /index/,
    ],
    ['a non-array tool_calls delta', sse(deltas({ index: 0 })), /Invalid tool call delta/],
    [
      'non-string arguments',
      sse(
        deltas([
          { index: 0, id: 'a', function: { name: 'obsidian_read', arguments: { path: 'a.md' } } },
        ]),
      ),
      /arguments/,
    ],
    [
      'oversized arguments',
      sse(
        deltas([
          {
            index: 0,
            id: 'a',
            function: { name: 'obsidian_read', arguments: 'x'.repeat(100_001) },
          },
        ]),
      ),
      /size limit/,
    ],
    [
      'an oversized name',
      sse(deltas([{ index: 0, id: 'a', function: { name: 'n'.repeat(101), arguments: '{}' } }])),
      /size limit/,
    ],
    [
      'an invalid tool name',
      sse(deltas([{ index: 0, id: 'a', function: { name: 'rm -rf', arguments: '{}' } }])),
      /Invalid tool call/,
    ],
    [
      'duplicate call ids',
      sse(
        deltas([
          { index: 0, id: 'same', function: { name: 'obsidian_read', arguments: '{}' } },
          { index: 1, id: 'same', function: { name: 'obsidian_read', arguments: '{}' } },
        ]),
      ),
      /Invalid tool call/,
    ],
    [
      'a call without a name',
      sse(deltas([{ index: 0, id: 'a', function: { arguments: '{}' } }])),
      /Invalid tool call/,
    ],
    [
      'oversized reasoning state',
      sse([
        {
          choices: [
            {
              delta: {
                reasoning_details: [{ type: 'reasoning.text', text: 'x'.repeat(1_000_001) }],
              },
            },
          ],
        },
      ]),
      /exceeds|Invalid provider tool state|size limit/,
    ],
    ['an oversized streaming line', `data: ${'x'.repeat(2_000_001)}`, /size limit/],
  ]) {
    it(`rejects ${label} and cancels the provider stream`, async () => {
      let cancelled = false;
      const encoded = new TextEncoder().encode(body);
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(encoded);
        },
        cancel() {
          cancelled = true;
        },
      });
      await assert.rejects(stream(source), pattern);
      assert.equal(cancelled, true);
    });
  }

  it('rejects tool calls when the request offered none', async () => {
    await assert.rejects(
      stream(
        sse(deltas([{ index: 0, id: 'a', function: { name: 'obsidian_read', arguments: '{}' } }])),
        {
          ...request,
          tools: undefined,
        },
      ),
      /tools are disabled/,
    );
  });

  it('ignores reasoning state when no tools were offered', async () => {
    const { response } = await stream(
      sse([{ choices: [{ delta: { content: 'hi', reasoning_details: [{ type: 'x' }] } }] }]),
      { ...request, tools: undefined },
    );
    assert.equal(response.reasoningDetails, undefined);
  });

  it('still rejects an empty answer without tool calls', async () => {
    await assert.rejects(stream(sse([{ choices: [{ delta: {} }] }])), /empty response/);
  });
});

describe('OpenAI-compatible tool calls (non-streaming)', () => {
  const complete = (message, input = request) =>
    openAiCompatibleChat({
      provider: 'llama-cpp',
      baseUrl: 'http://127.0.0.1:1',
      request: input,
      fetchImpl: async () => Response.json({ choices: [{ message }] }),
    });

  it('accepts tool-only replies and validates every call', async () => {
    const ok = await complete({ content: null, tool_calls: [call('a', 'obsidian_read', '{}')] });
    assert.deepEqual(ok.toolCalls, [call('a', 'obsidian_read', '{}')]);
    assert.equal(ok.content, '');
    await assert.rejects(
      complete({
        content: null,
        tool_calls: [{ id: 'a', function: { name: 'obsidian_read', arguments: '{}' } }],
      }),
      /Invalid tool call/,
    );
    await assert.rejects(
      complete({
        content: null,
        tool_calls: Array.from({ length: 17 }, (_, i) => call(`c${i}`, 'obsidian_read', '{}')),
      }),
      /Invalid tool calls/,
    );
    await assert.rejects(
      complete(
        { content: null, tool_calls: [call('a', 'obsidian_read', '{}')] },
        { ...request, tools: undefined },
      ),
      /tools are disabled/,
    );
  });
});
