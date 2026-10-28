import { test, expect } from './fixtures.js';

test('generation settings cannot be edited or saved before the stored config loads', async ({
  page,
  serverContext,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/generation/config', async (route) => {
    if (route.request().method() === 'GET') await gate;
    await route.continue();
  });
  await page.goto(`${serverContext.baseUrl}/settings`);
  await expect(
    page.getByRole('status').filter({ hasText: 'Loading generation settings' }),
  ).toBeVisible();
  // Saving now would replace the stored settings with placeholder defaults.
  await expect(page.getByRole('button', { name: 'Save generation settings' })).toHaveCount(0);
  await expect(page.locator('.panel', { hasText: 'Local model API' })).toHaveCount(0);
  release();
  await expect(page.getByRole('button', { name: 'Save generation settings' })).toBeVisible();
  await expect(page.locator('.panel', { hasText: 'Local model API' })).toBeVisible();
});
