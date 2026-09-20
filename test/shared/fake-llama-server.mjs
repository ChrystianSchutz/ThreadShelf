// Stand-in for llama-server used by tests. It records every argv it receives,
// answers `--help` / `--list-devices` like a modern build, and serves the two
// endpoints ThreadShelf uses: `/health` and an OpenAI-compatible chat stream.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
if (process.env.FAKE_LLAMA_ARGV_LOG) {
  appendFileSync(process.env.FAKE_LLAMA_ARGV_LOG, `${JSON.stringify(args)}\n`);
}

if (args.includes('--help')) {
  process.stdout.write(
    [
      '-ctk,  --cache-type-k TYPE              KV cache data type for K',
      '-ctv,  --cache-type-v TYPE              KV cache data type for V',
      '-fa,   --flash-attn [on|off|auto]       set Flash Attention use',
      '-fit,  --fit [on|off]                   whether to adjust unset arguments',
      '--spec-type none,draft-simple,draft-mtp,ngram-simple',
      '-np,   --parallel N                     number of server slots',
      "-rea,  --reasoning [on|off|auto]        Use reasoning/thinking in the chat ('on', 'off')",
      '--reasoning-effort LEVEL                reasoning effort level given to the chat template',
      '',
    ].join('\n'),
  );
  process.exit(0);
}
if (args.includes('--list-devices')) {
  process.stdout.write('Available devices:\n  CUDA0: Fake Test GPU (24564 MiB, 22000 MiB free)\n');
  process.exit(0);
}

const port = Number(args[args.indexOf('--port') + 1]);
const server = createServer(async (req, res) => {
  for await (const _chunk of req) {
    // Drain the request body.
  }
  if (req.url === '/health') {
    res.setHeader('content-type', 'application/json');
    res.end('{"status":"ok"}');
    return;
  }
  if (req.url === '/v1/chat/completions') {
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"Fake llama answer"}}]}\n\n');
    res.write(
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
    );
    res.end('data: [DONE]\n\n');
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});
server.listen(port, '127.0.0.1', () => {
  process.stderr.write('load_tensors: offloaded 65/65 layers to GPU\n');
});

// On Windows the compiled launcher is the process ThreadShelf terminates, so
// exit as soon as the parent disappears instead of holding the port open.
const parent = process.ppid;
setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    process.exit(0);
  }
}, 200).unref();
process.on('SIGTERM', () => process.exit(0));
