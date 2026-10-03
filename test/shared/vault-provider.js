import { createServer } from 'node:http';

/** Offline OpenAI-compatible tool-calling provider; never connects to a real model. */
export const startVaultProvider = async (
  plan = [{ name: 'obsidian_delete', args: { paths: ['note.md'] } }],
) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'Synthetic Model X' }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    res.setHeader('content-type', 'text/event-stream');
    const results = body.messages.filter((message) => message.role === 'tool');
    const step = plan[results.length];
    if (step) {
      const args =
        typeof step.args === 'function'
          ? step.args(results.map((message) => JSON.parse(message.content)))
          : step.args;
      res.end(
        `data: ${JSON.stringify({ model: 'Synthetic Model X', choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${results.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(args) } }] } }] })}\n\ndata: [DONE]\n\n`,
      );
    } else {
      const last = JSON.parse(results.at(-1).content);
      const answer = last.cancelled
        ? 'Deletion cancelled.'
        : last.error
          ? 'Vault operation was blocked.'
          : 'Vault operation completed.';
      res.end(
        `data: ${JSON.stringify({ model: 'Synthetic Model X', choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`,
      );
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};
