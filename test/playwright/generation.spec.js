import { test, expect } from './fixtures.js';

test.describe('Experimental generation UI', () => {
  test('opens a lazy saved draft, offers private mode, and never writes an empty chat', async ({
    appPage,
    serverContext,
  }) => {
    const [newChatBox, privateChatBox] = await Promise.all([
      appPage.locator('#sidebarNewChatButton').boundingBox(),
      appPage.locator('#sidebarPrivateChatButton').boundingBox(),
    ]);
    expect(newChatBox?.y).toBe(privateChatBox?.y);
    expect(newChatBox?.height).toBe(privateChatBox?.height);

    // "New chat" opens a draft — saved by default, but no database row or
    // ThreadShelf collection is written until the first message is sent.
    const threadsBefore = await (
      await appPage.request.get(`${serverContext.baseUrl}/api/generation/threads`)
    ).json();
    const collectionsBefore = await (
      await appPage.request.get(`${serverContext.baseUrl}/api/collections`)
    ).json();
    await appPage.locator('#sidebarNewChatButton').click();
    await expect(appPage.locator('.chat-storage-badge.saved')).toHaveText('Saved locally');
    await expect(appPage.getByText(/Not saved yet/)).toBeVisible();
    await expect(appPage.locator('#continuePrompt')).toBeVisible();
    await expect(appPage.locator('#modelMenuButton')).toBeVisible();
    await expect(appPage.locator('#continueSend')).toHaveText('Send');
    // Opening the draft adds no ghost row and materializes no collection.
    const threadsAfter = await (
      await appPage.request.get(`${serverContext.baseUrl}/api/generation/threads`)
    ).json();
    const collectionsAfter = await (
      await appPage.request.get(`${serverContext.baseUrl}/api/collections`)
    ).json();
    expect(threadsAfter.threads).toHaveLength(threadsBefore.threads.length);
    expect(collectionsAfter.collections).toEqual(collectionsBefore.collections);

    await appPage.getByLabel('Start private conversation').click();
    await expect(appPage.locator('.chat-storage-badge.private')).toContainText('Private');
    await expect(appPage.getByText(/Not saved or indexed/)).toBeVisible();
    await expect(appPage.getByLabel('Save conversation')).toHaveCount(0);
  });

  test('no longer labels llama.cpp and OpenRouter settings as Experimental Alpha', async ({
    page,
    serverContext,
  }) => {
    await page.goto(`${serverContext.baseUrl}/settings`);
    await expect(page.getByRole('heading', { name: 'Conversation generation' })).toBeVisible();
    // Experimental Alpha labeling is not repeated throughout Settings.
    await expect(page.getByText('Experimental Alpha')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'llama.cpp wrapper' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'OpenRouter API' })).toBeVisible();
    await expect(page.getByText('Nothing downloads until explicit')).toBeVisible();
    await expect(page.getByLabel('Acceleration profile')).toHaveValue('auto');
    await expect(page.getByLabel('Context window')).toHaveValue('8192');
    await expect(page.getByLabel(/ZDR-only routing by default/)).not.toBeChecked();
    await expect(page.getByLabel(/providers that deny data collection/)).not.toBeChecked();
    await expect(page.getByLabel(/Save generation errors/)).toBeChecked();
    await expect(page.getByRole('button', { name: 'Browse system folders…' })).toBeVisible();
    await expect(page.getByText('no model loaded').first()).toBeVisible();
  });

  test('selects the already loaded llama.cpp model on entry', async ({ page, serverContext }) => {
    // Reproduces a desktop browser at high zoom / a short laptop viewport.
    await page.setViewportSize({ width: 940, height: 560 });
    const executable =
      'D:\\AI\\viewerHistoriLLM\\.threadshelf\\tools\\llama.cpp\\b10088-cuda\\llama-server.exe';
    await page.route('**/api/generation/config', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          config: { openRouter: { enforceZdr: false } },
          providers: [
            {
              id: 'llama-cpp',
              label: 'llama.cpp',
              available: true,
              local: true,
              detail: `Executable: ${executable}`,
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
              id: 'D:\\models\\not-loaded.gguf',
              name: 'Not loaded',
              provider: 'llama-cpp',
              loaded: false,
            },
            {
              id: 'D:\\models\\loaded-model.gguf',
              name: 'Loaded model',
              path: 'D:\\models\\loaded-model.gguf',
              provider: 'llama-cpp',
              loaded: true,
            },
          ],
          runtime: {
            state: 'ready',
            model: 'D:\\models\\loaded-model.gguf',
            detail: 'The local model is loaded and ready.',
          },
        }),
      });
    });
    await page.goto(`${serverContext.baseUrl}/chat?private=viewport-test`);
    // Model and generation settings live in a popover off the composer.
    await page.locator('#modelMenuButton').click();
    await expect(page.locator('.model-popover')).toBeVisible();
    await expect(page.locator('.model-menu')).toHaveAttribute('data-popover-placement', 'down');
    await expect
      .poll(async () => {
        const [popover, trigger] = await Promise.all([
          page.locator('.model-popover').boundingBox(),
          page.locator('#modelMenuButton').boundingBox(),
        ]);
        return Math.floor((popover?.y ?? 0) - ((trigger?.y ?? 0) + (trigger?.height ?? 0)));
      })
      .toBeGreaterThanOrEqual(6);
    await expect
      .poll(async () => {
        const popover = await page.locator('.model-popover').boundingBox();
        return Math.floor(560 - ((popover?.y ?? 0) + (popover?.height ?? Number.MAX_SAFE_INTEGER)));
      })
      .toBeGreaterThanOrEqual(10);
    await expect(page.getByLabel('Generation model')).toHaveValue('Loaded model');
    await expect(page.locator('.model-runtime')).toContainText('Loaded');
    await page.getByLabel('Context window in tokens').click();
    const contextInputBox = await page.getByLabel('Context window in tokens').boundingBox();
    expect(contextInputBox?.width ?? 0).toBeGreaterThanOrEqual(120);
    await expect(page.locator('.number-combobox-popover')).toBeVisible();
    const presetOverflow = await page.locator('.number-combobox-popover').evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(presetOverflow.scrollWidth).toBeLessThanOrEqual(presetOverflow.clientWidth);
    await page.getByLabel('Context window in tokens').press('Escape');
    const bottomScroll = await page.locator('.model-popover').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return {
        scrollTop: element.scrollTop,
        bottom: element.scrollHeight - element.scrollTop - element.clientHeight,
      };
    });
    expect(bottomScroll.scrollTop).toBeGreaterThan(0);
    expect(bottomScroll.bottom).toBeLessThanOrEqual(1);
    // The diagnostic executable path does not clutter the composer.
    await expect(page.locator('.copyable-runtime-detail')).toHaveCount(0);
    await expect(page.getByText('Loopback-only llama-server')).toBeVisible();

    await page.locator('#modelMenuButton').click();
    await page.locator('#masterPromptButton').click();
    await expect(page.locator('.master-prompt-popover')).toBeVisible();
    await expect(page.locator('.master-prompt')).toHaveAttribute('data-popover-placement', 'down');
    const masterPromptBox = await page.locator('.master-prompt-popover').boundingBox();
    expect(masterPromptBox?.x ?? 0).toBeGreaterThanOrEqual(12);
    expect(
      940 - ((masterPromptBox?.x ?? 0) + (masterPromptBox?.width ?? 940)),
    ).toBeGreaterThanOrEqual(12);
    expect(
      560 - ((masterPromptBox?.y ?? 0) + (masterPromptBox?.height ?? 560)),
    ).toBeGreaterThanOrEqual(10);
  });

  test('changes llama.cpp context in chat and revalidates the answer budget', async ({
    appPage,
    serverContext,
  }) => {
    let contextSize = 8192;
    let sentMaxTokens;
    const configResponse = () => ({
      config: {
        llamaCpp: {
          modelDirectories: [],
          defaultModelDirectories: [],
          contextSize,
          acceleration: 'auto',
          gpuLayers: 20,
          splitMode: 'layer',
          mainGpu: 0,
          threads: -1,
          flashAttention: 'auto',
        },
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
    await appPage.route('**/api/generation/config', async (route) => {
      if (route.request().method() === 'PUT') {
        contextSize = route.request().postDataJSON().llamaCpp.contextSize;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(configResponse()),
      });
    });
    await appPage.route('**/api/generation/models?provider=llama-cpp*', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          provider: 'llama-cpp',
          models: [
            {
              id: 'D:\\models\\budget-test.gguf',
              name: 'Budget test',
              provider: 'llama-cpp',
              loaded: true,
            },
          ],
          runtime: {
            state: 'ready',
            model: 'D:\\models\\budget-test.gguf',
            contextSize,
            detail: 'Ready for budget test.',
          },
        }),
      });
    });
    await appPage.route('**/api/generation/chat/stream', async (route) => {
      sentMaxTokens = route.request().postDataJSON().maxTokens;
      await route.fulfill({
        contentType: 'application/x-ndjson',
        body: `${JSON.stringify({
          type: 'done',
          response: {
            provider: 'llama-cpp',
            model: 'budget-test.gguf',
            content: 'ok',
          },
        })}\n`,
      });
    });

    await appPage.goto(`${serverContext.baseUrl}/chat`);
    await appPage.locator('#sidebarNewChatButton').click();
    await expect(appPage.locator('#continuePrompt')).toHaveAttribute('maxlength', '100000');
    await appPage.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('threadshelf:generation-runtime-changed', {
          detail: {
            state: 'ready',
            model: 'D:\\models\\just-loaded.gguf',
            contextSize: 8192,
            detail: 'The model has just finished loading.',
          },
        }),
      );
    });
    await expect(appPage.locator('.sidebar .global-runtime')).toContainText('just-loaded.gguf');
    await appPage.locator('#modelMenuButton').click();
    await expect(appPage.getByLabel('Context window in tokens')).toHaveValue('8192');
    await appPage.getByLabel('Maximum response tokens').fill('9000');
    await expect(appPage.getByLabel('Maximum response tokens')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await appPage.getByLabel('Context window in tokens').fill('16384');
    await appPage.getByRole('button', { name: 'Apply' }).click();
    await expect(appPage.getByLabel('Maximum response tokens')).toHaveAttribute(
      'aria-invalid',
      'false',
    );
    await appPage.locator('#continuePrompt').fill('budget integration test');
    await appPage.locator('#continueSend').click();
    await expect.poll(() => sentMaxTokens).toBe(9000);
  });

  test('offers immutable thread continuation and marks OpenRouter as off-device', async ({
    appPage,
  }) => {
    await appPage.route('**/api/thread?*', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          sourceFile: 'fixture.json',
          conversationKey: 'fixture',
          createdInThreadShelf: false,
          turns: [
            { user: 'Archived question' },
            { ai: 'Archived response', model: 'archive-model' },
            {
              user: 'Question asked here',
              model: 'test/thread-model',
              createdInThreadShelf: true,
              generationProvider: 'openrouter',
            },
            {
              ai: 'Answer generated here',
              model: 'test/thread-model',
              createdInThreadShelf: true,
              generationProvider: 'openrouter',
            },
          ],
        }),
      });
    });
    await appPage.route('**/api/generation/runtime/logs', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          runtime: { state: 'ready', detail: 'ready' },
          source: 'managed',
          logs: 'load_tensors: offloaded 24/40 layers to GPU',
          logsTruncated: false,
          devices: [
            {
              id: 'CUDA0',
              name: 'Test GPU',
              totalBytes: 12 * 1024 ** 3,
              freeBytes: 10 * 1024 ** 3,
            },
          ],
          deviceDetectionSupported: true,
          offload: {
            mode: 'hybrid',
            gpuLayers: 24,
            totalLayers: 40,
            gpuPercent: 60,
            cpuPercent: 40,
          },
        }),
      });
    });
    await appPage.locator('#collection-pw_fixture').click();
    await expect(appPage.locator('.result').first()).toBeVisible({ timeout: 30_000 });
    await appPage.locator('.result').first().click();
    await expect(appPage.locator('#continuePrompt')).toBeVisible();
    await expect(appPage.locator('.threadshelf-turn-badge')).toHaveCount(2);
    await expect(appPage.getByText(/Asked in ThreadShelf/)).toHaveCount(0);
    const threadShelfFilter = appPage.getByLabel('Continuations', { exact: true });
    await expect(threadShelfFilter).toBeChecked();
    await appPage.locator('.role-toggle[data-role="threadshelf"]').click();
    await expect(appPage.getByText('Question asked here')).toBeHidden();
    await expect(appPage.getByText('Archived question')).toBeVisible();
    // GPU placement and process logs live in the composer model popover.
    await appPage.locator('#modelMenuButton').click();
    await expect(appPage.locator('.model-popover')).toBeVisible();
    await expect(appPage.getByText('GPU 60% · CPU 40%')).toBeVisible();
    await appPage.getByText('llama.cpp process logs').click();
    await expect(appPage.getByText('load_tensors: offloaded 24/40 layers to GPU')).toBeVisible();
    await expect(
      appPage.getByText(/Prompts, answers, and model reasoning are not written/),
    ).toBeVisible();
    // Provider is now a tab inside the popover, not a global select.
    await appPage.getByRole('tab', { name: /OpenRouter/ }).click();
    // The per-send consent checkbox is gone; the off-device chip and the
    // composer hint carry that signal instead.
    await expect(appPage.getByText(/Send this thread and prompt to OpenRouter/)).toHaveCount(0);
    await expect(appPage.locator('.off-device-chip')).toHaveText('off-device');
    await expect(appPage.getByText('Sent off-device via OpenRouter')).toBeVisible();
    await expect(appPage.getByLabel(/ZDR-only routing/)).not.toBeChecked();
    await expect(appPage.locator('#continueSend')).toBeDisabled();
  });

  test('shows model runtime, progress, and a streamed continuation', async ({ appPage }) => {
    await appPage.route('**/api/generation/models?provider=openrouter*', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          provider: 'openrouter',
          models: [
            {
              id: 'test/stream-model',
              name: 'Stream Model',
              provider: 'openrouter',
              contextLength: 32768,
            },
          ],
          runtime: {
            state: 'remote',
            detail: 'Models run remotely through OpenRouter and are not loaded by ThreadShelf.',
          },
        }),
      });
    });
    let releaseResponse;
    const responseGate = new Promise((resolve) => {
      releaseResponse = resolve;
    });
    let sentMaxTokens;
    await appPage.route('**/api/generation/chat/stream', async (route) => {
      sentMaxTokens = route.request().postDataJSON().maxTokens;
      await responseGate;
      await route.fulfill({
        contentType: 'application/x-ndjson',
        body: [
          JSON.stringify({
            type: 'status',
            phase: 'connecting',
            message: 'Connecting to OpenRouter and waiting for the first token…',
            model: 'test/stream-model',
          }),
          JSON.stringify({ type: 'delta', content: 'Visible streamed answer' }),
          JSON.stringify({
            type: 'done',
            response: {
              provider: 'openrouter',
              model: 'test/stream-model',
              content: 'Visible streamed answer',
              usage: { promptTokens: 8, completionTokens: 12, totalTokens: 20 },
              performance: {
                completionTokensPerSecond: 31.75,
                source: 'provider',
              },
            },
          }),
          '',
        ].join('\n'),
      });
    });

    await appPage.locator('#collection-pw_fixture').click();
    await expect(appPage.locator('.result').first()).toBeVisible({ timeout: 30_000 });
    await appPage.locator('.result').first().click();
    // Model and generation settings are in the composer popover.
    await appPage.locator('#modelMenuButton').click();
    await expect(appPage.locator('.model-popover')).toBeVisible();
    await appPage.getByRole('tab', { name: /OpenRouter/ }).click();
    await expect(appPage.locator('#modelMenuButton')).toContainText('Stream Model');
    await expect(appPage.getByText('1 live models available')).toBeVisible();
    await expect(appPage.getByText(/Context window 32,768 tokens/)).toBeVisible();
    await expect(appPage.getByLabel('Maximum response tokens')).toHaveValue('4096');
    // The token budget is a typeable dropdown: presets on click, free text too.
    await appPage.getByLabel('Maximum response tokens').click();
    await expect(appPage.locator('.number-combobox-popover')).toBeVisible();
    await appPage.getByRole('option', { name: '2,048 tokens' }).click();
    await expect(appPage.getByLabel('Maximum response tokens')).toHaveValue('2048');
    await appPage.getByLabel('Maximum response tokens').fill('1536');
    await appPage.getByLabel('Maximum response tokens').press('Escape');
    await expect(appPage.getByLabel('Sort OpenRouter models')).toHaveValue('most-popular');
    await expect(appPage.getByLabel('Free only')).toBeChecked();
    await appPage.getByLabel('Generation model').click();
    await expect(appPage.locator('.model-combobox-chevron')).toHaveText('⌄');
    const favorite = appPage.getByRole('button', { name: 'Add Stream Model to favorites' });
    await expect(favorite).toHaveText('☆');
    await favorite.click();
    await expect(
      appPage.getByRole('button', { name: 'Remove Stream Model from favorites' }),
    ).toHaveText('★');
    await appPage.getByLabel('Generation model').press('Escape');
    await appPage.locator('#continuePrompt').fill('Show progress');
    await appPage.locator('#continueSend').click();
    await expect.poll(() => sentMaxTokens).toBe(1536);
    await expect(appPage.getByRole('status')).toContainText('Preparing an OpenRouter request');
    await expect(appPage.getByRole('button', { name: 'Stop' })).toBeVisible();
    releaseResponse();
    await expect(appPage.getByText('Visible streamed answer')).toBeVisible();
    await expect(appPage.getByText('31.8 tok/s')).toBeVisible();
    await expect(appPage.getByText('prompt 8')).toBeVisible();
    await expect(appPage.getByText('answer 12')).toBeVisible();
    await expect(appPage.getByText(/context 20 \/ 32,768.*32,748 left/)).toBeVisible();
  });

  test('retains partial answer and reasoning when a generation stream fails', async ({
    appPage,
  }) => {
    await appPage.route('**/api/generation/models?provider=openrouter*', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          provider: 'openrouter',
          models: [{ id: 'test/failing-model', name: 'Failing Model', provider: 'openrouter' }],
          runtime: { state: 'remote', detail: 'Remote test model.' },
        }),
      });
    });
    await appPage.route('**/api/generation/chat/stream', async (route) => {
      await route.fulfill({
        contentType: 'application/x-ndjson',
        body: [
          JSON.stringify({ type: 'delta', reasoning: 'Private partial reasoning' }),
          JSON.stringify({ type: 'delta', content: 'Partial answer before crash' }),
          JSON.stringify({ type: 'error', error: 'Model process exited unexpectedly' }),
          '',
        ].join('\n'),
      });
    });

    await appPage.locator('#collection-pw_fixture').click();
    await expect(appPage.locator('.result').first()).toBeVisible({ timeout: 30_000 });
    await appPage.locator('.result').first().click();
    await appPage.locator('#modelMenuButton').click();
    await appPage.getByRole('tab', { name: /OpenRouter/ }).click();
    await appPage.locator('#continuePrompt').fill('Keep this attempt');
    await appPage.locator('#continueSend').click();

    const failed = appPage.locator('.interrupted-generation');
    await expect(failed).toContainText('Failed generation');
    await expect(failed).toContainText('not saved');
    await expect(failed).toContainText('Keep this attempt');
    await expect(failed).toContainText('Private partial reasoning');
    await expect(failed).toContainText('Partial answer before crash');
    await expect(failed).toContainText('Model process exited unexpectedly');
    await expect(failed.getByRole('button', { name: 'Copy attempt' })).toBeVisible();
    await failed.getByRole('button', { name: 'Retry prompt' }).click();
    await expect(appPage.locator('#continuePrompt')).toHaveValue('Keep this attempt');
  });
});
