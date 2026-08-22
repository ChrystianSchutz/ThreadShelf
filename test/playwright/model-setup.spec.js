import { test, expect } from './fixtures.js';

/**
 * Covers the two screens added for local model setup. Every upstream call is
 * mocked: these assert the UI contract (what the user is told before agreeing to
 * a download), not GitHub or Hugging Face availability.
 */

const HARDWARE = {
  devices: [{ id: 'CUDA0', name: 'NVIDIA GeForce RTX 3090 Ti', totalBytes: 2.5e10, freeBytes: 2.4e10 }],
  detectionSource: 'llama.cpp',
  totalRamBytes: 1.02e11,
  freeRamBytes: 7e10,
  vramBudgetBytes: 2e10,
  modelBudgetBytes: 2e10,
  suggestedVariant: 'cuda',
};

const planWith = (overrides = {}) => ({
  hardware: HARDWARE,
  runtime: {
    action: 'install',
    variant: 'cuda',
    tag: 'b10566',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b10566/llama-b10566-bin-win-cuda-13.3-x64.zip',
    sha256: 'c3e2336c1427e8bd7b5beb3c8618d2f7a268bc5fb6ec3f28c1e06cdb78d2e80a',
    sizeBytes: 146_800_640,
    companions: [{ url: 'https://example.test/cudart.zip', sha256: 'a'.repeat(64), sizeBytes: 391_118_848 }],
    destination: 'C:\\ThreadShelf\\.threadshelf\\tools',
    releaseUrl: 'https://github.com/ggml-org/llama.cpp/releases/tag/b10566',
  },
  model: {
    action: 'download',
    repoId: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF',
    quant: 'Q4_K_M',
    totalBytes: 18_560_000_000,
    directory: 'C:\\ThreadShelf\\.threadshelf\\models\\unsloth__Qwen3-Coder-30B-A3B-Instruct-GGUF',
    files: [{ url: 'https://example.test/model.gguf', sha256: 'b'.repeat(64), sizeBytes: 18_560_000_000 }],
    license: 'apache-2.0',
    contextLength: 262_144,
    fit: 'fits',
  },
  totalDownloadBytes: 19_097_919_488,
  warnings: [],
  fingerprint: 'plan-one',
  ...overrides,
});

const mockPlan = async (page, plan) => {
  await page.route('**/api/generation/setup/plan*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(plan) });
  });
};

const openGenerationSettings = async (page, baseUrl) => {
  await page.goto(`${baseUrl}/settings`);
  await page.waitForSelector('.quick-setup');
};

test.describe('Quick setup screen', () => {
  test('lists every artifact with its digest, size and destination before any download', async ({
    appPage,
    serverContext,
  }) => {
    await mockPlan(appPage, planWith());
    await openGenerationSettings(appPage, serverContext.baseUrl);

    await expect(appPage.locator('.quick-setup-detected')).toContainText('RTX 3090 Ti');
    await expect(appPage.locator('.quick-setup-detected')).toContainText('cuda');

    const steps = appPage.locator('.quick-setup-steps li');
    await expect(steps).toHaveCount(2);
    // The runtime archive, its digest and its size are all stated up front.
    await expect(steps.first()).toContainText('llama.cpp b10566');
    await expect(steps.first()).toContainText('llama-b10566-bin-win-cuda-13.3-x64.zip');
    await expect(steps.first()).toContainText('c3e2336c');
    await expect(steps.first()).toContainText('140 MB');
    await expect(steps.first()).toContainText('runtime companion');

    await expect(steps.nth(1)).toContainText('unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF');
    await expect(steps.nth(1)).toContainText('Q4_K_M');
    await expect(steps.nth(1)).toContainText('apache-2.0');

    await expect(appPage.locator('.quick-setup-destination')).toContainText('.threadshelf');
    // One button, and it names the total it is about to fetch.
    await expect(appPage.getByRole('button', { name: /Download and install/ })).toContainText('18 GB');
  });

  test('does not advertise a transfer for a model that is already on disk', async ({
    appPage,
    serverContext,
  }) => {
    await mockPlan(
      appPage,
      planWith({
        model: { ...planWith().model, action: 'reuse' },
        totalDownloadBytes: 537_919_488,
        fingerprint: 'plan-reuse',
      }),
    );
    await openGenerationSettings(appPage, serverContext.baseUrl);

    await expect(appPage.locator('.quick-setup-steps li').nth(1)).toContainText('already downloaded');
    const button = appPage.getByRole('button', { name: /Download and install/ });
    await expect(button).toContainText('513 MB');
    await expect(button).not.toContainText('18 GB');
  });

  test('reports that nothing is left to do when the runtime and model are both present', async ({
    appPage,
    serverContext,
  }) => {
    await mockPlan(
      appPage,
      planWith({
        runtime: { ...planWith().runtime, action: 'reuse', executablePath: 'C:\\llama-server.exe' },
        model: { ...planWith().model, action: 'reuse' },
        totalDownloadBytes: 0,
        fingerprint: 'plan-nothing',
      }),
    );
    await openGenerationSettings(appPage, serverContext.baseUrl);

    const button = appPage.getByRole('button', { name: /already installed/ });
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();
  });

  test('shows the replacement plan instead of downloading when it changed after approval', async ({
    appPage,
    serverContext,
  }) => {
    await mockPlan(appPage, planWith());
    let runCalls = 0;
    await appPage.route('**/api/generation/setup/run', async (route) => {
      runCalls += 1;
      // The server re-resolved the plan and it no longer matches what was shown.
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'The setup plan changed since it was shown. Review the new plan and confirm again.',
          plan: planWith({
            runtime: { ...planWith().runtime, tag: 'b10577' },
            fingerprint: 'plan-two',
          }),
        }),
      });
    });
    await openGenerationSettings(appPage, serverContext.baseUrl);

    await appPage.getByRole('button', { name: /Download and install/ }).click();

    // The user is told, and the screen now shows the build they must re-approve.
    await expect(appPage.getByText(/setup plan changed/i)).toBeVisible();
    await expect(appPage.locator('.quick-setup-steps li').first()).toContainText('b10577');
    expect(runCalls).toBe(1);
  });

  test('sends the approved plan identity so the server can detect drift', async ({
    appPage,
    serverContext,
  }) => {
    await mockPlan(appPage, planWith());
    let body;
    await appPage.route('**/api/generation/setup/run', async (route) => {
      body = JSON.parse(route.request().postData() ?? '{}');
      await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: '' });
    });
    await openGenerationSettings(appPage, serverContext.baseUrl);
    await appPage.getByRole('button', { name: /Download and install/ }).click();
    await expect.poll(() => body?.fingerprint).toBe('plan-one');

    expect(body.confirm).toBe(true);
    expect(body.releaseTag).toBe('b10566');
    expect(body.model).toBe('unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF');
    expect(body.quant).toBe('Q4_K_M');
  });
});

test.describe('Model catalog browser', () => {
  const SEARCH = {
    models: [
      {
        id: 'unsloth/Qwen3.5-4B-GGUF',
        author: 'unsloth',
        name: 'Qwen3.5-4B-GGUF',
        downloads: 12_364_836,
        likes: 915,
        gated: false,
        trustedPublisher: true,
      },
      {
        id: 'orcarouter/Qwen3.8-27B-Uncensored-GGUF',
        author: 'orcarouter',
        name: 'Qwen3.8-27B-Uncensored-GGUF',
        downloads: 85_371,
        likes: 309,
        gated: 'auto',
        trustedPublisher: false,
      },
    ],
    source: 'https://huggingface.co',
    tokenConfigured: false,
    hardware: HARDWARE,
  };

  const detail = (gated) => ({
    model: {
      id: gated ? 'orcarouter/Qwen3.8-27B-Uncensored-GGUF' : 'unsloth/Qwen3.5-4B-GGUF',
      author: gated ? 'orcarouter' : 'unsloth',
      name: 'x',
      downloads: 1,
      likes: 1,
      gated: gated ? 'auto' : false,
      trustedPublisher: !gated,
      projectors: [],
      quants: [
        { label: 'Q4_K_M', totalBytes: 2_500_000_000, shards: 1, recommended: true, fit: 'fits', files: [] },
        { label: 'Q8_0', totalBytes: 4_300_000_000, shards: 1, recommended: false, fit: 'tight', files: [] },
        { label: 'BF16', totalBytes: 90_000_000_000, shards: 1, recommended: false, fit: 'too-large', files: [] },
      ],
    },
    hardware: HARDWARE,
    tokenConfigured: false,
  });

  const mockCatalog = async (page, gated = false) => {
    await page.route('**/api/generation/catalog/search*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SEARCH) });
    });
    await page.route('**/api/generation/catalog/model*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail(gated)) });
    });
  };

  test('shows popularity and a per-quantisation verdict against detected memory', async ({
    appPage,
    serverContext,
  }) => {
    await mockPlan(appPage, planWith());
    await mockCatalog(appPage);
    await openGenerationSettings(appPage, serverContext.baseUrl);
    await appPage.getByRole('button', { name: /Download a model/ }).click();

    await expect(appPage.locator('.catalog-hardware')).toContainText('RTX 3090 Ti');
    await expect(appPage.locator('.catalog-item').first()).toContainText('12.4M');
    await expect(appPage.locator('.catalog-badge.trusted').first()).toBeVisible();

    await appPage.locator('.catalog-item-head').first().click();
    const quants = appPage.locator('.catalog-quant');
    await expect(quants).toHaveCount(3);
    await expect(quants.nth(0)).toContainText('fits in VRAM');
    await expect(quants.nth(1)).toContainText('partly on CPU');
    await expect(quants.nth(2)).toContainText('too large');
    await expect(quants.nth(0)).toContainText('recommended');
  });

  test('marks a gated repository and refuses to download it without a token', async ({
    appPage,
    serverContext,
  }) => {
    await mockPlan(appPage, planWith());
    await mockCatalog(appPage, true);
    await openGenerationSettings(appPage, serverContext.baseUrl);
    await appPage.getByRole('button', { name: /Download a model/ }).click();

    // The warning is visible before the row is even opened.
    await expect(appPage.locator('.catalog-badge.gated')).toContainText('needs HF login');
    await expect(appPage.locator('.catalog-token-hint')).toBeVisible();

    await appPage.locator('.catalog-item-head').nth(1).click();
    await expect(appPage.locator('.catalog-gated-note')).toContainText('HF_TOKEN');
    // Every download button in the gated repository stays disabled.
    const buttons = appPage.locator('.catalog-quant button');
    await expect(buttons.first()).toBeDisabled();
  });
});
