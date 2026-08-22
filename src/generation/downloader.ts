import { createHash, type Hash } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { rename, rm, stat } from 'fs/promises';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';

/**
 * One downloader for every large artifact ThreadShelf fetches: llama.cpp release
 * archives and GGUF model files. It streams to `<destination>.part`, hashes in
 * the same pass as the write, resumes with a Range request after a failure, and
 * only renames into place once the digest matches.
 */

export interface DownloadProgress {
  readonly downloadedBytes: number;
  readonly totalBytes?: number;
  readonly resumedBytes: number;
  readonly attempt: number;
}

export interface DownloadOptions {
  /** Expected lowercase hex SHA-256. A mismatch always fails without retrying. */
  readonly sha256?: string;
  readonly expectedBytes?: number;
  readonly onProgress?: (progress: DownloadProgress) => void;
  readonly signal?: AbortSignal;
  /** Total attempts including the first. */
  readonly attempts?: number;
  /** Abort an attempt after this long with no received bytes. */
  readonly stallTimeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
  readonly resume?: boolean;
}

export interface DownloadResult {
  readonly bytes: number;
  readonly sha256: string;
  readonly resumedBytes: number;
  readonly attempts: number;
}

export class DownloadHashMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
    readonly url: string,
  ) {
    super(`SHA-256 mismatch for ${url}: expected ${expected}, got ${actual}`);
    this.name = 'DownloadHashMismatchError';
  }
}

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_STALL_TIMEOUT_MS = 60_000;

const partPath = (destination: string): string => `${destination}.part`;

const fileSize = async (path: string): Promise<number> => {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
};

/** Re-reads an existing `.part` so a resumed transfer keeps a single-pass digest. */
const hashExistingBytes = async (path: string, hash: Hash): Promise<void> => {
  await pipeline(
    createReadStream(path),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        callback();
      },
    }),
  );
};

const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || status >= 500;

const isRetryableError = (error: unknown): boolean => {
  if (error instanceof DownloadHashMismatchError) return false;
  if (error instanceof HttpStatusError) return isRetryableStatus(error.status);
  // Network-level faults surface as TypeError from fetch or as errno codes from
  // the stream. Both are worth another attempt; a resumed range picks up where
  // the broken transfer stopped.
  return true;
};

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`Download failed (${status}) for ${url}`);
    this.name = 'HttpStatusError';
  }
}

const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** (attempt - 1), 8000);

const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolveDelay, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveDelay();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export const assertDownloadUrl = (url: string): URL => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Download URL must use HTTPS or HTTP');
  }
  return parsed;
};

export const downloadToFile = async (
  url: string,
  destination: string,
  {
    sha256,
    expectedBytes,
    onProgress,
    signal,
    attempts = DEFAULT_ATTEMPTS,
    stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
    headers = {},
    fetchImpl = fetch,
    resume = true,
  }: DownloadOptions = {},
): Promise<DownloadResult> => {
  const parsed = assertDownloadUrl(url);
  const target = partPath(destination);
  let lastError: unknown;

  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    signal?.throwIfAborted();
    const existing = resume ? await fileSize(target) : 0;
    if (!resume && existing > 0) await rm(target, { force: true });

    const stallController = new AbortController();
    const attemptSignal = signal
      ? AbortSignal.any([signal, stallController.signal])
      : stallController.signal;
    let stallTimer: NodeJS.Timeout | undefined;
    const armStallTimer = (): void => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => stallController.abort(new Error(`Download stalled for ${stallTimeoutMs}ms`)),
        stallTimeoutMs,
      );
      stallTimer.unref?.();
    };

    try {
      armStallTimer();
      const response = await fetchImpl(parsed, {
        redirect: 'follow',
        signal: attemptSignal,
        headers: {
          'User-Agent': 'ThreadShelf',
          ...headers,
          ...(existing > 0 ? { Range: `bytes=${existing}-` } : {}),
        },
      });
      if (!response.ok) throw new HttpStatusError(response.status, url);
      if (!response.body) throw new Error(`Download returned no body for ${url}`);

      // A server that ignores Range answers 200 with the whole file; appending
      // to the partial file would corrupt it, so start over in that case.
      const resumed = existing > 0 && response.status === 206;
      if (existing > 0 && !resumed) await rm(target, { force: true });
      const resumedBytes = resumed ? existing : 0;

      const declared = Number(response.headers.get('content-length'));
      const totalBytes = Number.isFinite(declared)
        ? declared + resumedBytes
        : (expectedBytes ?? undefined);

      const hash = createHash('sha256');
      if (resumedBytes > 0) await hashExistingBytes(target, hash);

      let downloadedBytes = resumedBytes;
      onProgress?.({ downloadedBytes, totalBytes, resumedBytes, attempt });

      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          downloadedBytes += chunk.length;
          armStallTimer();
          onProgress?.({ downloadedBytes, totalBytes, resumedBytes, attempt });
          callback(null, chunk);
        },
      });

      await pipeline(
        Readable.fromWeb(response.body as never),
        meter,
        createWriteStream(target, { flags: resumed ? 'a' : 'w', mode: 0o600 }),
        { signal: attemptSignal },
      );
      clearTimeout(stallTimer);

      const digest = hash.digest('hex');
      if (sha256 && digest !== sha256.toLowerCase()) {
        // Either the source changed or the bytes were tampered with. Keeping the
        // partial file would poison every later resume.
        await rm(target, { force: true });
        throw new DownloadHashMismatchError(sha256.toLowerCase(), digest, url);
      }
      if (expectedBytes !== undefined && downloadedBytes !== expectedBytes) {
        await rm(target, { force: true });
        throw new Error(
          `Size mismatch for ${url}: expected ${expectedBytes} bytes, got ${downloadedBytes}`,
        );
      }

      await rename(target, destination);
      return { bytes: downloadedBytes, sha256: digest, resumedBytes, attempts: attempt };
    } catch (error) {
      clearTimeout(stallTimer);
      // A caller-driven abort is a cancellation, never a fault to retry.
      if (signal?.aborted) throw signal.reason ?? error;
      lastError = error;
      if (attempt >= attempts || !isRetryableError(error)) break;
      await delay(backoffMs(attempt), signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Download failed for ${url}`);
};

export const sha256File = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  await hashExistingBytes(path, hash);
  return hash.digest('hex');
};
