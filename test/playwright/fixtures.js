/**
 * Playwright fixtures that boot the ThreadShelf server in isolation per
 * test worker. Each worker gets its own port, its own LanceDB directory, and
 * its own uploads folder so tests don't smash into each other.
 */
import { test as base, expect } from '@playwright/test';
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

export const test = base.extend({
  serverContext: [
    async ({}, use, workerInfo) => {
      const tempRoot = await mkdtemp(join(tmpdir(), 'threadshelf-pw-'));
      const port = String(4800 + workerInfo.workerIndex * 17 + Math.floor(Math.random() * 100));
      const baseUrl = `http://127.0.0.1:${port}`;
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
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
          THREADSHELF_DISABLE_DEFAULT_MODEL_PATHS: '1',
          THREADSHELF_TOOLS_PATH: join(tempRoot, 'tools'),
          // Model downloads must never reach the developer's real model folder.
          THREADSHELF_MODELS_PATH: join(tempRoot, 'models'),
          // Never let a developer's private .env key affect isolated tests.
          OPENROUTER_API_KEY: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const logBuffer = [];
      child.stdout.on('data', (chunk) => logBuffer.push(String(chunk)));
      child.stderr.on('data', (chunk) => logBuffer.push(String(chunk)));

      try {
        await waitForHealth(baseUrl);
        const exportsDir = await createMixedFixtureFolder(tempRoot);
        const ingest = await ingestViaNdjson(baseUrl, exportsDir, 'pw_fixture');
        await use({ baseUrl, exportsDir, ingest, tempRoot, logBuffer });
      } finally {
        await stopChildProcess(child);
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
    { scope: 'worker' },
  ],

  appPage: async ({ page, serverContext }, use) => {
    await page.goto(`${serverContext.baseUrl}/`);
    await page.waitForSelector('#searchInput');
    await expect(page.locator('#collection-pw_fixture')).toBeVisible({ timeout: 15_000 });
    await use(page);
  },
});

export { expect };
