import { createServer } from 'node:http';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** Synthetic external llama-server with controllable lookup and inference. */
export const startLocalApiUpstream = async () => {
  const requests = [];
  const gates = [];
  let modelGate, inferenceGate;
  const hold = () => {
    const started = deferred();
    const released = deferred();
    const finished = deferred();
    const disconnected = deferred();
    const gate = {
      started: started.promise,
      finished: finished.promise,
      disconnected: disconnected.promise,
      release: released.resolve,
      begin: started.resolve,
      end: finished.resolve,
      closed: disconnected.resolve,
      wait: released.promise,
    };
    gates.push(gate);
    return gate;
  };
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      const gate = modelGate;
      modelGate = undefined;
      gate?.begin();
      if (gate) await gate.wait;
      res.end(JSON.stringify({ data: [{ id: 'synthetic-model' }] }));
      gate?.end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ path: req.url, body });
    const gate = inferenceGate;
    inferenceGate = undefined;
    res.once('close', () => {
      if (!res.writableEnded) gate?.closed();
    });
    if (body.stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"synthetic"}}]}\n\n');
    }
    gate?.begin();
    if (gate) await gate.wait;
    res.end(body.stream ? 'data: [DONE]\n\n' : JSON.stringify({ model: body.model, choices: [] }));
    gate?.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    holdNextModelList: () => (modelGate = hold()),
    holdNextInference: () => (inferenceGate = hold()),
    async stop() {
      for (const gate of gates) gate.release();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
};
