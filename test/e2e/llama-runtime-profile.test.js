import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer } from './helpers.js';
import { createFakeLlamaServer, fakeLlamaUnavailable } from '../shared/fake-llama.js';
import { syntheticMtpModel } from '../shared/gguf.js';

const json = (method, body) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const readLaunches = async (argvLog) =>
  (await readFile(argvLog, 'utf8').catch(() => ''))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((args) => args.includes('--model'));

const containsSequence = (args, sequence) =>
  args.some((_, index) => sequence.every((value, offset) => args[index + offset] === value));

describe('managed llama.cpp runtime profile E2E', () => {
  it(
    'starts llama-server with the tuning profile, reports it, and restarts after a settings change',
    { timeout: 180_000, skip: fakeLlamaUnavailable() },
    async () => {
      // The executable lives outside the server's temp root so it is built once, before boot.
      const toolsRoot = await mkdtemp(join(tmpdir(), 'threadshelf-fake-llama-'));
      const executable = await createFakeLlamaServer(join(toolsRoot, 'bin'));
      const argvLog = join(toolsRoot, 'argv.jsonl');
      const modelsDir = join(toolsRoot, 'models');
      await mkdir(modelsDir);
      const model = join(modelsDir, 'synthetic-qwen-mtp.gguf');
      await writeFile(model, syntheticMtpModel(1));

      const ctx = await startApiServer({
        prefix: 'threadshelf-llama-profile-',
        env: { LLAMA_CPP_SERVER: executable, FAKE_LLAMA_ARGV_LOG: argvLog },
      });
      const chat = async () => {
        const response = await fetch(
          `${ctx.baseUrl}/api/generation/chat/stream`,
          json('POST', {
            provider: 'llama-cpp',
            model,
            prompt: 'Say hi',
            ephemeral: true,
          }),
        );
        assert.strictEqual(response.ok, true);
        const events = (await response.text())
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert.strictEqual(events.at(-1).type, 'done', JSON.stringify(events.at(-1)));
        assert.strictEqual(events.at(-1).response.content, 'Fake llama answer');
      };
      const runtimeState = async () =>
        (await (await fetch(`${ctx.baseUrl}/api/generation/runtime`)).json()).runtime.state;
      const diagnostics = async () =>
        (await fetch(`${ctx.baseUrl}/api/generation/runtime/logs`)).json();

      try {
        let response = await fetch(
          `${ctx.baseUrl}/api/generation/config`,
          json('PUT', { llamaCpp: { modelDirectories: [modelsDir], contextSize: 65_536 } }),
        );
        assert.strictEqual(response.ok, true, await response.clone().text());

        // T1: the first request launches llama-server with the default Quality/Auto/Medium profile.
        await chat();
        let launches = await readLaunches(argvLog);
        assert.strictEqual(launches.length, 1);
        const [firstArgs] = launches;
        assert.ok(containsSequence(firstArgs, ['--flash-attn', 'on']), firstArgs.join(' '));
        assert.ok(
          containsSequence(firstArgs, [
            '--cache-type-k',
            'q8_0',
            '--cache-type-v',
            'q8_0',
            '--spec-type',
            'draft-mtp',
            '--spec-draft-n-max',
            '2',
            '--reasoning-effort',
            'medium',
            '--parallel',
            '1',
          ]),
          firstArgs.join(' '),
        );

        // T2: diagnostics expose the structured profile next to the log line.
        let report = await diagnostics();
        assert.strictEqual(report.source, 'managed');
        assert.match(report.logs, /\[ThreadShelf\] Runtime profile for qwen35: ctx 64K/);
        assert.ok(report.profile.length >= 5);
        for (const entry of report.profile) {
          assert.strictEqual(typeof entry.setting, 'string');
          assert.strictEqual(typeof entry.applied, 'boolean');
          assert.ok(['settings', 'model', 'runtime', 'threadshelf'].includes(entry.source));
        }
        const firstMtp = report.profile.find((entry) => entry.setting === 'MTP');
        assert.deepStrictEqual(
          { value: firstMtp.value, applied: firstMtp.applied },
          { value: '2', applied: true },
        );
        assert.match(firstMtp.note, /1 NextN layer/);
        assert.strictEqual(
          report.profile.find((entry) => entry.setting === 'KV').value,
          'q8_0×q8_0',
        );
        assert.strictEqual(report.offload.mode, 'gpu');

        // T3: saving identical llama.cpp settings keeps the model loaded...
        response = await fetch(
          `${ctx.baseUrl}/api/generation/config`,
          json('PUT', { llamaCpp: { kvCache: 'quality' } }),
        );
        assert.strictEqual(response.ok, true);
        assert.strictEqual(await runtimeState(), 'ready');
        // ...while changing only the KV cache stops it so the next start uses the new flags.
        response = await fetch(
          `${ctx.baseUrl}/api/generation/config`,
          json('PUT', { llamaCpp: { kvCache: 'memory' } }),
        );
        assert.strictEqual(response.ok, true);
        assert.strictEqual((await response.json()).config.llamaCpp.kvCache, 'memory');
        assert.strictEqual(await runtimeState(), 'stopped');

        // T2 (restart): the next request relaunches with a fresh profile.
        await chat();
        launches = await readLaunches(argvLog);
        assert.strictEqual(launches.length, 2);
        assert.ok(
          containsSequence(launches[1], ['--cache-type-k', 'q4_0', '--cache-type-v', 'q4_0']),
          launches[1].join(' '),
        );
        report = await diagnostics();
        assert.strictEqual(
          report.profile.find((entry) => entry.setting === 'KV').value,
          'q4_0×q4_0',
        );
        assert.match(report.logs, /KV q4_0×q4_0 \(settings\)/);
        assert.doesNotMatch(report.logs, /q8_0×q8_0/, 'logs belong to the new process only');
      } finally {
        await fetch(`${ctx.baseUrl}/api/generation/runtime/eject`, json('POST', {})).catch(
          () => undefined,
        );
        await ctx.stop();
        await rm(toolsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    },
  );
});
