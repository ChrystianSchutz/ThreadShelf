import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from './fixtures.js';
import { startVaultProvider } from '../shared/vault-provider.js';

test('vault settings search, create and read-only toggle work', async ({ page, serverContext }) => {
  const vault = join(serverContext.tempRoot, 'vault-settings');
  await mkdir(vault);
  await writeFile(join(vault, 'context.md'), '# Synthetic PKM\nSearchable local knowledge');
  try {
    await page.goto(`${serverContext.baseUrl}/settings`);
    await page.locator('#obsidianVaultPath').fill(vault);
    await page.getByRole('button', { name: 'Save vault', exact: true }).click();
    await expect(page.getByText('Vault connected.', { exact: true })).toBeVisible();
    await expect(page.locator('#vaultAllowWrites')).toBeChecked();
    await page.locator('#obsidianSearchInput').fill('knowledge');
    await page.getByRole('button', { name: 'Search vault', exact: true }).click();
    await expect(page.locator('.vault-result')).toContainText('context.md');
    await page.locator('.vault-result').click();
    await expect(page.locator('.vault-note')).toContainText('Searchable local knowledge');
    await page.getByText('Create a Markdown note', { exact: true }).click();
    await page.locator('#obsidianNewPath').fill('created.md');
    await page.locator('#obsidianNewContent').fill('# Created\n[[context]]');
    await page.getByRole('button', { name: 'Create note', exact: true }).click();
    await expect(page.getByText('Markdown note created.', { exact: true })).toBeVisible();
    expect(await readFile(join(vault, 'created.md'), 'utf8')).toBe('# Created\n[[context]]');
    await page.locator('#vaultAllowWrites').uncheck();
    await expect(page.getByRole('button', { name: 'Create note', exact: true })).toBeDisabled();
  } finally {
    await page.request.put(`${serverContext.baseUrl}/api/obsidian/config`, {
      data: { vaultPath: '', allowWrites: true },
    });
  }
});

for (const approve of [true, false]) {
  test(`agent deletion requires the checkbox and can be ${approve ? 'approved' : 'cancelled'}`, async ({
    page,
    serverContext,
  }) => {
    const model = await startVaultProvider();
    const vault = join(serverContext.tempRoot, `vault-approval-${approve}`);
    await mkdir(vault);
    await writeFile(join(vault, 'note.md'), 'Synthetic note to delete');
    try {
      await page.request.put(`${serverContext.baseUrl}/api/obsidian/config`, {
        data: { vaultPath: vault, allowWrites: true },
      });
      await page.request.put(`${serverContext.baseUrl}/api/generation/config`, {
        data: { llamaCpp: { baseUrl: model.baseUrl } },
      });
      await page.goto(`${serverContext.baseUrl}/chat`);
      await page.locator('#sidebarPrivateChatButton').click();
      await expect(page.locator('#modelMenuButton')).toContainText('Synthetic Model X');
      await page.locator('#chatUseObsidian').check();
      await page.locator('#continuePrompt').fill('Delete note.md');
      await page.locator('#continuePrompt').press('Enter');
      await expect(page.locator('.vault-approval')).toBeVisible();
      await expect(page.locator('.vault-approval')).toContainText(
        'Synthetic Model X wants to delete',
      );
      await expect(page.locator('.vault-approval li')).toHaveText('note.md');
      await expect(page.locator('#vaultDeleteConfirm')).toBeDisabled();
      expect(await readFile(join(vault, 'note.md'), 'utf8')).toBe('Synthetic note to delete');
      if (approve) {
        await page.locator('#vaultDeleteAcknowledged').check();
        await page.locator('#vaultDeleteConfirm').click();
      } else await page.getByRole('button', { name: 'Cancel vault deletion', exact: true }).click();
      await expect(page.locator('.vault-approval')).toHaveCount(0);
      await expect(page.locator('.generated-turn[data-role="ai"]').last()).toContainText(
        approve ? 'Vault operation completed.' : 'Deletion cancelled.',
      );
      if (approve) await expect(readFile(join(vault, 'note.md'))).rejects.toThrow();
      else expect(await readFile(join(vault, 'note.md'), 'utf8')).toBe('Synthetic note to delete');
    } finally {
      await page.request.put(`${serverContext.baseUrl}/api/obsidian/config`, {
        data: { vaultPath: '', allowWrites: true },
      });
      await page.request.put(`${serverContext.baseUrl}/api/generation/config`, {
        data: { llamaCpp: { baseUrl: '' } },
      });
      await model.close();
    }
  });
}
