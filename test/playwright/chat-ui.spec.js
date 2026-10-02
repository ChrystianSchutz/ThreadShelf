import { test, expect } from './fixtures.js';

test.describe('Chat and generation UI', () => {
  test('the Experimental Alpha badge is gone from Settings', async ({ appPage }) => {
    await appPage.getByRole('button', { name: 'Settings' }).click();
    await expect(appPage.getByText('Conversation generation')).toBeVisible();
    // Alpha labeling is kept at the feature boundary instead of repeated in Settings.
    await expect(appPage.getByText('Experimental Alpha')).toHaveCount(0);
  });

  test('the chat empty state no longer labels generation as alpha', async ({
    appPage,
    serverContext,
  }) => {
    await appPage.goto(`${serverContext.baseUrl}/chat`);
    // No saved chats in the isolated test server, so the workspace explains
    // how created conversations differ from the imported archive.
    await expect(appPage.getByRole('heading', { name: 'Start a new conversation' })).toBeVisible();
    await expect(appPage.getByText(/experimental|alpha/i)).toHaveCount(0);
  });

  test('empty collections are hidden behind a "Show N empty" toggle', async ({
    appPage,
    serverContext,
  }) => {
    const name = `empty_${Date.now()}`;
    const created = await appPage.request.post(`${serverContext.baseUrl}/api/collections`, {
      data: { name },
    });
    expect(created.ok()).toBe(true);
    await appPage.reload();
    await expect(appPage.locator('#collection-pw_fixture')).toBeVisible({ timeout: 15_000 });

    // The freshly created, empty collection is collapsed by default...
    await expect(appPage.locator(`#collection-${name}`)).toHaveCount(0);
    const toggle = appPage.locator('#toggleEmptyCollections');
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText(/Show \d+ empty/);

    // ...and revealed on demand.
    await toggle.click();
    await expect(appPage.locator(`#collection-${name}`)).toBeVisible();
    await expect(toggle).toHaveText('Hide empty collections');
  });

  test('renames a saved chat and persists it', async ({ appPage, serverContext }) => {
    const created = await appPage.request.post(`${serverContext.baseUrl}/api/generation/threads`, {
      data: { title: 'Original title' },
    });
    expect(created.ok()).toBe(true);

    await appPage.reload();
    await appPage.locator('#sidebarChatHistoryToggle').click();
    await appPage.locator('.sb-chat-item', { hasText: 'Original title' }).click();
    await expect(appPage.getByRole('heading', { name: 'Original title' })).toBeVisible();

    await appPage.locator('#renameChatButton').click();
    await appPage.locator('#chatTitleInput').fill('Renamed chat');
    await appPage.locator('#chatTitleInput').press('Enter');

    await expect(appPage.getByRole('heading', { name: 'Renamed chat' })).toBeVisible();
    await expect(appPage.locator('.sb-chat-history-list')).toContainText('Renamed chat');

    // The PATCH persisted server-side, not just in local state.
    await appPage.reload();
    await expect(appPage.locator('.sb-chat-history-list')).toContainText('Renamed chat');
    await expect(appPage.locator('.sb-chat-history-list')).not.toContainText('Original title');
  });

  test('opens a saved chat from the sidebar and deletes it from its header', async ({
    appPage,
    serverContext,
  }) => {
    const created = await appPage.request.post(`${serverContext.baseUrl}/api/generation/threads`, {
      data: { title: 'Trash me' },
    });
    expect(created.ok()).toBe(true);

    await appPage.reload();
    await appPage.locator('#sidebarChatHistoryToggle').click();
    await appPage.locator('.sb-chat-item', { hasText: 'Trash me' }).click();
    await appPage.locator('.chat-hero').getByRole('button', { name: 'Delete' }).click();
    await appPage.getByRole('button', { name: 'Delete chat' }).click();
    await expect(appPage.locator('.sb-chat-item', { hasText: 'Trash me' })).toHaveCount(0);
  });

  test('renders assistant markdown in the archived thread reader (feature #3)', async ({
    appPage,
  }) => {
    // Browse (no query) so no turn is the search match — every AI turn renders
    // through the Markdown component rather than raw text.
    await appPage.locator('#collection-pw_fixture').click();
    await expect(appPage.locator('.result').first()).toBeVisible({ timeout: 30_000 });
    await appPage.locator('.result').first().click();
    await expect(appPage.locator('#threadOverlay')).toBeVisible();
    await expect(appPage.locator('.turn[data-role="ai"] .md-body').first()).toBeVisible();
  });

  test('a saved master prompt rides along with every request', async ({
    appPage,
    serverContext,
  }) => {
    const created = await appPage.request.post(`${serverContext.baseUrl}/api/generation/threads`, {
      data: { title: 'Master prompt chat' },
    });
    expect(created.ok()).toBe(true);

    await appPage.route('**/api/generation/models?provider=llama-cpp*', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          provider: 'llama-cpp',
          models: [{ id: 'local/test.gguf', name: 'Local Test', provider: 'llama-cpp' }],
          runtime: { state: 'stopped', detail: 'No model loaded.' },
        }),
      });
    });
    let sentSystemPrompt;
    await appPage.route('**/api/generation/chat/stream', async (route) => {
      sentSystemPrompt = route.request().postDataJSON().systemPrompt;
      await route.fulfill({
        contentType: 'application/x-ndjson',
        body: `${JSON.stringify({
          type: 'done',
          response: { provider: 'llama-cpp', model: 'local/test.gguf', content: 'ok' },
        })}\n`,
      });
    });

    await appPage.reload();
    await appPage.locator('#sidebarChatHistoryToggle').click();
    await appPage.locator('.sb-chat-item', { hasText: 'Master prompt chat' }).click();

    // The chip starts neutral, then names the active prompt.
    const chip = appPage.locator('#masterPromptButton');
    await expect(chip).toHaveText('System');
    await chip.click();
    await appPage.getByLabel('Master prompt name').fill('Terse');
    await appPage.locator('#masterPromptText').fill('Answer in one sentence.');
    await appPage.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(chip).toHaveText('Terse');

    await appPage.locator('#continuePrompt').fill('Hello');
    await appPage.locator('#continueSend').click();
    await expect.poll(() => sentSystemPrompt).toBe('Answer in one sentence.');

    // Switching it off stops sending it, and the choice survives a reload.
    await chip.click();
    await appPage.getByRole('button', { name: 'Off', exact: true }).click();
    await expect(chip).toHaveText('System');
    await appPage.reload();
    await expect(appPage.locator('#masterPromptButton')).toHaveText('System');
  });

  test('the model dropdown inside the composer popover is actually visible', async ({
    appPage,
  }) => {
    await appPage.locator('#sidebarNewChatButton').click();
    await appPage.locator('#modelMenuButton').click();

    // Regression: the combobox inherited light text on the UA-default white
    // field, so the control read as an empty gap in the popover.
    const field = appPage.getByLabel('Generation model');
    await expect(field).toBeVisible();
    const colors = await field.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        color: style.color,
        background: style.backgroundColor,
        border: style.borderTopWidth,
      };
    });
    expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(colors.color).not.toBe(colors.background);
    expect(colors.border).not.toBe('0px');
  });

  test('new chat is global and chat history does not split the mobile layout', async ({
    appPage,
  }) => {
    await appPage.setViewportSize({ width: 390, height: 844 });
    await appPage.getByLabel('Open sidebar').click();
    await expect(appPage.locator('.sidebar')).toHaveCount(1);
    const [newChatBox, privateChatBox] = await Promise.all([
      appPage.locator('#sidebarNewChatButton').boundingBox(),
      appPage.locator('#sidebarPrivateChatButton').boundingBox(),
    ]);
    expect(newChatBox?.y).toBe(privateChatBox?.y);
    expect(newChatBox?.height).toBe(privateChatBox?.height);

    await appPage.locator('#sidebarChatHistoryToggle').click();
    await expect(appPage.locator('.sb-chat-history-list')).toBeVisible();
    await expect(appPage.locator('.chat-list')).toHaveCount(0);

    await appPage.locator('#sidebarNewChatButton').click();

    await expect(appPage).toHaveURL(/\/chat\?draft=/);
    await expect(appPage.getByRole('heading', { name: 'New chat' })).toBeVisible();
    await expect(appPage.locator('#continuePrompt')).toBeVisible();

    const pageDisplay = await appPage
      .locator('.chat-page')
      .evaluate((node) => getComputedStyle(node).display);
    expect(pageDisplay).not.toBe('grid');
  });

  test('chat and archive live in one sidebar that does not change between views', async ({
    appPage,
  }) => {
    const sidebar = appPage.locator('.sidebar');
    await expect(sidebar).toHaveCount(1);
    await expect(sidebar.locator('.sb-chat-panel')).toBeVisible();
    await expect(sidebar.locator('#collection-pw_fixture')).toBeVisible();
    const widthBefore = (await sidebar.boundingBox())?.width;

    await sidebar.locator('#sidebarNewChatButton').click();
    await expect(appPage).toHaveURL(/\/chat\?draft=/);
    await expect(sidebar.locator('.sb-chat-panel')).toBeVisible();
    await expect(sidebar.locator('#collection-pw_fixture')).toBeVisible();
    expect((await sidebar.boundingBox())?.width).toBe(widthBefore);
  });

  test('a new chat never inherits a failed generation from an older draft', async ({ appPage }) => {
    await appPage.evaluate(() => {
      sessionStorage.setItem(
        'threadshelf:interrupted-generations:draft-saved',
        JSON.stringify([
          {
            id: 'old-failure',
            prompt: 'test',
            content: 'A complete-looking answer',
            reasoning: '',
            model: 'old-model.gguf',
            provider: 'llama-cpp',
            error: 'Error in input stream',
            stopped: false,
            createdAt: new Date().toISOString(),
          },
        ]),
      );
    });

    await appPage.locator('#sidebarNewChatButton').click();
    await expect(appPage.locator('.interrupted-generation')).toHaveCount(0);
    await expect
      .poll(() =>
        appPage.evaluate(
          () =>
            Object.keys(sessionStorage).filter((key) =>
              key.startsWith('threadshelf:interrupted-generations:draft:'),
            ).length,
        ),
      )
      .toBe(1);
    const firstScope = await appPage.evaluate(() =>
      Object.keys(sessionStorage).find((key) =>
        key.startsWith('threadshelf:interrupted-generations:draft:'),
      ),
    );
    await appPage.locator('#sidebarNewChatButton').click();
    await expect(appPage.locator('.interrupted-generation')).toHaveCount(0);
    await expect
      .poll(() =>
        appPage.evaluate(
          () =>
            Object.keys(sessionStorage).filter((key) =>
              key.startsWith('threadshelf:interrupted-generations:draft:'),
            ).length,
        ),
      )
      .toBe(2);
    const draftScopes = await appPage.evaluate(() =>
      Object.keys(sessionStorage).filter((key) =>
        key.startsWith('threadshelf:interrupted-generations:draft:'),
      ),
    );
    expect(firstScope).toBeTruthy();
    expect(draftScopes).toHaveLength(2);
  });

  test('deletes a ThreadShelf conversation straight from search', async ({
    appPage,
    serverContext,
  }) => {
    const created = await appPage.request.post(`${serverContext.baseUrl}/api/generation/threads`, {
      data: {
        title: 'Deletable chat',
        turns: [{ user: 'searchable marker question' }, { ai: 'a stored reply' }],
      },
    });
    expect(created.ok()).toBe(true);

    await appPage.reload();
    await appPage.locator('#collection-threadshelf_conversations').click();
    const target = appPage.locator('.result', { hasText: 'Deletable chat' }).first();
    await expect(target).toBeVisible({ timeout: 30_000 });
    await target.click();
    await expect(appPage.locator('#threadOverlay')).toBeVisible();

    // The delete affordance exists in the thread reader for ThreadShelf chats.
    await appPage.locator('#deleteThreadShelfChat').click();
    await appPage.getByRole('alertdialog').getByRole('button', { name: 'Delete chat' }).click();
    await expect(appPage.locator('#threadOverlay')).toHaveCount(0);
  });
});
