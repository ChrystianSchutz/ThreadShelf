import { appendFile, mkdir, readFile, stat, writeFile } from 'fs/promises';
import { basename, dirname, resolve } from 'path';
import { dataPath } from '../paths.js';
import { getGenerationConfig } from './config.js';
import type { ChatRequest } from './types.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const KEEP_LOG_BYTES = 4 * 1024 * 1024;
let pendingWrite: Promise<void> = Promise.resolve();

export const generationErrorLogPath = (): string =>
  resolve(
    process.env.GENERATION_ERROR_LOG_PATH || dataPath('generationErrorLog'),
  );

const appendError = async (request: ChatRequest, error: unknown): Promise<void> => {
  if (request.persistDiagnostics === false) return;
  const config = await getGenerationConfig();
  if (!config.diagnostics.persistErrorLogs) return;
  const path = generationErrorLogPath();
  const message = error instanceof Error ? error.message : String(error);
  const entry = [
    `[${new Date().toISOString()}] provider=${request.provider} model=${basename(request.model)}`,
    message,
    '',
  ].join('\n');
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, entry, { encoding: 'utf8', mode: 0o600 });
  const size = await stat(path).then((value) => value.size);
  if (size <= MAX_LOG_BYTES) return;
  const content = await readFile(path);
  const tail = content.subarray(-KEEP_LOG_BYTES);
  await writeFile(path, tail[0] === 0x0a ? tail.subarray(1) : tail, { mode: 0o600 });
};

export const persistGenerationError = (request: ChatRequest, error: unknown): Promise<void> => {
  pendingWrite = pendingWrite.then(
    () => appendError(request, error),
    () => appendError(request, error),
  );
  return pendingWrite;
};
