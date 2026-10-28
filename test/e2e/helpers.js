import { spawn } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createMixedFixtureFolder,
  ingestViaNdjson,
  repoRoot,
  stopChildProcess,
  waitForHealth,
} from '../shared/helpers.js';

export { createMixedFixtureFolder, ingestViaNdjson, repoRoot, stopChildProcess, waitForHealth };

export const startApiServer = async ({
  prefix = 'threadshelf-e2e-',
  portBase = 3500,
  env = {},
} = {}) => {
  const tempRoot = await mkdtemp(join(tmpdir(), prefix));
  const port = String(portBase + Math.floor(Math.random() * 1000));
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: port,
      HOST: '127.0.0.1',
      LANCEDB_PATH: join(tempRoot, '.lancedb'),
      UPLOADS_DIR: join(tempRoot, '.uploads'),
      COLLECTIONS_PATH: join(tempRoot, '.collections.json'),
      GENERATION_CONFIG_PATH: join(tempRoot, 'generation.json'),
      MASTER_PROMPTS_PATH: join(tempRoot, 'master-prompts.json'),
      OBSIDIAN_CONFIG_PATH: join(tempRoot, 'obsidian.json'),
      THREADSHELF_DISABLE_DEFAULT_MODEL_PATHS: '1',
      THREADSHELF_TOOLS_PATH: join(tempRoot, 'tools'),
      // The download directory is always scanned, so a developer's models would leak in.
      THREADSHELF_MODELS_PATH: join(tempRoot, 'models'),
      // Never let a developer's private .env key affect isolated tests.
      OPENROUTER_API_KEY: '',
      // A developer's local API key would lock /v1 in every test.
      THREADSHELF_API_KEY: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout.on('data', (chunk) => output.push(String(chunk)));
  server.stderr.on('data', (chunk) => output.push(String(chunk)));

  try {
    await waitForHealth(baseUrl);
  } catch (error) {
    await stopChildProcess(server);
    await rm(tempRoot, { recursive: true, force: true });
    const detail = output.join('');
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${detail ? `\nServer output:\n${detail}` : ''}`,
    );
  }

  const stop = async () => {
    await stopChildProcess(server);
    await rm(tempRoot, { recursive: true, force: true });
  };

  return { baseUrl, output, server, stop, tempRoot };
};
