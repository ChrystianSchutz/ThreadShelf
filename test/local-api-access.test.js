import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getGenerationConfig,
  getLocalApiAccess,
  llamaCppConfigChanged,
  updateGenerationConfig,
} from '../src/generation/config.js';
import { localOriginRejection, networkOriginRejection } from '../src/routes/local-origin.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

const withConfigFile = async (run) => {
  const root = await mkdtemp(join(tmpdir(), 'threadshelf-local-api-config-'));
  process.env.GENERATION_CONFIG_PATH = join(root, 'generation.json');
  delete process.env.THREADSHELF_API_KEY;
  delete process.env.LLAMA_CPP_IDLE_UNLOAD_MINUTES;
  try {
    await run(process.env.GENERATION_CONFIG_PATH);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const fakeRequest = (headers) => ({ headers });

describe('local API settings', () => {
  it('defaults to an open, localhost-only API with no key and no idle unload', async () => {
    await withConfigFile(async () => {
      const config = await getGenerationConfig();
      assert.deepStrictEqual(config.localApi, {
        enabled: true,
        apiKeyConfigured: false,
        apiKeySource: 'none',
        networkAccess: false,
        networkPort: 3001,
      });
      assert.strictEqual(config.llamaCpp.idleUnloadMinutes, 0);
      assert.deepStrictEqual(await getLocalApiAccess(), { enabled: true, apiKey: '' });
    });
  });

  it('keeps a config file written before these settings existed working unchanged', async () => {
    await withConfigFile(async (path) => {
      await writeFile(
        path,
        JSON.stringify({ schemaVersion: 2, llamaCpp: { contextSize: 4096 } }),
        'utf8',
      );
      const config = await getGenerationConfig();
      assert.strictEqual(config.llamaCpp.contextSize, 4096);
      assert.strictEqual(config.localApi.enabled, true);
      assert.strictEqual(config.localApi.apiKeyConfigured, false);
      assert.strictEqual(config.llamaCpp.idleUnloadMinutes, 0);
    });
  });

  it('saves the key to the config file but never returns it', async () => {
    await withConfigFile(async (path) => {
      const config = await updateGenerationConfig({ localApi: { apiKey: '  ts-secret-1  ' } });
      assert.strictEqual(config.localApi.apiKeyConfigured, true);
      assert.strictEqual(config.localApi.apiKeySource, 'settings');
      assert.ok(!JSON.stringify(config).includes('ts-secret-1'), 'key must not be returned');
      const stored = JSON.parse(await readFile(path, 'utf8'));
      assert.strictEqual(stored.localApi.apiKey, 'ts-secret-1');
      assert.strictEqual((await getLocalApiAccess()).apiKey, 'ts-secret-1');
    });
  });

  it('keeps the saved key when an update omits it or sends an empty one', async () => {
    await withConfigFile(async () => {
      await updateGenerationConfig({ localApi: { apiKey: 'keep-me' } });
      await updateGenerationConfig({ localApi: { networkAccess: true } });
      await updateGenerationConfig({ localApi: { apiKey: '' } });
      await updateGenerationConfig({ llamaCpp: { contextSize: 4096 } });
      assert.strictEqual((await getLocalApiAccess()).apiKey, 'keep-me');
    });
  });

  it('replaces and clears the key', async () => {
    await withConfigFile(async () => {
      await updateGenerationConfig({ localApi: { apiKey: 'first' } });
      await updateGenerationConfig({ localApi: { apiKey: 'second' } });
      assert.strictEqual((await getLocalApiAccess()).apiKey, 'second');
      const config = await updateGenerationConfig({ localApi: { clearApiKey: true } });
      assert.strictEqual(config.localApi.apiKeyConfigured, false);
      assert.strictEqual(config.localApi.apiKeySource, 'none');
      assert.strictEqual((await getLocalApiAccess()).apiKey, '');
    });
  });

  it('lets THREADSHELF_API_KEY override the saved key', async () => {
    await withConfigFile(async () => {
      await updateGenerationConfig({ localApi: { apiKey: 'saved' } });
      process.env.THREADSHELF_API_KEY = ' from-env ';
      const config = await getGenerationConfig();
      assert.strictEqual(config.localApi.apiKeySource, 'env');
      assert.strictEqual(config.localApi.apiKeyConfigured, true);
      assert.strictEqual((await getLocalApiAccess()).apiKey, 'from-env');
    });
  });

  it('rejects keys that cannot travel in an HTTP header', async () => {
    await withConfigFile(async () => {
      for (const apiKey of ['has space', 'tab\tkey', 'zażółć', 'x'.repeat(513), 42, null]) {
        await assert.rejects(
          () => updateGenerationConfig({ localApi: { apiKey } }),
          /Invalid local API key/,
          String(apiKey),
        );
      }
      assert.strictEqual((await getLocalApiAccess()).apiKey, '');
    });
  });

  it('validates the switches and the network port', async () => {
    await withConfigFile(async () => {
      await assert.rejects(() => updateGenerationConfig({ localApi: 'off' }), /Invalid localApi/);
      await assert.rejects(
        () => updateGenerationConfig({ localApi: { enabled: 'no' } }),
        /Invalid enabled/,
      );
      await assert.rejects(
        () => updateGenerationConfig({ localApi: { networkAccess: 1 } }),
        /Invalid networkAccess/,
      );
      for (const networkPort of [0, 65_536, 80.5, '3001']) {
        await assert.rejects(
          () => updateGenerationConfig({ localApi: { networkPort } }),
          /Invalid networkPort/,
          String(networkPort),
        );
      }
      const config = await updateGenerationConfig({
        localApi: { enabled: false, networkAccess: true, networkPort: 8123 },
      });
      assert.strictEqual(config.localApi.enabled, false);
      assert.strictEqual(config.localApi.networkAccess, true);
      assert.strictEqual(config.localApi.networkPort, 8123);
      assert.strictEqual((await getLocalApiAccess()).enabled, false);
    });
  });

  it('a rejected update changes nothing, including the key', async () => {
    await withConfigFile(async () => {
      await updateGenerationConfig({ localApi: { apiKey: 'original' } });
      await assert.rejects(() =>
        updateGenerationConfig({ localApi: { apiKey: 'new-key', networkPort: -1 } }),
      );
      assert.strictEqual((await getLocalApiAccess()).apiKey, 'original');
    });
  });
});

describe('idle unload setting', () => {
  it('stores minutes, validates the range and honors the env override', async () => {
    await withConfigFile(async () => {
      let config = await updateGenerationConfig({ llamaCpp: { idleUnloadMinutes: 15 } });
      assert.strictEqual(config.llamaCpp.idleUnloadMinutes, 15);
      for (const idleUnloadMinutes of [-1, 1.5, 7 * 24 * 60 + 1, '5']) {
        await assert.rejects(
          () => updateGenerationConfig({ llamaCpp: { idleUnloadMinutes } }),
          /Invalid idleUnloadMinutes/,
          String(idleUnloadMinutes),
        );
      }
      config = await updateGenerationConfig({ llamaCpp: { contextSize: 4096 } });
      assert.strictEqual(config.llamaCpp.idleUnloadMinutes, 15, 'kept across other updates');
      process.env.LLAMA_CPP_IDLE_UNLOAD_MINUTES = '3';
      assert.strictEqual((await getGenerationConfig()).llamaCpp.idleUnloadMinutes, 3);
    });
  });

  it('does not count as a change that restarts llama-server', async () => {
    await withConfigFile(async () => {
      const before = await getGenerationConfig();
      const after = await updateGenerationConfig({ llamaCpp: { idleUnloadMinutes: 30 } });
      assert.strictEqual(llamaCppConfigChanged(before, after), false);
      const resized = await updateGenerationConfig({
        llamaCpp: { idleUnloadMinutes: 5, contextSize: 4096 },
      });
      assert.strictEqual(llamaCppConfigChanged(after, resized), true);
    });
  });

  it('does not count local API settings as a llama-server change either', async () => {
    await withConfigFile(async () => {
      const before = await getGenerationConfig();
      const after = await updateGenerationConfig({
        localApi: { apiKey: 'k', networkAccess: true, enabled: false },
      });
      assert.strictEqual(llamaCppConfigChanged(before, after), false);
    });
  });
});

describe('host checks', () => {
  it('keeps the loopback port to localhost names', () => {
    delete process.env.ALLOWED_HOSTS;
    process.env.HOST = '127.0.0.1';
    assert.strictEqual(localOriginRejection(fakeRequest({ host: 'localhost:3000' })), undefined);
    assert.strictEqual(localOriginRejection(fakeRequest({ host: '[::1]:3000' })), undefined);
    assert.strictEqual(
      localOriginRejection(fakeRequest({ host: '192.168.1.20:3000' })),
      'Forbidden host',
    );
    assert.strictEqual(
      localOriginRejection(fakeRequest({ host: 'localhost:3000', origin: 'https://evil.test' })),
      'Forbidden origin',
    );
  });

  it('lets the network port be reached by IP address or by this computer name', () => {
    delete process.env.ALLOWED_HOSTS;
    const machine = hostname().toLowerCase();
    for (const host of [
      '192.168.1.20:3001',
      '10.0.0.5',
      '[fe80::1]:3001',
      'localhost:3001',
      `${machine}:3001`,
      `${machine}.local:3001`,
      `${machine.toUpperCase()}.LAN`,
    ]) {
      assert.strictEqual(networkOriginRejection(fakeRequest({ host })), undefined, host);
    }
  });

  it('refuses other names on the network port, which only DNS rebinding produces', () => {
    delete process.env.ALLOWED_HOSTS;
    assert.strictEqual(
      networkOriginRejection(fakeRequest({ host: 'attacker.example:3001' })),
      'Forbidden host',
    );
    assert.strictEqual(networkOriginRejection(fakeRequest({})), 'Forbidden host');
  });

  it('refuses cross-site browser origins on the network port', () => {
    assert.strictEqual(
      networkOriginRejection(
        fakeRequest({ host: '192.168.1.20:3001', origin: 'https://attacker.example' }),
      ),
      'Forbidden origin',
    );
    assert.strictEqual(
      networkOriginRejection(fakeRequest({ host: '192.168.1.20:3001', origin: 'not a url' })),
      'Invalid origin',
    );
    assert.strictEqual(
      networkOriginRejection(
        fakeRequest({ host: '192.168.1.20:3001', origin: 'http://192.168.1.30:8080' }),
      ),
      undefined,
    );
  });

  it('accepts ALLOWED_HOSTS names on the network port', () => {
    process.env.ALLOWED_HOSTS = 'models.home.arpa, gpu-box';
    assert.strictEqual(
      networkOriginRejection(fakeRequest({ host: 'models.home.arpa:3001' })),
      undefined,
    );
    assert.strictEqual(networkOriginRejection(fakeRequest({ host: 'GPU-BOX' })), undefined);
  });
});
