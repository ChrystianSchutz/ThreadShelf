import { test, expect } from './fixtures.js';

const llamaCppConfig = (overrides = {}) => ({
  modelDirectories: [],
  defaultModelDirectories: [],
  downloadDirectory: '',
  contextSize: 32_768,
  acceleration: 'auto',
  gpuLayers: 20,
  splitMode: 'layer',
  mainGpu: 0,
  threads: -1,
  flashAttention: 'auto',
  ...overrides,
});

const configResponse = (llamaCpp) => ({
  config: {
    experimentalAlpha: true,
    llamaCpp,
    openRouter: {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyConfigured: false,
      enforceZdr: false,
      denyDataCollection: false,
    },
    diagnostics: { persistErrorLogs: true },
  },
  providers: [],
});

test.describe('llama.cpp performance tuning UI', () => {
  test('Settings shows the tuning selects with defaults and saves them', async ({
    page,
    serverContext,
  }) => {
    let saved;
    // The real isolated server supplies the defaults; saving is intercepted so the
    // worker-scoped config stays untouched for other specs.
    await page.route('**/api/generation/config', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      saved = route.request().postDataJSON();
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(configResponse(llamaCppConfig(saved.llamaCpp))),
      });
    });
    await page.goto(`${serverContext.baseUrl}/settings`);
    const kvCache = page.getByLabel(/KV cache/);
    const speculative = page.getByLabel(/Speculative decoding \(MTP\)/);
    const reasoning = page.getByLabel(/Reasoning effort/);
    await expect(kvCache).toBeVisible();
    await expect(kvCache).toHaveValue('quality');
    await expect(speculative).toHaveValue('auto');
    await expect(reasoning).toHaveValue('medium');
    await expect(page.getByText(/Q8_0 keys and values/)).toBeVisible();

    const contextHelp = page.locator('.llama-runtime-config small', {
      hasText: /^[\d,]+ tokens/,
    });
    await expect(contextHelp).not.toContainText('Experimental');
    await page.getByLabel('Context window in tokens').fill('131072');
    await page.getByLabel('Context window in tokens').press('Escape');
    await expect(contextHelp).toContainText('131,072 tokens · Experimental');

    await kvCache.selectOption('memory');
    await speculative.selectOption('off');
    await reasoning.selectOption('xhigh');
    await expect(page.getByText(/Q4_0 keys and values/)).toBeVisible();
    await page.getByRole('button', { name: 'Save generation settings' }).click();
    await expect
      .poll(() => saved?.llamaCpp)
      .toMatchObject({
        contextSize: 131_072,
        kvCache: 'memory',
        speculative: 'off',
        reasoningEffort: 'xhigh',
      });
    await expect(kvCache).toHaveValue('memory');
  });

  test('Settings tolerates a server that predates the tuning fields', async ({
    page,
    serverContext,
  }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/generation/config', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(configResponse(llamaCppConfig())),
      });
    });
    await page.goto(`${serverContext.baseUrl}/settings`);
    await expect(page.getByRole('heading', { name: 'llama.cpp wrapper' })).toBeVisible();
    await expect(page.getByLabel(/KV cache/)).toHaveValue('quality');
    await expect(page.getByLabel(/Speculative decoding \(MTP\)/)).toHaveValue('auto');
    await expect(page.getByLabel(/Reasoning effort/)).toHaveValue('medium');
    await expect(page.locator('.generation-settings .banner.err')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('runtime badge shows the applied profile and explains skipped options', async ({
    page,
    serverContext,
  }) => {
    await page.route('**/api/generation/runtime', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          backend: 'llama.cpp',
          runtime: {
            state: 'ready',
            model: 'D:\\models\\Qwen3.8-27B-UD-Q4_K_XL.gguf',
            contextSize: 65_536,
            detail: 'The local model is loaded and ready.',
          },
        }),
      });
    });
    await page.route('**/api/generation/runtime/logs', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          runtime: { state: 'ready', detail: 'The local model is loaded and ready.' },
          source: 'managed',
          logs: 'load_tensors: offloaded 65/65 layers to GPU',
          logsTruncated: false,
          devices: [
            { id: 'CUDA0', name: 'Test GPU', totalBytes: 24 * 1024 ** 3, freeBytes: 2 * 1024 ** 3 },
          ],
          deviceDetectionSupported: true,
          offload: {
            mode: 'gpu',
            gpuLayers: 65,
            totalLayers: 65,
            gpuPercent: 100,
            cpuPercent: 0,
            deviceBufferMiB: { CUDA0: 16_179.2, CPU_Mapped: 545 },
          },
          profile: [
            { setting: 'ctx', value: '64K', source: 'settings', applied: true },
            {
              setting: 'FA',
              value: 'on',
              source: 'threadshelf',
              applied: true,
              note: 'required by the quantized KV cache',
            },
            { setting: 'KV', value: 'q8_0×q8_0', source: 'settings', applied: true },
            {
              setting: 'MTP',
              value: '2',
              source: 'settings',
              applied: true,
              note: '1 NextN layer(s) in the GGUF',
            },
            {
              setting: 'reasoning',
              value: 'off',
              source: 'runtime',
              applied: false,
              note: 'this llama-server has no --reasoning switch',
            },
          ],
        }),
      });
    });
    await page.goto(`${serverContext.baseUrl}/settings`);
    const profile = page.locator('.generation-settings .runtime-profile');
    await expect(profile).toHaveText(
      'GPU · CUDA · ctx 64K · FA on · KV q8_0×q8_0 · MTP 2 · GPU weights 15.8 GiB',
    );
    await expect(profile).toHaveAttribute(
      'title',
      [
        'FA: required by the quantized KV cache',
        'MTP: 1 NextN layer(s) in the GGUF',
        'reasoning: skipped, this llama-server has no --reasoning switch',
      ].join('\n'),
    );
    // The compact sidebar badge never carries the profile line.
    await expect(page.locator('.sidebar .runtime-profile')).toHaveCount(0);
  });
});
