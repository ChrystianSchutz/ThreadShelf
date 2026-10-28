import { readdir, realpath, stat } from 'fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path';
import { isProjectorFileName } from './model-discovery.js';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

const inside = (root: string, file: string): boolean => {
  const rel = relative(root, file);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
};

/** Windows paths compare case-insensitively; POSIX paths do not. */
const pathKey = (path: string, platform: NodeJS.Platform = process.platform): string => {
  const absolute = resolve(path);
  return platform === 'win32' ? absolute.toLowerCase() : absolute;
};

const isPrimaryModelFile = (fileName: string): boolean => {
  if (!/\.gguf$/i.test(fileName) || isProjectorFileName(fileName) || /^dflash/i.test(fileName)) {
    return false;
  }
  const shard = /-(\d{5})-of-\d{5}\.gguf$/i.exec(fileName);
  return !shard || shard[1] === '00001';
};

/**
 * The explicitly configured projector for a model. Keys are saved resolved, but
 * the model may arrive with a different drive-letter case on Windows or through
 * a symlinked directory, so both the given and the canonical path are tried.
 */
export const configuredVisionProjector = (
  models: readonly string[],
  projectors: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): string | undefined => {
  const wanted = new Set(models.map((model) => pathKey(model, platform)));
  for (const model of models) {
    const exact = projectors[resolve(model)];
    if (exact) return exact;
  }
  return Object.entries(projectors).find(([model]) => wanted.has(pathKey(model, platform)))?.[1];
};

/** A projector is model-specific. Never pick the first file from a shared folder. */
export const resolveVisionProjector = async (
  model: string,
  roots: readonly string[],
  projectors: Readonly<Record<string, string>> = {},
): Promise<string | undefined> => {
  const canonicalModel = await realpath(model).catch(() => undefined);
  let candidate = configuredVisionProjector(
    canonicalModel ? [model, canonicalModel] : [model],
    projectors,
  );
  if (!candidate) {
    const directory = dirname(model);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const ggufs = entries.filter((entry) => entry.isFile() && /\.gguf$/i.test(entry.name));
    const companions = ggufs.filter((entry) => isProjectorFileName(entry.name));
    const models = ggufs.filter((entry) => isPrimaryModelFile(entry.name));
    // A curated one-model folder is the convention used by catalog downloads.
    if (companions.length !== 1 || models.length !== 1) return undefined;
    // A drafter or other companion listed as a model must not inherit the projector.
    if (pathKey(join(directory, models[0]!.name)) !== pathKey(model)) return undefined;
    candidate = join(directory, companions[0]!.name);
  }
  if (extname(candidate).toLowerCase() !== '.gguf' || /^[/\\]{2}/.test(candidate)) {
    throw new Error('Vision projector must be a local GGUF file');
  }
  let file: string;
  try {
    file = await realpath(candidate);
  } catch (error) {
    throw new Error(`Vision projector ${basename(candidate)} was not found`, { cause: error });
  }
  const allowed = await Promise.all(roots.map((root) => realpath(root).catch(() => undefined)));
  if (!allowed.some((root) => root && inside(root, file)) || !(await stat(file)).isFile()) {
    throw new Error('Vision projector is outside configured model directories');
  }
  return file;
};

/**
 * Whether a model has a usable projector, for listings. A broken explicit
 * mapping must not hide every other model, so errors count as "no vision"; the
 * launch path still reports them.
 */
export const hasVisionProjector = async (
  model: string,
  roots: readonly string[],
  projectors: Readonly<Record<string, string>> = {},
): Promise<boolean> =>
  Boolean(await resolveVisionProjector(model, roots, projectors).catch(() => undefined));

const IMAGE_SIGNATURES: Readonly<Record<string, (data: Buffer) => boolean>> = {
  png: (data) => data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  jpeg: (data) => data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
  webp: (data) =>
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP',
  gif: (data) => ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('latin1')),
};

/** Keep inference local: reject image URLs that could make llama.cpp fetch a remote/private host. */
export const assertInlineImageInputs = (body: Record<string, unknown>): number => {
  let count = 0;
  let bytes = 0;
  const inline = (value: unknown): void => {
    if (typeof value !== 'string') throw new Error('Image input must be a base64 data URL');
    const match = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
    if (!match || match[2]!.length % 4 !== 0) {
      throw new Error(
        'Image input must use inline PNG, JPEG, WebP or GIF; remote URLs and file paths are disabled',
      );
    }
    const type = match[1]!.toLowerCase() === 'jpg' ? 'jpeg' : match[1]!.toLowerCase();
    const encoded = match[2]!;
    if (encoded.length > MAX_IMAGE_BASE64_CHARS) throw new Error('Image exceeds 8 MiB');
    const data = Buffer.from(encoded, 'base64');
    if (data.toString('base64') !== encoded) throw new Error('Invalid image base64');
    if (data.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds 8 MiB');
    if (!IMAGE_SIGNATURES[type]!(data)) {
      throw new Error(`Image data is not a valid image/${type} file`);
    }
    count++;
    bytes += data.length;
    if (count > MAX_IMAGES || bytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new Error('At most four images and 16 MiB per request');
    }
  };
  const content = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const raw of value) {
      if (!raw || typeof raw !== 'object') continue;
      const part = raw as Record<string, unknown>;
      if (part.type === 'image_url') {
        // OpenAI uses `{ url }`; some clients send the URL string directly.
        const image = part.image_url;
        inline(typeof image === 'string' ? image : (image as { url?: unknown } | undefined)?.url);
      } else if (part.type === 'input_image') inline(part.image_url);
      else if (part.type === 'image') {
        const source = part.source as
          { type?: unknown; media_type?: unknown; data?: unknown } | undefined;
        if (source?.type !== 'base64') throw new Error('Anthropic images must use a base64 source');
        if (typeof source.media_type !== 'string' || typeof source.data !== 'string') {
          throw new Error('Anthropic images need a string media_type and base64 data');
        }
        inline(`data:${source.media_type};base64,${source.data}`);
      } else if (part.type === 'tool_result') content(part.content);
    }
  };
  for (const field of [body.messages, body.input]) {
    if (!Array.isArray(field)) continue;
    content(field);
    for (const raw of field) {
      if (raw && typeof raw === 'object') content((raw as { content?: unknown }).content);
    }
  }
  return count;
};
