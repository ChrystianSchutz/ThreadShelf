import { test, expect } from './fixtures.js';

const strataModels = (models) => ({
  provider: 'strata',
  models,
  runtime: {
    state: 'external',
    model: models.find((model) => model.loaded)?.id,
    contextSize: models.find((model) => model.loaded)?.contextLength,
    detail:
      'Using the Strata server at http://127.0.0.1:8080. Start and stop it outside ThreadShelf.',
  },
});

const openModelMenu = async (page) => {
  await page.locator('#collection-pw_fixture').click();
  await expect(page.locator('.result').first()).toBeVisible({ timeout: 30_000 });
  await page.locator('.result').first().click();
  await page.locator('#modelMenuButton').click();
  await expect(page.locator('.model-popover')).toBeVisible();
};

test.describe('Strata provider tab', () => {
  test('streams through Strata as a local provider and remembers the tab after reload', async ({
    appPage,
    serverContext,
  }) => {
    await appPage.route('**/api/generation/models?provider=strata*', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          strataModels([
            {
              id: 'strata-model',
              name: 'strata-model',
              provider: 'strata',
              contextLength: 32768,
              loaded: true,
            },
          ]),
        ),
      });
    });
    let sentProvider;
    await appPage.route('**/api/generation/chat/stream', async (route) => {
      sentProvider = route.request().postDataJSON().provider;
      await route.fulfill({
        contentType: 'application/x-ndjson',
        body: [
          JSON.stringify({ type: 'delta', content: 'Answer from Strata' }),
          JSON.stringify({
            type: 'done',
            response: { provider: 'strata', model: 'strata-model', content: 'Answer from Strata' },
          }),
          '',
        ].join('\n'),
      });
    });

    await openModelMenu(appPage);
    const strataTab = appPage.getByRole('tab', { name: /Strata · local/ });
    await expect(strataTab).toBeVisible();
    await strataTab.click();
    await expect(strataTab).toHaveAttribute('aria-selected', 'true');
    await expect(appPage.getByText('1 model served by Strata')).toBeVisible();
    await expect(appPage.locator('#modelMenuButton')).toContainText('strata-model');
    // Strata runs on this machine: no off-device marker, a loopback hint instead.
    await expect(appPage.locator('.off-device-chip')).toHaveCount(0);
    await expect(appPage.locator('.composer-hint')).toHaveText('Loopback-only Strata server');

    await appPage.locator('#continuePrompt').fill('Hello Strata');
    await appPage.locator('#continueSend').click();
    await expect(appPage.getByText('Answer from Strata')).toBeVisible();
    expect(sentProvider).toBe('strata');

    // A fresh page load must restore the provider from the persisted UI store.
    await appPage.goto(`${serverContext.baseUrl}/`);
    await appPage.waitForSelector('#searchInput');
    await openModelMenu(appPage);
    await expect(appPage.getByRole('tab', { name: /Strata · local/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(appPage.locator('#modelMenuButton')).toContainText('strata-model');
  });

  test('explains an empty Strata model list', async ({ appPage }) => {
    await appPage.route('**/api/generation/models?provider=strata*', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(strataModels([])),
      });
    });
    await openModelMenu(appPage);
    await appPage.getByRole('tab', { name: /Strata · local/ }).click();
    await expect(appPage.getByText(/Strata reported no model/)).toBeVisible();
  });

  test('falls back to llama.cpp when the remembered provider is unknown', async ({
    page,
    serverContext,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        'threadshelf:ui',
        JSON.stringify({ state: { generationProvider: 'not-a-provider' }, version: 0 }),
      );
    });
    await page.goto(`${serverContext.baseUrl}/`);
    await page.waitForSelector('#searchInput');
    await expect(page.locator('#collection-pw_fixture')).toBeVisible({ timeout: 15_000 });
    await openModelMenu(page);
    await expect(page.getByRole('tab', { name: /llama\.cpp/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});
