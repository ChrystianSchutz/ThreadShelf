import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../scripts/setup-llama-cpp.ts';

const root = await mkdtemp(join(tmpdir(), 'threadshelf-setup-check-'));
after(() => rm(root, { recursive: true, force: true }));

const executableName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
const asset = (name) => ({
  name,
  browser_download_url: `https://example.test/${name}`,
  digest: `sha256:${'a'.repeat(64)}`,
});
// Covers every platform/arch combination selectReleaseAsset can be asked for with --variant cpu.
const latestRelease = {
  tag_name: 'b200',
  html_url: 'https://github.com/ggml-org/llama.cpp/releases/tag/b200',
  assets: [
    asset('llama-b200-bin-win-cpu-x64.zip'),
    asset('llama-b200-bin-win-cpu-arm64.zip'),
    asset('llama-b200-bin-ubuntu-x64.tar.gz'),
    asset('llama-b200-bin-ubuntu-arm64.tar.gz'),
    asset('llama-b200-bin-macos-x64.tar.gz'),
    asset('llama-b200-bin-macos-arm64.tar.gz'),
  ],
};

const installManagedBuild = async (toolsRoot, directory) => {
  const buildDirectory = join(toolsRoot, 'llama.cpp', directory);
  await mkdir(buildDirectory, { recursive: true });
  await writeFile(join(buildDirectory, executableName), '');
};

let saved;
let output;
beforeEach(() => {
  saved = {
    fetch: globalThis.fetch,
    log: console.log,
    env: Object.fromEntries(
      ['PATH', 'LLAMA_CPP_SERVER', 'LLAMA_SERVER_PATH', 'LOCALAPPDATA', 'HOME', 'USERPROFILE'].map(
        (name) => [name, process.env[name]],
      ),
    ),
  };
  output = [];
  // Only the temp tools root may contribute llama-server candidates.
  process.env.PATH = '';
  delete process.env.LLAMA_CPP_SERVER;
  delete process.env.LLAMA_SERVER_PATH;
  process.env.LOCALAPPDATA = root;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  console.log = (...values) => output.push(values.join(' '));
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/releases/latest')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => latestRelease,
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
});
afterEach(() => {
  globalThis.fetch = saved.fetch;
  console.log = saved.log;
  for (const [name, value] of Object.entries(saved.env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const check = async (toolsRoot) => {
  await main(['--check', '--variant', 'cpu', '--destination', toolsRoot]);
  return output.join('\n');
};

describe('setup:llama --check', () => {
  it('offers the update command with the installed variant when a newer build exists', async () => {
    const toolsRoot = join(root, 'outdated');
    await installManagedBuild(toolsRoot, 'b100-cuda');
    const text = await check(toolsRoot);
    assert.match(text, /Latest compatible official release: b200/);
    assert.match(
      text,
      /Update available: b100-cuda → b200\. Install it with: npm run setup:llama -- -- --install --variant cuda/,
    );
    assert.doesNotMatch(text, /up to date/);
    assert.match(text, /No files were downloaded or installed\./);
  });

  it('reports an installed build equal to the latest as up to date', async () => {
    const toolsRoot = join(root, 'current');
    await installManagedBuild(toolsRoot, 'b100-cuda');
    await installManagedBuild(toolsRoot, 'b200-cuda');
    const text = await check(toolsRoot);
    assert.match(text, /Installed managed build b200-cuda is up to date\./);
    assert.doesNotMatch(text, /Update available/);
  });

  it('prints no update status without a managed build', async () => {
    const toolsRoot = join(root, 'empty');
    await mkdir(toolsRoot, { recursive: true });
    const text = await check(toolsRoot);
    assert.match(text, /Latest compatible official release: b200/);
    assert.doesNotMatch(text, /Update available|up to date/);
  });
});
