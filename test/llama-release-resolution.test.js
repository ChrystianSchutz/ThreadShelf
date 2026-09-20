import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  NIGHTLY_TAG_ASSET,
  readNightlyTagPointer,
  releaseHasLlamaBinaries,
  resolveLlamaRelease,
  selectReleaseAsset,
  toolkitRank,
} from '../src/generation/llama-install.js';

const binaryAsset = (name, digest = 'a'.repeat(64)) => ({
  name,
  browser_download_url: `https://example.test/${name}`,
  digest: `sha256:${digest}`,
});

/**
 * Upstream's `/releases/latest` points at a semver release that ships only a
 * pointer file; the binaries live in a `bNNNNN` pre-release. This shape is the
 * exact failure that silently broke installs, so it is pinned here.
 */
const stableWithoutBinaries = {
  tag_name: 'v0.2.0',
  html_url: 'https://github.com/ggml-org/llama.cpp/releases/tag/v0.2.0',
  assets: [
    {
      name: NIGHTLY_TAG_ASSET,
      browser_download_url: 'https://example.test/nightly-tag.txt',
      digest: null,
    },
  ],
};

const nightly = (tag = 'b10566') => ({
  tag_name: tag,
  html_url: `https://github.com/ggml-org/llama.cpp/releases/tag/${tag}`,
  assets: [
    binaryAsset(`llama-${tag}-bin-win-cpu-x64.zip`),
    binaryAsset(`llama-${tag}-bin-win-cuda-12.4-x64.zip`, 'b'.repeat(64)),
    binaryAsset(`llama-${tag}-bin-win-cuda-13.3-x64.zip`, 'c'.repeat(64)),
    binaryAsset(`cudart-llama-bin-win-cuda-13.3-x64.zip`, 'd'.repeat(64)),
    binaryAsset(`llama-${tag}-bin-ubuntu-x64.tar.gz`, 'e'.repeat(64)),
    binaryAsset(`llama-${tag}-bin-ubuntu-vulkan-x64.tar.gz`, 'f'.repeat(64)),
  ],
});

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const textResponse = (body) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  text: async () => body,
});

describe('llama.cpp release resolution', () => {
  it('detects that a release carries no installable binaries', () => {
    assert.strictEqual(releaseHasLlamaBinaries(stableWithoutBinaries), false);
    assert.strictEqual(releaseHasLlamaBinaries(nightly()), true);
  });

  it('follows the nightly-tag pointer when the latest release has no binaries', async () => {
    const requested = [];
    const fetchImpl = async (url) => {
      const href = String(url);
      requested.push(href);
      if (href.endsWith('/releases/latest')) return jsonResponse(stableWithoutBinaries);
      if (href.endsWith('nightly-tag.txt')) return textResponse('b10566\n');
      if (href.endsWith('/releases/tags/b10566')) return jsonResponse(nightly());
      throw new Error(`Unexpected request: ${href}`);
    };

    const release = await resolveLlamaRelease({ fetchImpl });
    assert.strictEqual(release.tag_name, 'b10566');
    assert.ok(requested.some((url) => url.includes('nightly-tag.txt')));
  });

  it('falls back to scanning recent releases when no pointer exists', async () => {
    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.endsWith('/releases/latest')) {
        return jsonResponse({ ...stableWithoutBinaries, assets: [] });
      }
      if (href.includes('/releases?per_page=')) {
        return jsonResponse([{ tag_name: 'v0.2.0', html_url: 'x', assets: [] }, nightly('b10577')]);
      }
      throw new Error(`Unexpected request: ${href}`);
    };

    const release = await resolveLlamaRelease({ fetchImpl });
    assert.strictEqual(release.tag_name, 'b10577');
  });

  it('pins an exact build and rejects one without binaries', async () => {
    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.endsWith('/releases/tags/b10577')) return jsonResponse(nightly('b10577'));
      if (href.endsWith('/releases/tags/v0.2.0')) return jsonResponse(stableWithoutBinaries);
      throw new Error(`Unexpected request: ${href}`);
    };

    assert.strictEqual((await resolveLlamaRelease({ tag: 'b10577', fetchImpl })).tag_name, 'b10577');
    await assert.rejects(
      () => resolveLlamaRelease({ tag: 'v0.2.0', fetchImpl }),
      /carries no llama\.cpp binaries/,
    );
    await assert.rejects(
      () => resolveLlamaRelease({ tag: '../../etc/passwd', fetchImpl }),
      /Invalid llama\.cpp release tag/,
    );
  });

  it('reports an actionable error when nothing installable is found', async () => {
    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.endsWith('/releases/latest')) {
        return jsonResponse({ ...stableWithoutBinaries, assets: [] });
      }
      if (href.includes('/releases?per_page=')) return jsonResponse([]);
      throw new Error(`Unexpected request: ${href}`);
    };
    await assert.rejects(() => resolveLlamaRelease({ fetchImpl }), /No llama\.cpp release/);
  });

  it('ignores a malformed nightly pointer', async () => {
    const release = await readNightlyTagPointer(stableWithoutBinaries, async () =>
      textResponse('not-a-build'),
    );
    assert.strictEqual(release, null);
  });

  it('prefers the newest accelerator toolkit rather than the alphabetical first', () => {
    assert.ok(toolkitRank('llama-b1-bin-win-cuda-13.3-x64.zip') > toolkitRank('llama-b1-bin-win-cuda-12.4-x64.zip'));
    assert.strictEqual(
      selectReleaseAsset(nightly(), { platform: 'win32', arch: 'x64', variant: 'cuda' }).name,
      'llama-b10566-bin-win-cuda-13.3-x64.zip',
    );
  });

  it('never offers an accelerator build for a CPU request on Linux', () => {
    const withCuda = {
      ...nightly(),
      assets: [
        ...nightly().assets,
        {
          name: 'llama-b10566-bin-ubuntu-cuda-13.3-x64.tar.gz',
          browser_download_url: 'https://example.test/ubuntu-cuda.tar.gz',
          digest: `sha256:${'9'.repeat(64)}`,
        },
      ],
    };
    assert.strictEqual(
      selectReleaseAsset(withCuda, { platform: 'linux', arch: 'x64', variant: 'cpu' }).name,
      'llama-b10566-bin-ubuntu-x64.tar.gz',
    );
  });
});
