import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { abortOnDisconnect } from '../src/routes/stream-abort.js';
import { buildQuickSetupPlan, quickSetupFingerprint } from '../src/generation/quick-setup.js';
import { modelFilesPresent, planModelDownload } from '../src/generation/model-download.js';
import { clearCatalogCacheForTests } from '../src/generation/model-catalog.js';

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const RELEASE = {
  tag_name: 'b9999',
  html_url: 'https://github.com/ggml-org/llama.cpp/releases/tag/b9999',
  assets: [
    {
      name: 'llama-b9999-bin-win-cpu-x64.zip',
      browser_download_url: 'https://example.test/win-cpu.zip',
      digest: `sha256:${'a'.repeat(64)}`,
      size: 140_000_000,
    },
    {
      name: 'llama-b9999-bin-ubuntu-x64.tar.gz',
      browser_download_url: 'https://example.test/linux-cpu.tar.gz',
      digest: `sha256:${'b'.repeat(64)}`,
      size: 140_000_000,
    },
    {
      name: 'llama-b9999-bin-macos-arm64.tar.gz',
      browser_download_url: 'https://example.test/mac.tar.gz',
      digest: `sha256:${'c'.repeat(64)}`,
      size: 140_000_000,
    },
  ],
};

const MODEL_FILE = 'Tiny-Q4_K_M.gguf';
const MODEL_BYTES = 2048;

const catalogFetch = (digest = 'd'.repeat(64), bytes = MODEL_BYTES) => async (url) => {
  const href = String(url);
  if (href.includes('/releases/')) return jsonResponse(RELEASE);
  if (href.includes('/tree/main')) {
    return jsonResponse([
      {
        type: 'file',
        path: MODEL_FILE,
        size: bytes,
        lfs: { oid: digest, size: bytes },
      },
    ]);
  }
  if (href.includes('/api/models?')) {
    return jsonResponse([
      { id: 'unsloth/Tiny-GGUF', downloads: 10, likes: 1, gated: false },
    ]);
  }
  return jsonResponse({ id: 'unsloth/Tiny-GGUF', downloads: 10, gated: false });
};

let root;
const originalEnv = {};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'threadshelf-quicksetup-'));
  for (const key of ['THREADSHELF_MODELS_PATH', 'THREADSHELF_TOOLS_PATH', 'GENERATION_CONFIG_PATH']) {
    originalEnv[key] = process.env[key];
  }
  process.env.THREADSHELF_MODELS_PATH = join(root, 'models');
  process.env.THREADSHELF_TOOLS_PATH = join(root, 'tools');
  process.env.GENERATION_CONFIG_PATH = join(root, 'generation.json');
  clearCatalogCacheForTests();
});

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

describe('streamed-work cancellation', () => {
  it('aborts when the client stops reading the response, not only on a dropped request', () => {
    // A browser cancelling a fetch closes the response; `req`'s `aborted` event
    // never fires. Listening only to the latter left downloads running after the
    // user pressed Cancel.
    const req = new EventEmitter();
    const res = Object.assign(new EventEmitter(), { writableEnded: false });
    const controller = abortOnDisconnect(req, res, 'Download cancelled');

    assert.strictEqual(controller.signal.aborted, false);
    res.emit('close');
    assert.strictEqual(controller.signal.aborted, true);
    assert.strictEqual(controller.signal.reason.name, 'AbortError');
    assert.match(String(controller.signal.reason.message), /Download cancelled/);
  });

  it('still aborts on a dropped request', () => {
    const req = new EventEmitter();
    const res = Object.assign(new EventEmitter(), { writableEnded: false });
    const controller = abortOnDisconnect(req, res);
    req.emit('aborted');
    assert.strictEqual(controller.signal.aborted, true);
  });

  it('does not abort when the response finished normally', () => {
    const req = new EventEmitter();
    const res = Object.assign(new EventEmitter(), { writableEnded: true });
    const controller = abortOnDisconnect(req, res);
    res.emit('close');
    assert.strictEqual(controller.signal.aborted, false);
  });
});

describe('quick setup plan integrity', () => {
  it('fingerprints what will be fetched and ignores drifting hardware readings', async () => {
    const plan = await buildQuickSetupPlan({ variant: 'cpu', fetchImpl: catalogFetch() });
    assert.ok(plan.fingerprint.length > 0);
    assert.strictEqual(quickSetupFingerprint(plan), plan.fingerprint);

    // Free VRAM changes constantly; it must not invalidate a plan mid-read.
    const drifted = {
      ...plan,
      hardware: { ...plan.hardware, freeRamBytes: plan.hardware.freeRamBytes - 1024 },
      warnings: [...plan.warnings, 'unrelated notice'],
    };
    assert.strictEqual(quickSetupFingerprint(drifted), plan.fingerprint);
  });

  it('changes the fingerprint when the upstream artifacts change', async () => {
    const plan = await buildQuickSetupPlan({ variant: 'cpu', fetchImpl: catalogFetch() });
    // The catalog caches Hub responses for a few minutes, which is what keeps an
    // approved plan stable while the user reads it. Drop it to simulate the
    // upstream files actually moving.
    clearCatalogCacheForTests();
    const moved = await buildQuickSetupPlan({
      variant: 'cpu',
      // Same repo and quant, different published digest and size.
      fetchImpl: catalogFetch('e'.repeat(64), MODEL_BYTES * 2),
    });
    assert.notStrictEqual(moved.fingerprint, plan.fingerprint);
  });

  it('pins the release tag so an approved plan re-resolves to the same build', async () => {
    const requested = [];
    const fetchImpl = async (url) => {
      requested.push(String(url));
      return catalogFetch()(url);
    };
    await buildQuickSetupPlan({ variant: 'cpu', releaseTag: 'b9999', fetchImpl });
    assert.ok(requested.some((url) => url.includes('/releases/tags/b9999')));
    assert.ok(!requested.some((url) => url.endsWith('/releases/latest')));
  });
});

describe('quick setup reuse detection', () => {
  it('marks an already-downloaded model as reuse and drops it from the transfer total', async () => {
    const fetchImpl = catalogFetch();
    const fresh = await buildQuickSetupPlan({ variant: 'cpu', fetchImpl });
    assert.strictEqual(fresh.model.action, 'download');
    assert.ok(fresh.totalDownloadBytes >= MODEL_BYTES);

    // Put the exact file the plan would fetch on disk.
    const downloadPlan = await planModelDownload({
      repoId: 'unsloth/Tiny-GGUF',
      quant: 'Q4_K_M',
      fetchImpl,
    });
    await mkdir(downloadPlan.directory, { recursive: true });
    await writeFile(downloadPlan.files[0].destination, Buffer.alloc(MODEL_BYTES));
    assert.strictEqual(await modelFilesPresent(downloadPlan), true);

    const reused = await buildQuickSetupPlan({ variant: 'cpu', fetchImpl });
    assert.strictEqual(reused.model.action, 'reuse');
    // The button must not advertise a transfer that will be skipped.
    assert.strictEqual(
      reused.totalDownloadBytes,
      fresh.totalDownloadBytes - fresh.model.totalBytes,
    );
    // A different action is a different plan, so the fingerprint must move too.
    assert.notStrictEqual(reused.fingerprint, fresh.fingerprint);
  });

  it('treats a truncated file as missing rather than reusable', async () => {
    const fetchImpl = catalogFetch();
    const downloadPlan = await planModelDownload({
      repoId: 'unsloth/Tiny-GGUF',
      quant: 'Q4_K_M',
      fetchImpl,
    });
    await mkdir(downloadPlan.directory, { recursive: true });
    await writeFile(downloadPlan.files[0].destination, Buffer.alloc(MODEL_BYTES - 1));
    assert.strictEqual(await modelFilesPresent(downloadPlan), false);
  });
});
