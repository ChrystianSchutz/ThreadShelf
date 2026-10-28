import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectNoteFolders, obsidianRegistryPath } from '../src/obsidian/detect.js';

const withHome = async (fn) => {
  const home = await mkdtemp(join(tmpdir(), 'threadshelf-detect-'));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
};

describe('detectNoteFolders', () => {
  it('lists existing Obsidian vaults and the OpenClaw workspace', async () => {
    await withHome(async (home) => {
      const env = { APPDATA: join(home, 'Roaming') };
      const vault = join(home, 'Synthetic Vault');
      await mkdir(vault);
      await mkdir(join(home, '.openclaw', 'workspace'), { recursive: true });
      const registry = obsidianRegistryPath({ env, platform: 'win32', home });
      await mkdir(join(home, 'Roaming', 'obsidian'), { recursive: true });
      await writeFile(
        registry,
        JSON.stringify({
          vaults: {
            a: { path: vault, ts: 1 },
            b: { path: join(home, 'missing'), ts: 2 },
            c: { path: vault, ts: 3 },
          },
        }),
      );
      const folders = await detectNoteFolders({ env, platform: 'win32', home });
      assert.deepEqual(folders, [
        { source: 'Obsidian', name: 'Synthetic Vault', path: vault },
        {
          source: 'OpenClaw',
          name: 'OpenClaw workspace',
          path: join(home, '.openclaw', 'workspace'),
        },
      ]);
    });
  });

  it('returns nothing for a missing or corrupt registry', async () => {
    await withHome(async (home) => {
      const env = { XDG_CONFIG_HOME: join(home, 'config') };
      assert.deepEqual(await detectNoteFolders({ env, platform: 'linux', home }), []);
      await mkdir(join(home, 'config', 'obsidian'), { recursive: true });
      await writeFile(join(home, 'config', 'obsidian', 'obsidian.json'), '{not json');
      assert.deepEqual(await detectNoteFolders({ env, platform: 'linux', home }), []);
    });
  });
});
