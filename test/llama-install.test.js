import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  customInstallSource,
  assertSafeArchiveEntries,
  inspectLlamaArchive,
  installLlamaCpp,
  llamaExecutableCandidates,
  findLlamaExecutables,
  selectReleaseAsset,
  sha256File,
  sourceFromRelease,
  runCommandCapture,
} from '../src/generation/llama-install.js';
import { parseArguments } from '../scripts/setup-llama-cpp.js';

const release = {
  tag_name: 'b9999',
  html_url: 'https://github.com/ggml-org/llama.cpp/releases/tag/b9999',
  assets: [
    {
      name: 'llama-b9999-bin-win-cpu-x64.zip',
      browser_download_url: 'https://example.test/win.zip',
      digest: `sha256:${'a'.repeat(64)}`,
    },
    {
      name: 'llama-b9999-bin-win-vulkan-x64.zip',
      browser_download_url: 'https://example.test/vulkan.zip',
      digest: `sha256:${'b'.repeat(64)}`,
    },
    {
      name: 'llama-b9999-bin-win-cuda-12.4-x64.zip',
      browser_download_url: 'https://example.test/cuda.zip',
      digest: `sha256:${'f'.repeat(64)}`,
    },
    {
      name: 'cudart-llama-bin-win-cuda-12.4-x64.zip',
      browser_download_url: 'https://example.test/cudart.zip',
      digest: `sha256:${'9'.repeat(64)}`,
    },
    {
      name: 'llama-b9999-bin-macos-arm64.tar.gz',
      browser_download_url: 'https://example.test/mac.tar.gz',
      digest: `sha256:${'c'.repeat(64)}`,
    },
    {
      name: 'llama-b9999-bin-ubuntu-x64.tar.gz',
      browser_download_url: 'https://example.test/linux.tar.gz',
      digest: `sha256:${'d'.repeat(64)}`,
    },
    {
      name: 'llama-b9999-bin-ubuntu-rocm-7.2-x64.tar.gz',
      browser_download_url: 'https://example.test/rocm.tar.gz',
      digest: `sha256:${'e'.repeat(64)}`,
    },
  ],
};

describe('llama.cpp installer selection', () => {
  it('selects portable CPU assets for Windows, macOS, and Linux', () => {
    assert.strictEqual(
      selectReleaseAsset(release, { platform: 'win32', arch: 'x64' }).name,
      'llama-b9999-bin-win-cpu-x64.zip',
    );
    assert.strictEqual(
      selectReleaseAsset(release, { platform: 'darwin', arch: 'arm64' }).name,
      'llama-b9999-bin-macos-arm64.tar.gz',
    );
    assert.strictEqual(
      selectReleaseAsset(release, { platform: 'linux', arch: 'x64' }).name,
      'llama-b9999-bin-ubuntu-x64.tar.gz',
    );
  });

  it('selects explicit accelerators without mistaking cudart support assets for llama-server', () => {
    assert.strictEqual(
      selectReleaseAsset(release, { platform: 'win32', arch: 'x64', variant: 'vulkan' }).name,
      'llama-b9999-bin-win-vulkan-x64.zip',
    );
    assert.strictEqual(
      selectReleaseAsset(release, { platform: 'linux', arch: 'x64', variant: 'rocm' }).name,
      'llama-b9999-bin-ubuntu-rocm-7.2-x64.tar.gz',
    );
    assert.throws(
      () => selectReleaseAsset(release, { platform: 'darwin', arch: 'arm64', variant: 'vulkan' }),
      /Metal automatically/,
    );
  });

  it('requires official release assets to have a published SHA-256', () => {
    const source = sourceFromRelease(release, { platform: 'win32', arch: 'x64' });
    assert.strictEqual(source.sha256, 'a'.repeat(64));
    assert.strictEqual(source.tag, 'b9999');
    assert.strictEqual(source.flavor, 'cpu');
    assert.strictEqual(
      sourceFromRelease(release, { platform: 'win32', arch: 'x64', variant: 'vulkan' }).flavor,
      'vulkan',
    );
    const cuda = sourceFromRelease(release, {
      platform: 'win32',
      arch: 'x64',
      variant: 'cuda',
    });
    assert.strictEqual(cuda.companions?.[0].filename, 'cudart-llama-bin-win-cuda-12.4-x64.zip');
    assert.strictEqual(cuda.companions?.[0].sha256, '9'.repeat(64));
    assert.throws(
      () =>
        sourceFromRelease(
          { ...release, assets: [{ ...release.assets[0], digest: null }] },
          { platform: 'win32', arch: 'x64' },
        ),
      /no usable SHA-256/,
    );
  });

  it('validates custom archive URLs and optional digests', () => {
    assert.deepStrictEqual(customInstallSource('https://example.test/custom.tar.gz'), {
      url: 'https://example.test/custom.tar.gz',
      filename: 'custom.tar.gz',
      sha256: undefined,
      tag: 'custom',
    });
    assert.throws(() => customInstallSource('file:///tmp/llama.zip'), /HTTPS or HTTP/);
    assert.throws(() => customInstallSource('https://example.test/server.exe'), /archive/);
    assert.throws(
      () => customInstallSource('https://example.test/server.zip', { sha256: 'bad' }),
      /Invalid SHA-256/,
    );
  });

  it('rejects archive traversal and absolute entries before extraction', () => {
    assert.doesNotThrow(() => assertSafeArchiveEntries(['llama/bin/llama-server', 'LICENSE']));
    assert.throws(() => assertSafeArchiveEntries(['../outside']), /Unsafe archive entry/);
    assert.throws(() => assertSafeArchiveEntries(['/absolute/server']), /Unsafe archive entry/);
    assert.throws(
      () => assertSafeArchiveEntries(['C:\\outside\\server.exe']),
      /Unsafe archive entry/,
    );
    assert.throws(() => assertSafeArchiveEntries([]), /empty/);
  });

  it('does not treat discovery arguments as installation consent', () => {
    assert.deepStrictEqual(parseArguments([]), {
      install: false,
      yes: false,
      check: false,
      url: undefined,
      sha256: undefined,
      tag: undefined,
      destination: undefined,
      release: undefined,
      variant: 'cpu',
    });
    assert.strictEqual(parseArguments(['--install']).install, true);
    assert.strictEqual(
      parseArguments(['--url', 'https://example.test/a.zip']).url.includes('a.zip'),
      true,
    );
    assert.throws(() => parseArguments(['--url']), /Missing value/);
    assert.strictEqual(parseArguments(['--release', 'b10577']).release, 'b10577');
    assert.throws(() => parseArguments(['--variant', '--yes']), /Missing value/);
  });

  it('builds deterministic PATH candidates without executing them', () => {
    const separator = process.platform === 'win32' ? ';' : ':';
    const executable = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    const candidates = llamaExecutableCandidates({
      platform: process.platform,
      installRoot: join(tmpdir(), 'safe-tools'),
      env: {
        PATH: [join(tmpdir(), 'one'), join(tmpdir(), 'two')].join(separator),
        LLAMA_CPP_SERVER: join(tmpdir(), 'custom', executable),
      },
    });
    assert.ok(candidates.some((path) => path.endsWith(join('custom', executable))));
    assert.ok(candidates.some((path) => path.endsWith(join('one', executable))));
  });

  it('prefers the newest managed release and an accelerator over CPU for the same release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-discovery-order-'));
    try {
      const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
      const cpu = join(root, 'llama.cpp', 'b100-cpu', name);
      const cuda = join(root, 'llama.cpp', 'b101-cuda', name);
      await mkdir(join(root, 'llama.cpp', 'b100-cpu'), { recursive: true });
      await mkdir(join(root, 'llama.cpp', 'b101-cuda'), { recursive: true });
      await writeFile(cpu, 'cpu');
      await writeFile(cuda, 'cuda');
      if (process.platform !== 'win32') {
        await chmod(cpu, 0o755);
        await chmod(cuda, 0o755);
      }
      const found = await findLlamaExecutables({ installRoot: root, env: { PATH: '' } });
      assert.strictEqual(found[0], cuda);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('computes SHA-256 without loading the archive into memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-hash-'));
    try {
      const path = join(root, 'asset.zip');
      await writeFile(path, 'abc');
      assert.strictEqual(
        await sha256File(path),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('waits for captured stdout to close before returning', async () => {
    const output = await runCommandCapture(process.execPath, [
      '-e',
      "process.stdout.write('x'.repeat(1024 * 1024))",
    ]);
    assert.strictEqual(output.length, 1024 * 1024);
  });

  it('keeps a cancelled runtime partial and resumes it with Range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'threadshelf-runtime-resume-'));
    const ranges = [];
    const totalBytes = 32 * 1024 * 1024;
    const server = createServer((req, res) => {
      ranges.push(req.headers.range);
      const start = Number(req.headers.range?.match(/^bytes=(\d+)-$/)?.[1] ?? 0);
      res.writeHead(start > 0 ? 206 : 200, {
        'content-length': String(totalBytes - start),
        ...(start > 0 ? { 'content-range': `bytes ${start}-${totalBytes - 1}/${totalBytes}` } : {}),
      });
      let sent = start;
      const timer = setInterval(() => {
        if (res.destroyed || sent >= totalBytes) {
          clearInterval(timer);
          if (!res.destroyed) res.end();
          return;
        }
        const size = Math.min(256 * 1024, totalBytes - sent);
        res.write(Buffer.alloc(size));
        sent += size;
      }, 5);
      res.once('close', () => clearInterval(timer));
    });

    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const source = {
        url: `http://127.0.0.1:${port}/runtime.zip`,
        filename: 'runtime.zip',
        tag: 'resume-test',
        flavor: 'cpu',
      };

      const cancelInstall = async () => {
        const controller = new AbortController();
        await assert.rejects(
          installLlamaCpp(source, {
            installRoot: root,
            signal: controller.signal,
            onProgress: (progress) => {
              if ((progress.downloadedBytes ?? 0) >= 1024 * 1024) {
                controller.abort(new DOMException('cancelled', 'AbortError'));
              }
            },
          }),
          (error) => error instanceof Error && error.name === 'AbortError',
        );
      };

      await cancelInstall();
      await cancelInstall();
      assert.strictEqual(ranges[0], undefined);
      assert.match(ranges[1] ?? '', /^bytes=[1-9]\d*-$/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });

  it(
    'inspects a real PowerShell-created ZIP on Windows',
    { skip: process.platform !== 'win32' },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'threadshelf-zip-'));
      try {
        const contents = join(root, 'contents');
        const archive = join(root, 'llama.zip');
        await mkdir(contents);
        await writeFile(join(contents, 'llama-server.exe'), 'synthetic executable');
        await runCommandCapture('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '& { param($contents, $archive) Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($contents, $archive) }',
          contents,
          archive,
        ]);
        await assert.doesNotReject(() => inspectLlamaArchive(archive));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
