import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { downloadToFile, DownloadHashMismatchError } from '../src/generation/downloader.js';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const bodyResponse = (buffer, { status = 200, headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers({ 'content-length': String(buffer.length), ...headers }),
  body: Readable.toWeb(Readable.from([buffer])),
});

const withTempDir = async (run) => {
  const dir = await mkdtemp(join(tmpdir(), 'threadshelf-download-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe('shared downloader', () => {
  it('writes the file and returns the digest computed during the transfer', async () => {
    await withTempDir(async (dir) => {
      const payload = Buffer.from('llama archive contents');
      const destination = join(dir, 'archive.zip');
      const result = await downloadToFile('https://example.test/a.zip', destination, {
        sha256: sha256(payload),
        fetchImpl: async () => bodyResponse(payload),
      });

      assert.strictEqual(result.sha256, sha256(payload));
      assert.strictEqual(result.bytes, payload.length);
      assert.strictEqual(result.attempts, 1);
      assert.deepStrictEqual(await readFile(destination), payload);
    });
  });

  it('resumes from a partial file with a Range request and still hashes the whole result', async () => {
    await withTempDir(async (dir) => {
      const payload = Buffer.from('0123456789abcdefghij');
      const destination = join(dir, 'resumable.bin');
      // Simulate a transfer that already wrote the first eight bytes.
      await writeFile(`${destination}.part`, payload.subarray(0, 8));

      const seen = [];
      const result = await downloadToFile('https://example.test/r.bin', destination, {
        sha256: sha256(payload),
        fetchImpl: async (_url, init) => {
          seen.push(init.headers.Range);
          return bodyResponse(payload.subarray(8), {
            status: 206,
            headers: { 'content-range': `bytes 8-${payload.length - 1}/${payload.length}` },
          });
        },
      });

      assert.deepStrictEqual(seen, ['bytes=8-']);
      assert.strictEqual(result.resumedBytes, 8);
      assert.strictEqual(result.sha256, sha256(payload));
      assert.deepStrictEqual(await readFile(destination), payload);
    });
  });

  it('restarts cleanly when the server ignores the Range header', async () => {
    await withTempDir(async (dir) => {
      const payload = Buffer.from('complete payload');
      const destination = join(dir, 'ignored-range.bin');
      await writeFile(`${destination}.part`, Buffer.from('stale'));

      const result = await downloadToFile('https://example.test/x.bin', destination, {
        sha256: sha256(payload),
        // 200 means the whole body: appending it to the stale part would corrupt.
        fetchImpl: async () => bodyResponse(payload),
      });

      assert.strictEqual(result.resumedBytes, 0);
      assert.deepStrictEqual(await readFile(destination), payload);
    });
  });

  it('retries a transient failure and keeps the partial file for the next attempt', async () => {
    await withTempDir(async (dir) => {
      const payload = Buffer.from('retry me please');
      const destination = join(dir, 'retried.bin');
      let calls = 0;

      const result = await downloadToFile('https://example.test/retry.bin', destination, {
        sha256: sha256(payload),
        attempts: 3,
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) {
            return { ok: false, status: 503, headers: new Headers(), body: null };
          }
          return bodyResponse(payload);
        },
      });

      assert.strictEqual(calls, 2);
      assert.strictEqual(result.attempts, 2);
      assert.deepStrictEqual(await readFile(destination), payload);
    });
  });

  it('does not retry a client error', async () => {
    await withTempDir(async (dir) => {
      let calls = 0;
      await assert.rejects(
        () =>
          downloadToFile('https://example.test/missing.bin', join(dir, 'missing.bin'), {
            attempts: 4,
            fetchImpl: async () => {
              calls += 1;
              return { ok: false, status: 404, headers: new Headers(), body: null };
            },
          }),
        /404/,
      );
      assert.strictEqual(calls, 1);
    });
  });

  it('discards the partial file on a digest mismatch instead of poisoning a resume', async () => {
    await withTempDir(async (dir) => {
      const destination = join(dir, 'tampered.bin');
      await assert.rejects(
        () =>
          downloadToFile('https://example.test/t.bin', destination, {
            sha256: 'f'.repeat(64),
            attempts: 3,
            fetchImpl: async () => bodyResponse(Buffer.from('unexpected bytes')),
          }),
        DownloadHashMismatchError,
      );
      await assert.rejects(() => stat(`${destination}.part`), /ENOENT/);
      await assert.rejects(() => stat(destination), /ENOENT/);
    });
  });

  it('rejects a size mismatch even when no digest is known', async () => {
    await withTempDir(async (dir) => {
      await assert.rejects(
        () =>
          downloadToFile('https://example.test/s.bin', join(dir, 's.bin'), {
            expectedBytes: 999,
            attempts: 1,
            fetchImpl: async () => bodyResponse(Buffer.from('short')),
          }),
        /Size mismatch/,
      );
    });
  });

  it('refuses a non-HTTP scheme', async () => {
    await withTempDir(async (dir) => {
      await assert.rejects(
        () => downloadToFile('file:///etc/passwd', join(dir, 'x')),
        /must use HTTPS or HTTP/,
      );
    });
  });

  it('propagates caller cancellation without retrying', async () => {
    await withTempDir(async (dir) => {
      const controller = new AbortController();
      let calls = 0;
      controller.abort(new Error('cancelled by user'));
      await assert.rejects(
        () =>
          downloadToFile('https://example.test/c.bin', join(dir, 'c.bin'), {
            attempts: 4,
            signal: controller.signal,
            fetchImpl: async () => {
              calls += 1;
              return bodyResponse(Buffer.from('never'));
            },
          }),
        /cancelled by user/,
      );
      assert.strictEqual(calls, 0);
    });
  });
});
