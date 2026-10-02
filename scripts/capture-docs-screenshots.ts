import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Page } from '@playwright/test';

const repoRoot = resolve('.');
const docsAssetsDir = join(repoRoot, 'docs', 'assets');
const mockDataRoot = join(repoRoot, 'docs', 'mock-data');
const SEARCH_QUERY = 'conversation about reducing hallucinations without using a larger model';

type Theme = 'light' | 'dark';

async function stopChildProcess(child: ChildProcess): Promise<void> {
  const closed = new Promise<void>((resolveClose) => child.once('close', () => resolveClose()));
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await closed;
}

async function waitForHealth(baseUrl: string, timeoutMs = 120_000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }

  throw new Error(`Server did not become healthy: ${String(lastError)}`);
}

async function ingestFolder(
  baseUrl: string,
  folderPath: string,
  collection: string,
): Promise<void> {
  const res = await fetch(new URL('/api/ingest-progress', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ folderPath, collection, clearFirst: true }),
  });
  if (!res.ok) {
    throw new Error(`Ingest failed for ${collection}: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  const events = text
    .split('\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => JSON.parse(block) as { status?: string });
  const completed = events.find((event) => event.status === 'completed');
  if (!completed) {
    throw new Error(`No completed ingest event for ${collection}: ${text}`);
  }
}

async function prepareUiWithTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((themeName: Theme) => {
    localStorage.setItem(
      'threadshelf:ui',
      JSON.stringify({
        state: {
          theme: themeName,
          activeColl: 'all',
          roles: { user: true, thinking: true, ai: true },
        },
        version: 0,
      }),
    );
  }, theme);
}

async function screenshotViewport(page: Page, outputPath: string): Promise<void> {
  await page.screenshot({
    path: outputPath,
    type: 'png',
    clip: { x: 0, y: 0, width: 1600, height: 950 },
  });
}

async function getDemoConversation(baseUrl: string): Promise<{
  sourceFile: string;
  collection: string;
  conversationKey?: string;
  title?: string;
}> {
  const filesRes = await fetch(`${baseUrl}/api/files?collection=lmstudio`);
  if (!filesRes.ok) {
    throw new Error(`Failed to list demo conversations: ${filesRes.status}`);
  }
  const filesData = (await filesRes.json()) as {
    files: Array<{
      sourceFile: string;
      collection: string;
      conversationKey?: string;
      title?: string;
    }>;
  };
  const conversation = filesData.files[0];
  if (!conversation) {
    throw new Error('No LM Studio demo conversation found for screenshot.');
  }
  return conversation;
}

async function captureSearch(page: Page, baseUrl: string, outputName: string): Promise<void> {
  const query = encodeURIComponent(SEARCH_QUERY);
  await page.goto(`${baseUrl}/search/all?q=${query}`, { waitUntil: 'networkidle' });
  await page.locator('.result').first().waitFor({ state: 'visible', timeout: 120_000 });
  await screenshotViewport(page, join(docsAssetsDir, outputName));
}

async function captureConversation(page: Page, baseUrl: string, outputName: string): Promise<void> {
  const conversation = await getDemoConversation(baseUrl);
  const threadUrl = new URL('/thread', baseUrl);
  threadUrl.searchParams.set('sourceFile', conversation.sourceFile);
  threadUrl.searchParams.set('collection', conversation.collection);
  if (conversation.conversationKey) {
    threadUrl.searchParams.set('conversationKey', conversation.conversationKey);
  }
  if (conversation.title) {
    threadUrl.searchParams.set('title', conversation.title);
  }

  await page.goto(threadUrl.toString(), { waitUntil: 'networkidle' });
  await page.locator('#threadContent').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('.role-toggle[data-role="thinking"]').click();
  await page
    .locator('.turn[data-role="thinking"]')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 });
  await screenshotViewport(page, join(docsAssetsDir, outputName));
}

async function captureMcp(page: Page, baseUrl: string, outputName: string): Promise<void> {
  await page.goto(`${baseUrl}/mcp`, { waitUntil: 'networkidle' });
  await page.locator('.panel').first().waitFor({ state: 'visible', timeout: 15_000 });
  await screenshotViewport(page, join(docsAssetsDir, outputName));
}

async function captureGeneration(page: Page, baseUrl: string, outputName: string): Promise<void> {
  await page.route('**/api/generation/config', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        config: {
          llamaCpp: {
            modelDirectories: [],
            defaultModelDirectories: [],
            contextSize: 8192,
            acceleration: 'auto',
            gpuLayers: 20,
            splitMode: 'layer',
            mainGpu: 0,
            threads: -1,
            flashAttention: 'auto',
          },
          openRouter: {
            baseUrl: 'https://openrouter.ai/api/v1',
            apiKeyConfigured: true,
            enforceZdr: false,
            denyDataCollection: false,
          },
        },
        providers: [
          {
            id: 'llama-cpp',
            label: 'llama.cpp',
            available: true,
            local: true,
            detail: 'Local llama-server is ready.',
          },
          {
            id: 'openrouter',
            label: 'OpenRouter',
            available: true,
            local: false,
            detail: 'A session key is configured.',
          },
        ],
      }),
    });
  });
  await page.route('**/api/generation/models?provider=llama-cpp*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        provider: 'llama-cpp',
        models: [
          {
            id: 'C:\\Models\\Bielik-11B.Q4_K_M.gguf',
            name: 'Bielik-11B · Q4_K_M',
            path: 'C:\\Models\\Bielik-11B.Q4_K_M.gguf',
            provider: 'llama-cpp',
            loaded: true,
            sizeBytes: 7_100_000_000,
          },
        ],
        runtime: {
          state: 'ready',
          model: 'Bielik-11B.Q4_K_M',
          contextSize: 8192,
          detail: 'Local GGUF loaded on CUDA with automatic layer placement.',
        },
      }),
    });
  });
  await page.route('**/api/generation/models?provider=openrouter*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        provider: 'openrouter',
        models: [
          {
            id: 'openrouter/free',
            name: 'OpenRouter Free',
            provider: 'openrouter',
            contextLength: 131072,
          },
          {
            id: 'anthropic/claude-sonnet',
            name: 'Claude Sonnet',
            provider: 'openrouter',
            contextLength: 200000,
          },
        ],
        runtime: {
          state: 'remote',
          detail: 'Models run remotely through OpenRouter and are not loaded by ThreadShelf.',
        },
      }),
    });
  });

  await page.goto(`${baseUrl}/chat?private=docs-preview`, { waitUntil: 'networkidle' });
  await page.locator('#continuePrompt').waitFor({ state: 'visible', timeout: 15_000 });
  await page
    .locator('#continuePrompt')
    .fill('Summarize the strongest ideas from my local conversation archive.');
  await page.locator('#modelMenuButton').click();
  await page.getByRole('tab', { name: /OpenRouter/ }).click();
  await page.getByText('2 live models available').waitFor({ state: 'visible', timeout: 15_000 });
  await screenshotViewport(page, join(docsAssetsDir, outputName));
}

async function captureDemoGif(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  baseUrl: string,
  tempRoot: string,
): Promise<void> {
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { shell: true, stdio: 'ignore' });
  if (ffmpeg.status !== 0) {
    console.warn('Skipping demo GIF: ffmpeg was not found.');
    return;
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    recordVideo: { dir: tempRoot, size: { width: 1280, height: 720 } },
  });

  let videoPath: string | undefined;
  try {
    const page = await context.newPage();
    await prepareUiWithTheme(page, 'light');

    await page.goto(`${baseUrl}/indexing`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3500);

    const query = encodeURIComponent(SEARCH_QUERY);
    await page.goto(`${baseUrl}/search/all?q=${query}`, { waitUntil: 'networkidle' });
    await page.locator('.result').first().waitFor({ state: 'visible', timeout: 120_000 });
    await page.waitForTimeout(3500);

    await page.locator('.result').first().click();
    await page.locator('#threadContent').waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(7000);

    videoPath = await page.video()?.path();
  } finally {
    await context.close();
  }

  if (!videoPath) {
    throw new Error('Playwright did not produce a video for the demo GIF.');
  }

  const palettePath = join(tempRoot, 'threadshelf-demo-palette.png');
  const gifPath = join(docsAssetsDir, 'threadshelf-demo.gif');
  const palette = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-i',
      videoPath,
      '-vf',
      'fps=8,scale=960:-1:flags=lanczos,palettegen',
      '-frames:v',
      '1',
      '-update',
      'true',
      palettePath,
    ],
    { shell: true, stdio: 'inherit' },
  );
  if (palette.status !== 0) {
    throw new Error(
      `ffmpeg palette generation failed with exit code ${palette.status ?? 'unknown'}`,
    );
  }

  const gif = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-i',
      videoPath,
      '-i',
      palettePath,
      '-filter_complex',
      'fps=8,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse',
      gifPath,
    ],
    { shell: true, stdio: 'inherit' },
  );
  if (gif.status !== 0) {
    throw new Error(`ffmpeg GIF generation failed with exit code ${gif.status ?? 'unknown'}`);
  }
}

async function captureThemeSet(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  baseUrl: string,
  theme: Theme,
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 950 },
    deviceScaleFactor: 1,
  });

  try {
    const page = await context.newPage();
    await prepareUiWithTheme(page, theme);

    const suffix = theme === 'dark' ? '-dark' : '';
    await captureSearch(page, baseUrl, `search-results${suffix}.png`);
    await captureConversation(page, baseUrl, `conversation-view${suffix}.png`);

    if (theme === 'light') {
      await captureMcp(page, baseUrl, 'mcp-server.png');
      await captureGeneration(page, baseUrl, 'conversation-generation.png');
    }
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  const build = spawnSync('npm', ['run', 'build:client'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
  });
  if (build.status !== 0) {
    throw new Error(`Client build failed with exit code ${build.status ?? 'unknown'}`);
  }

  await mkdir(docsAssetsDir, { recursive: true });
  const tempRoot = await mkdtemp(join(tmpdir(), 'threadshelf-docs-'));
  const port = String(3900 + Math.floor(Math.random() * 200));
  const baseUrl = `http://127.0.0.1:${port}`;
  const collectionsFile = join(repoRoot, '.collections.json');
  let collectionsBackup: string | null = null;

  try {
    collectionsBackup = await readFile(collectionsFile, 'utf-8');
  } catch {
    collectionsBackup = null;
  }

  await writeFile(collectionsFile, JSON.stringify({ collections: [] }, null, 2));

  const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: port,
      HOST: '127.0.0.1',
      LANCEDB_PATH: join(tempRoot, '.lancedb'),
      UPLOADS_DIR: join(tempRoot, '.uploads'),
      COLLECTIONS_PATH: join(tempRoot, '.collections.json'),
      MASTER_PROMPTS_PATH: join(tempRoot, 'master-prompts.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs: string[] = [];
  server.stdout.on('data', (chunk) => logs.push(String(chunk)));
  server.stderr.on('data', (chunk) => logs.push(String(chunk)));

  try {
    await waitForHealth(baseUrl);

    for (const collection of ['gemini', 'claude', 'chatgpt', 'openrouter', 'lmstudio', 'grok']) {
      await ingestFolder(baseUrl, join(mockDataRoot, collection), collection);
    }

    const browser = await chromium.launch({ headless: true });
    try {
      await captureThemeSet(browser, baseUrl, 'light');
      await captureThemeSet(browser, baseUrl, 'dark');
      await captureDemoGif(browser, baseUrl, tempRoot);
    } finally {
      await browser.close();
    }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.join('')}`);
  } finally {
    await stopChildProcess(server);
    await rm(tempRoot, { recursive: true, force: true });
    if (collectionsBackup == null) {
      await rm(collectionsFile, { force: true });
    } else {
      await writeFile(collectionsFile, collectionsBackup);
    }
  }
}

void main();
