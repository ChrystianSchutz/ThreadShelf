import { test, expect } from './fixtures.js';

const privatePrompt = 'A synthetic private question 723';
const privateAnswer = 'A synthetic private answer 824';
const privateDraft = 'An unsent synthetic private draft 925';
const partialAnswer = 'A synthetic partial answer 136';

test.describe('Private chat memory', () => {
  test('keeps messages, drafts, and recovery only until reload', async ({
    page,
    serverContext,
  }) => {
    await page.route('**/api/generation/models?provider=llama-cpp*', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          provider: 'llama-cpp',
          models: [{ id: 'synthetic.gguf', name: 'Synthetic model', provider: 'llama-cpp' }],
          runtime: { state: 'ready', model: 'synthetic.gguf', detail: 'Ready.' },
        }),
      });
    });
    let sends = 0;
    await page.route('**/api/generation/chat/stream', async (route) => {
      const request = route.request().postDataJSON();
      expect(request.ephemeral).toBe(true);
      sends += 1;
      await route.fulfill({
        contentType: 'application/x-ndjson',
        body:
          sends === 1
            ? `${JSON.stringify({ type: 'done', response: { provider: 'llama-cpp', model: 'synthetic.gguf', content: privateAnswer } })}\n`
            : [
                JSON.stringify({ type: 'delta', content: partialAnswer }),
                JSON.stringify({ type: 'error', error: 'Synthetic stream failure' }),
                '',
              ].join('\n'),
      });
    });

    await page.goto(`${serverContext.baseUrl}/`);
    await page.locator('#sidebarPrivateChatButton').click();
    await page.locator('#continuePrompt').fill(privatePrompt);
    await page.locator('#continueSend').click();
    await expect(page.locator('.generated-turn[data-role="ai"]')).toContainText(privateAnswer);
    await page.locator('#continuePrompt').fill('A synthetic failing question 247');
    await page.locator('#continueSend').click();
    await expect(page.locator('.interrupted-generation')).toContainText(partialAnswer);
    await page.locator('#continuePrompt').fill(privateDraft);

    const storageText = await page.evaluate(() =>
      JSON.stringify({
        local: Object.entries(localStorage),
        session: Object.entries(sessionStorage),
      }),
    );
    for (const secret of [privatePrompt, privateAnswer, privateDraft, partialAnswer]) {
      expect(storageText).not.toContain(secret);
    }

    await page.getByRole('button', { name: 'Search archive' }).click();
    await expect(page.locator('#searchInput')).toBeVisible();
    await page.locator('#sidebarPrivateChatButton').click();
    await expect(page.locator('.generated-turn[data-role="ai"]')).toContainText(privateAnswer);
    await expect(page.locator('.interrupted-generation')).toContainText(partialAnswer);
    await expect(page.locator('#continuePrompt')).toHaveValue(privateDraft);

    await page.reload();
    await expect(page.locator('.chat-storage-badge.private')).toBeVisible();
    await expect(page.locator('.generated-turn')).toHaveCount(0);
    await expect(page.locator('.interrupted-generation')).toHaveCount(0);
    await expect(page.locator('#continuePrompt')).toHaveValue('');

    const otherTab = await page.context().newPage();
    try {
      await otherTab.goto(`${serverContext.baseUrl}/chat?private=fresh`);
      await expect(otherTab.locator('.chat-storage-badge.private')).toBeVisible();
      await expect(otherTab.locator('.generated-turn')).toHaveCount(0);
    } finally {
      await otherTab.close();
    }
  });

  test('loads chat when Web Storage access throws', async ({ page, serverContext }) => {
    await page.addInitScript(() => {
      for (const name of ['sessionStorage', 'localStorage']) {
        Object.defineProperty(window, name, {
          configurable: true,
          get() {
            throw new DOMException('Storage is blocked', 'SecurityError');
          },
        });
      }
    });
    await page.goto(`${serverContext.baseUrl}/chat?private=fresh`);
    await expect(page.locator('.chat-storage-badge.private')).toBeVisible();
    await expect(page.locator('#continuePrompt')).toBeVisible();
    await page.locator('#continuePrompt').fill(privateDraft);
    await expect(page.locator('#continuePrompt')).toHaveValue(privateDraft);
  });
});
