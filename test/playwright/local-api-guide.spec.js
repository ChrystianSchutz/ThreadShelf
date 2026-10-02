import { test, expect } from './fixtures.js';

const openSettings = async (page, baseUrl) => {
  await page.goto(`${baseUrl}/settings`);
  const panel = page.locator('.panel', { hasText: 'Local model API' });
  await expect(panel).toBeVisible();
  return panel;
};

const putLocalApi = (baseUrl, localApi) =>
  fetch(`${baseUrl}/api/generation/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ localApi }),
  });

test.describe('Local model API settings and guide', () => {
  test.afterEach(async ({ serverContext }) => {
    // The server is shared by the worker: always leave the API open again.
    await putLocalApi(serverContext.baseUrl, {
      enabled: true,
      clearApiKey: true,
      networkAccess: false,
    });
  });

  test('the panel shows the open defaults', async ({ page, serverContext }) => {
    const panel = await openSettings(page, serverContext.baseUrl);
    await expect(panel.getByLabel('Serve the local model API at /v1')).toBeChecked();
    await expect(panel.getByLabel('Serve on the local network')).not.toBeChecked();
    await expect(panel.getByPlaceholder('Empty · no key required')).toBeVisible();
    await expect(panel.getByText(/No key: any program on this computer/)).toBeVisible();
    await expect(panel.locator('code', { hasText: 'POST /v1/models/unload' })).toBeVisible();
    await expect(panel.getByText('Network port')).toHaveCount(0);
  });

  test('the guide explains what works now in plain words', async ({ page, serverContext }) => {
    const panel = await openSettings(page, serverContext.baseUrl);
    await panel.getByRole('button', { name: /Guide: status/ }).click();
    const guide = page.getByRole('dialog', { name: 'Local model API guide' });
    await expect(guide).toBeVisible();
    await expect(guide.getByText(`On at ${serverContext.baseUrl}/v1`)).toBeVisible();
    await expect(guide.getByText('Only programs on this computer.')).toBeVisible();
    await expect(guide.getByText('Not required. Apps may send any key, or none.')).toBeVisible();
    await expect(guide.getByText(/^Never\. A loaded model stays in memory/)).toBeVisible();
    await expect(guide.getByText('Used by Claude Code.', { exact: false })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(guide).toHaveCount(0);
  });

  test('connect instructions are filled in for Claude Code, Codex and DeepSeek', async ({
    page,
    serverContext,
  }) => {
    const panel = await openSettings(page, serverContext.baseUrl);
    await panel.getByRole('button', { name: /Guide: status/ }).click();
    const guide = page.getByRole('dialog', { name: 'Local model API guide' });
    await guide.getByRole('tab', { name: 'Connect an app' }).click();

    await guide.getByRole('tab', { name: 'macOS / Linux' }).click();
    let snippet = guide.locator('.guide-snippet').first();
    await expect(snippet).toContainText(`export ANTHROPIC_BASE_URL="${serverContext.baseUrl}"`);
    // Regression: the token must be a real value, never "undefined".
    await expect(snippet).toContainText('export ANTHROPIC_AUTH_TOKEN="threadshelf"');
    await expect(snippet).toContainText('ANTHROPIC_DEFAULT_HAIKU_MODEL');
    await expect(snippet).not.toContainText('undefined');

    await guide.getByRole('tab', { name: 'Windows PowerShell' }).click();
    await expect(snippet).toContainText(`$env:ANTHROPIC_BASE_URL = "${serverContext.baseUrl}"`);

    await guide.getByRole('tab', { name: 'Codex CLI' }).click();
    snippet = guide.locator('.guide-snippet').first();
    await expect(snippet).toContainText(`base_url = "${serverContext.baseUrl}/v1"`);
    await expect(snippet).toContainText('wire_api = "responses"');
    await expect(snippet).not.toContainText('env_key');

    await guide.getByRole('tab', { name: 'DeepSeek Harness' }).click();
    await expect(guide.locator('.guide-snippet').first()).toContainText(
      `baseURL: ${serverContext.baseUrl}/v1`,
    );
    await expect(guide.locator('.guide-snippet').nth(1)).toContainText('THREADSHELF_API_KEY');

    await guide.getByRole('tab', { name: 'Any other app' }).click();
    await expect(guide.getByText('anything, e.g. threadshelf')).toBeVisible();
  });

  test('the llama.cpp panel opens the settings explanations', async ({ page, serverContext }) => {
    await openSettings(page, serverContext.baseUrl);
    await page.getByRole('button', { name: 'What do these settings mean?' }).click();
    const guide = page.getByRole('dialog', { name: 'Local model API guide' });
    await expect(guide.getByRole('tab', { name: 'Settings explained' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    for (const name of ['API key', 'Unload model from memory', 'Context window', 'KV cache']) {
      await expect(guide.locator('dt', { hasText: new RegExp(`^${name}$`) })).toBeVisible();
    }
    await guide.getByRole('button', { name: 'Close' }).click();
    await expect(guide).toHaveCount(0);
  });

  test('a generated key is saved, hidden, required and reflected in the guide', async ({
    page,
    serverContext,
  }) => {
    const panel = await openSettings(page, serverContext.baseUrl);
    await panel.getByRole('button', { name: 'Generate' }).click();
    const input = panel.locator('.local-api-key input');
    const key = await input.inputValue();
    expect(key).toMatch(/^ts-[0-9a-f]{48}$/);
    // The examples use the new key before it is saved, so it can be copied.
    await expect(panel.locator('.local-api-example')).toContainText(`Bearer ${key}`);

    await page.getByRole('button', { name: 'Save generation settings' }).click();
    await expect(page.getByText('Generation settings saved.')).toBeVisible();
    await expect(input).toHaveValue('');
    await expect(input).toHaveAttribute('placeholder', /A key is configured/);
    await expect(panel.locator('.local-api-example')).not.toContainText(key);

    let response = await fetch(`${serverContext.baseUrl}/v1/models`);
    expect(response.status).toBe(401);
    response = await fetch(`${serverContext.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(response.status).toBe(200);

    await panel.getByRole('button', { name: /Guide: status/ }).click();
    const guide = page.getByRole('dialog', { name: 'Local model API guide' });
    await expect(guide.getByText('Required. Apps must send the key you saved.')).toBeVisible();
    await guide.getByRole('tab', { name: 'Connect an app' }).click();
    await guide.getByRole('tab', { name: 'Codex CLI' }).click();
    await expect(guide.locator('.guide-snippet').first()).toContainText(
      'env_key = "THREADSHELF_API_KEY"',
    );
    await page.keyboard.press('Escape');

    await panel.getByLabel('Remove the saved key').check();
    await page.getByRole('button', { name: 'Save generation settings' }).click();
    await expect(input).toHaveAttribute('placeholder', 'Empty · no key required');
    response = await fetch(`${serverContext.baseUrl}/v1/models`);
    expect(response.status).toBe(200);
  });

  test('turning the API off is saved and shown in the guide', async ({ page, serverContext }) => {
    const panel = await openSettings(page, serverContext.baseUrl);
    await panel.getByLabel('Serve the local model API at /v1').uncheck();
    await page.getByRole('button', { name: 'Save generation settings' }).click();
    await expect(page.getByText('Generation settings saved.')).toBeVisible();
    const response = await fetch(`${serverContext.baseUrl}/v1/models`);
    expect(response.status).toBe(403);

    await panel.getByRole('button', { name: /Guide: status/ }).click();
    const guide = page.getByRole('dialog', { name: 'Local model API guide' });
    await expect(guide.getByText(/^Off\. Apps get "403 api_disabled"/)).toBeVisible();
  });

  test('the idle unload choice is saved', async ({ page, serverContext }) => {
    await openSettings(page, serverContext.baseUrl);
    const select = page.getByLabel('Unload model from memory');
    await expect(select).toHaveValue('0');
    await select.selectOption('15');
    await page.getByRole('button', { name: 'Save generation settings' }).click();
    await expect(page.getByText('Generation settings saved.')).toBeVisible();
    const { config } = await (await fetch(`${serverContext.baseUrl}/api/generation/config`)).json();
    expect(config.llamaCpp.idleUnloadMinutes).toBe(15);
    await fetch(`${serverContext.baseUrl}/api/generation/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ llamaCpp: { idleUnloadMinutes: 0 } }),
    });
  });
});
