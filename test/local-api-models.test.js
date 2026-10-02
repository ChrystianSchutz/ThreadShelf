import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { syntheticMtpModel } from './shared/gguf.js';

const originalEnv = { ...process.env };
const originalSpawn = childProcess.spawn;
let root, runtime, api, registry, config, models;
const children = [];
let holdStops = false;
let onStop;

// A controllable process double makes the shutdown race deterministic on every
// platform, including Windows where SIGTERM otherwise kills the launcher at once.
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'threadshelf-local-models-'));
  process.env.GENERATION_CONFIG_PATH = join(root, 'generation.json');
  process.env.THREADSHELF_DISABLE_DEFAULT_MODEL_PATHS = '1';
  process.env.THREADSHELF_MODELS_PATH = join(root, 'models');
  process.env.THREADSHELF_IDLE_MINUTE_MS = '25';
  delete process.env.LLAMA_CPP_BASE_URL;
  delete process.env.LLAMA_CPP_IDLE_UNLOAD_MINUTES;
  const executable = join(root, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  await writeFile(executable, 'synthetic placeholder');
  process.env.LLAMA_CPP_SERVER = executable;
  await mkdir(join(root, 'models'));
  models = ['Alpha', 'Beta'].map((name) => ({
    id: join(root, 'models', `${name}.gguf`),
    path: join(root, 'models', `${name}.gguf`),
    name,
    provider: 'llama-cpp',
  }));
  for (const model of models) await writeFile(model.path, syntheticMtpModel(1));
  childProcess.spawn = (_executable, args) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      exitCode: null,
      signalCode: null,
    });
    if (args.includes('--help') || args.includes('--list-devices')) {
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.emit(
          'data',
          Buffer.from(
            args.includes('--help')
              ? '--fit --parallel --flash-attn [on|off|auto]'
              : 'Available devices:\n',
          ),
        );
        child.exitCode = 0;
        child.emit('exit', 0);
        child.emit('close', 0);
      });
      return child;
    }
    const server = createServer((_req, res) => res.end('{}'));
    server.listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1');
    const record = { child, stopped: false, stopping: false, finish: undefined };
    record.finish = () => {
      server.closeAllConnections();
      server.close(() => {
        record.stopped = true;
        child.signalCode = 'SIGTERM';
        child.emit('exit', null, 'SIGTERM');
      });
    };
    children.push(record);
    child.kill = () => {
      if (record.stopping) return true;
      record.stopping = true;
      onStop?.(record);
      if (!holdStops) record.finish();
      return true;
    };
    return child;
  };
  syncBuiltinESMExports();
  runtime = await import('../src/generation/llama-process.js');
  api = await import('../src/generation/local-api.js');
  registry = await import('../src/generation/registry.js');
  config = await import('../src/generation/config.js');
});

beforeEach(async () => {
  await config.updateGenerationConfig({ llamaCpp: { idleUnloadMinutes: 0 } });
});

after(async () => {
  holdStops = false;
  onStop = undefined;
  for (const record of children) {
    if (record.stopping && !record.stopped) record.finish();
  }
  await runtime?.stopManagedLlamaServer();
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
  process.env = originalEnv;
  await rm(root, { recursive: true, force: true });
});

describe('local API model ids', () => {
  it('retains both same-named models in same-named folders and resolves stable private ids', async () => {
    const twins = ['vendor-a', 'vendor-b'].map((vendor) => ({
      name: 'twin',
      path: join(root, vendor, 'shared', 'twin.gguf'),
      provider: 'llama-cpp',
    }));
    let catalogue = twins;
    const restore = registry.setGenerationProviderForTests('llama-cpp', {
      listModels: async () => catalogue,
    });
    try {
      const listed = await api.listLocalApiModels();
      assert.equal(listed.length, 2);
      assert.equal(new Set(listed.map((model) => model.id)).size, 2);
      for (const entry of listed) {
        assert.equal((await api.resolveLocalApiModel(entry.id)).target, entry.target);
        assert.equal(entry.id.includes(root), false);
        assert.equal(entry.id.includes('vendor-'), false);
      }
      catalogue = [...twins].reverse();
      assert.deepEqual((await api.listLocalApiModels()).reverse(), listed);
      // A real file name may equal the generated suffix. It must remain
      // addressable without stealing an id from either colliding model.
      const literalName = listed[0].id.split('/')[1];
      catalogue = [
        ...twins,
        ...['shared', 'other'].map((folder) => ({
          name: literalName,
          path: join(root, folder, `${literalName}.gguf`),
          provider: 'llama-cpp',
        })),
      ];
      const withLiteral = await api.listLocalApiModels();
      assert.equal(new Set(withLiteral.map((model) => model.id)).size, 4);
      for (const entry of withLiteral) {
        assert.equal((await api.resolveLocalApiModel(entry.id)).target, entry.target);
      }
    } finally {
      restore();
    }
  });

  it('preserves unique names, folder-qualified names and external server ids', async () => {
    const restore = registry.setGenerationProviderForTests('llama-cpp', {
      listModels: async () => [
        models[0],
        { name: 'twin', path: join(root, 'a', 'twin.gguf') },
        { name: 'twin', path: join(root, 'b', 'twin.gguf') },
        { id: 'external/vendor-model', name: 'external/vendor-model' },
      ],
    });
    try {
      assert.deepEqual(
        (await api.listLocalApiModels()).map((model) => model.id),
        ['Alpha', 'a/twin', 'b/twin', 'external/vendor-model'],
      );
    } finally {
      restore();
    }
  });
});

describe('local API runtime shutdown', () => {
  it(
    'rearms idle unload when a slow no-op unload outlasts the idle timeout',
    { timeout: 10_000 },
    async () => {
      await runtime.withLlamaServer(models[0].path, async () => {});
      await config.updateGenerationConfig({ llamaCpp: { idleUnloadMinutes: 1 } });
      let release;
      let waiting;
      const lookup = new Promise((resolve) => {
        waiting = resolve;
      });
      const restore = registry.setGenerationProviderForTests('llama-cpp', {
        async listModels() {
          waiting();
          await new Promise((resolve) => {
            release = resolve;
          });
          return models;
        },
      });
      const stopped = new Promise((resolve) => {
        onStop = resolve;
      });
      const unloading = api.unloadLocalApiModel('Beta');
      try {
        await lookup;
        await runtime.scheduleLlamaIdleUnload();
        await new Promise((resolve) => setTimeout(resolve, 75));
        assert.equal(runtime.getLoadedLlamaModel(), models[0].path);
      } finally {
        release?.();
        restore();
      }
      assert.deepEqual(await unloading, { unloaded: false, model: 'Alpha' });
      try {
        await stopped;
      } finally {
        onStop = undefined;
      }
      await setImmediate();
      assert.equal(runtime.getLoadedLlamaModel(), undefined);
    },
  );

  it('blocks new leases until an idle process actually exits', { timeout: 10_000 }, async () => {
    holdStops = true;
    const stopping = new Promise((resolve) => {
      onStop = resolve;
    });
    let record;
    try {
      await config.updateGenerationConfig({ llamaCpp: { idleUnloadMinutes: 1 } });
      await runtime.withLlamaServer(models[0].path, async () => {});
      record = await stopping;
      const count = children.length;
      for (const model of models) {
        await assert.rejects(
          () => runtime.withLlamaServer(model.path, async () => {}),
          runtime.LlamaModelBusyError,
        );
      }
      await assert.rejects(
        () => api.unloadLocalApiModel(),
        (error) => error.kind === 'model_busy',
      );
      assert.equal(children.length, count);
      assert.equal(children.filter((child) => !child.stopped).length, 1);
    } finally {
      holdStops = false;
      onStop = undefined;
      record?.finish();
      await setImmediate();
      await setImmediate();
    }
    await config.updateGenerationConfig({ llamaCpp: { idleUnloadMinutes: 0 } });
    await runtime.withLlamaServer(models[1].path, async () => {});
    assert.equal(runtime.getLoadedLlamaModel(), models[1].path);
    assert.equal(children.filter((child) => !child.stopped).length, 1);
    await runtime.stopManagedLlamaServer();
  });

  it(
    'holds runtime control during model lookup for a targeted unload',
    { timeout: 10_000 },
    async () => {
      await runtime.withLlamaServer(models[0].path, async () => {});
      let release;
      let waiting;
      const lookup = new Promise((resolve) => {
        waiting = resolve;
      });
      let reads = 0;
      const restore = registry.setGenerationProviderForTests('llama-cpp', {
        async listModels() {
          if (++reads === 2) {
            waiting();
            await new Promise((resolve) => {
              release = resolve;
            });
          }
          return models;
        },
      });
      const unloading = api.unloadLocalApiModel('Alpha');
      try {
        await lookup;
        await assert.rejects(
          () => runtime.withLlamaServer(models[1].path, async () => {}),
          runtime.LlamaModelBusyError,
        );
        await assert.rejects(
          () => api.unloadLocalApiModel('Beta'),
          (error) => error.kind === 'model_busy',
        );
        assert.equal(runtime.getLoadedLlamaModel(), models[0].path);
      } finally {
        release?.();
        restore();
      }
      assert.deepEqual(await unloading, { unloaded: true, model: 'Alpha' });
      assert.equal(runtime.getLoadedLlamaModel(), undefined);
      await runtime.withLlamaServer(models[1].path, async () => {});
      assert.deepEqual(await api.unloadLocalApiModel('Alpha'), { unloaded: false, model: 'Beta' });
      assert.equal(runtime.getLoadedLlamaModel(), models[1].path);
      await runtime.stopManagedLlamaServer();
    },
  );
});
