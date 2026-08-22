import { Router } from 'express';
import multer from 'multer';
import { join, basename, dirname, normalize, resolve, relative, isAbsolute } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { copyFile, mkdir, rm } from 'fs/promises';
import { randomUUID } from 'crypto';
import { ingestFolder, listExportFiles } from '../ingest.js';
import { listSourceFilesInCollection } from '../store.js';
import {
  ValidationError,
  normalizeCollectionName,
  normalizeCollectionSelector,
  normalizeBoolean,
} from '../validation.js';

import { abortOnDisconnect, isAbortError } from './stream-abort.js';

const router = Router();

const UPLOADS_DIR = process.env.UPLOADS_DIR || join(process.cwd(), '.uploads');
const INCOMING_DIR = join(UPLOADS_DIR, '.incoming');
const MAX_UPLOAD_SIZE = 500 * 1024 * 1024; // 500 MB
const MAX_UPLOAD_FILES = 1000;

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      mkdirSync(INCOMING_DIR, { recursive: true });
      callback(null, INCOMING_DIR);
    },
    filename: (_req, _file, callback) => callback(null, randomUUID()),
  }),
  limits: {
    fileSize: MAX_UPLOAD_SIZE,
    files: MAX_UPLOAD_FILES,
    fields: 10,
    parts: MAX_UPLOAD_FILES + 10,
    fieldNameSize: 4096,
  },
});

const tryNormalizeCollectionName = (value: unknown): string => {
  try {
    return normalizeCollectionName(value);
  } catch {
    return '';
  }
};

const safeUploadRelativePath = (rawPath: string): string | null => {
  const normalized = normalize(String(rawPath || '').replace(/\\/g, '/'));
  if (!normalized || isAbsolute(normalized) || normalized.startsWith('..')) return null;
  return normalized;
};

const isInsideDirectory = (parentDir: string, childPath: string): boolean => {
  const parent = resolve(parentDir);
  const child = resolve(childPath);
  const rel = relative(parent, child);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};

const getUploadedFiles = (files: unknown): Express.Multer.File[] => {
  return Array.isArray(files) ? (files as Express.Multer.File[]) : [];
};

const cleanupUploadedTemps = async (files: readonly Express.Multer.File[]): Promise<void> => {
  await Promise.all(
    files.map((file) => (file.path ? rm(file.path, { force: true }) : Promise.resolve())),
  );
};

const getUploadTarget = (
  files: readonly Express.Multer.File[],
  requestedCollection: string,
): {
  collectionName: string;
  targetDir: string;
} => {
  const firstPath = (files[0]?.fieldname ?? '').replace(/\\/g, '/');
  const topDir = firstPath.split('/').filter(Boolean)[0];
  const collectionName =
    requestedCollection || tryNormalizeCollectionName(topDir || 'upload') || 'upload';

  return {
    collectionName,
    targetDir: join(UPLOADS_DIR, collectionName),
  };
};

const uploadRelativePath = (fieldname: string): { rel: string; relativePath: string | null } => {
  const rel = fieldname.replace(/\\/g, '/');
  const parts = rel.split('/').filter(Boolean);
  const pathInsideFolder = parts.length > 1 ? join(...parts.slice(1)) : parts[0];

  return {
    rel,
    relativePath: safeUploadRelativePath(pathInsideFolder ?? ''),
  };
};

const ensureUploadTarget = async (targetDir: string): Promise<void> => {
  if (!existsSync(UPLOADS_DIR)) await mkdir(UPLOADS_DIR, { recursive: true });
  if (!existsSync(targetDir)) await mkdir(targetDir, { recursive: true });
};

const persistUploadedFiles = async (
  files: readonly Express.Multer.File[],
  targetDir: string,
  onFile?: (processedFiles: number, relativePath: string) => void,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  await ensureUploadTarget(targetDir);

  for (const [index, file] of files.entries()) {
    const { rel, relativePath } = uploadRelativePath(file.fieldname);
    if (!relativePath) {
      return { ok: false, error: `Unsafe upload path: ${rel}` };
    }

    const outPath = join(targetDir, relativePath);
    if (!isInsideDirectory(targetDir, outPath)) {
      return { ok: false, error: `Upload path escapes target directory: ${rel}` };
    }

    const outDir = dirname(outPath);
    if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });
    await copyFile(file.path, outPath);
    onFile?.(index + 1, relativePath);
  }

  return { ok: true };
};

const writeEvent = (res: import('express').Response, payload: unknown): void => {
  if (res.destroyed || res.writableEnded) return;
  res.write(`${JSON.stringify(payload)}\n`);
};

const canonicalSourcePath = (filePath: string): string => {
  const canonical = resolve(filePath).replace(/\\/g, '/');
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
};

router.get('/api/ingest-preview', async (req, res) => {
  const folderPath = req.query.folderPath;
  let collection: string;
  try {
    collection = normalizeCollectionSelector(req.query.collection);
  } catch (e) {
    if (e instanceof ValidationError) {
      return res.status(400).json({ error: e.message, field: e.field });
    }
    throw e;
  }

  if (!folderPath || typeof folderPath !== 'string' || folderPath.trim().length === 0) {
    return res.status(400).json({ error: 'Missing folderPath' });
  }
  if ((folderPath as string).length > 4096) {
    return res.status(400).json({ error: 'folderPath too long' });
  }

  try {
    const files = await listExportFiles(folderPath as string);
    const existingFiles = collection === 'all' ? [] : await listSourceFilesInCollection(collection);
    const existingPaths = new Set(existingFiles.map(canonicalSourcePath));
    const duplicates = files
      .map((filePath) => ({
        sourceFile: filePath,
        name: basename(filePath),
        canonicalPath: canonicalSourcePath(filePath),
      }))
      .filter((file) => existingPaths.has(file.canonicalPath));

    res.json({ collection, files, duplicates });
  } catch (e) {
    console.error('[/api/ingest-preview]', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

router.post('/api/ingest-upload', upload.any(), async (req, res) => {
  const files = getUploadedFiles(req.files);
  let clearFirst: boolean;
  try {
    clearFirst = normalizeBoolean(req.body?.clearFirst, { field: 'clearFirst' });
  } catch (e) {
    await cleanupUploadedTemps(files);
    if (e instanceof ValidationError) {
      return res.status(400).json({ error: e.message, field: e.field });
    }
    throw e;
  }

  if (files.length === 0) {
    return res
      .status(400)
      .json({ error: 'No files uploaded. Choose a folder with JSON export files.' });
  }

  const requestedCollection = tryNormalizeCollectionName(req.body?.collectionName);
  const { collectionName, targetDir } = getUploadTarget(files, requestedCollection);

  try {
    const persisted = await persistUploadedFiles(files, targetDir);
    if (!persisted.ok) {
      return res.status(400).json({ status: 'error', error: persisted.error });
    }

    const result = await ingestFolder(collectionName, targetDir, { clearFirst });
    res.json({ status: 'completed', result, collectionName });
  } catch (e) {
    console.error('[/api/ingest-upload]', e);
    res.status(500).json({ status: 'error', error: (e as Error).message });
  } finally {
    await cleanupUploadedTemps(files);
  }
});

router.post('/api/ingest-upload-progress', upload.any(), async (req, res) => {
  const files = getUploadedFiles(req.files);
  let clearFirst: boolean;
  try {
    clearFirst = normalizeBoolean(req.body?.clearFirst, { field: 'clearFirst' });
  } catch (e) {
    await cleanupUploadedTemps(files);
    if (e instanceof ValidationError) {
      return res.status(400).json({ error: e.message, field: e.field });
    }
    throw e;
  }
  const requestedCollection = tryNormalizeCollectionName(req.body?.collectionName);

  if (!files.length) {
    return res.status(400).json({ status: 'error', error: 'No files uploaded' });
  }

  const { collectionName, targetDir } = getUploadTarget(files, requestedCollection);

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const controller = abortOnDisconnect(req, res, 'Indexing stopped');

  try {
    writeEvent(res, {
      status: 'starting',
      phase: 'uploading',
      totalFiles: files.length,
      processedFiles: 0,
      totalChunks: 0,
      totalTokens: 0,
      elapsedMs: 0,
    });

    const persisted = await persistUploadedFiles(
      files,
      targetDir,
      (processedFiles, relativePath) => {
        writeEvent(res, {
          status: 'progress',
          phase: 'uploading',
          totalFiles: files.length,
          processedFiles,
          currentFile: relativePath,
          totalChunks: 0,
          totalTokens: 0,
          elapsedMs: 0,
        });
      },
    );
    if (!persisted.ok) {
      writeEvent(res, { status: 'error', error: persisted.error });
      return;
    }

    const onProgress = (data: unknown) => writeEvent(res, data);
    const result = await ingestFolder(collectionName, targetDir, {
      clearFirst,
      onProgress,
      signal: controller.signal,
    });
    writeEvent(res, { status: 'completed', result, collectionName });
  } catch (e) {
    if (!isAbortError(e)) {
      console.error('[/api/ingest-upload-progress]', e);
      writeEvent(res, { status: 'error', error: (e as Error).message });
    }
  } finally {
    await cleanupUploadedTemps(files);
    res.end();
  }
});

router.post('/api/ingest-progress', async (req, res) => {
  const folderPath = req.body?.folderPath;
  let clearFirst: boolean;
  try {
    clearFirst = normalizeBoolean(req.body?.clearFirst, { field: 'clearFirst' });
  } catch (e) {
    if (e instanceof ValidationError) {
      return res.status(400).json({ error: e.message, field: e.field });
    }
    throw e;
  }

  if (!folderPath || typeof folderPath !== 'string') {
    return res.status(400).json({ error: 'Missing folderPath' });
  }
  if (folderPath.length > 4096 || folderPath.includes('\0')) {
    return res.status(400).json({ error: 'Invalid folderPath' });
  }

  const collectionName =
    tryNormalizeCollectionName(req.body?.collection) ||
    tryNormalizeCollectionName(basename(folderPath)) ||
    'chunks';

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const controller = abortOnDisconnect(req, res, 'Indexing stopped');

  const onProgress = (data: unknown) => {
    res.write(`${JSON.stringify(data)}\n`);
  };

  try {
    const result = await ingestFolder(collectionName, folderPath, {
      clearFirst,
      onProgress,
      signal: controller.signal,
    });
    res.write(`${JSON.stringify({ status: 'completed', result })}\n`);
  } catch (e) {
    if (!isAbortError(e)) {
      console.error('[/api/ingest-progress]', e);
      writeEvent(res, { status: 'error', error: (e as Error).message });
    }
  } finally {
    res.end();
  }
});

export default router;
