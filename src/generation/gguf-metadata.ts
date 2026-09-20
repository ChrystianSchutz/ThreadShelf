import { open, stat, type FileHandle } from 'fs/promises';

/** Capabilities read from a GGUF header rather than guessed from a file name. */
export interface GgufModelMetadata {
  readonly architecture?: string;
  readonly name?: string;
  /** Native training context (`<arch>.context_length`). */
  readonly contextLength?: number;
  readonly blockCount?: number;
  /** Layers of an embedded multi-token-prediction (NextN/MTP) head; 0 when absent. */
  readonly nextnPredictLayers: number;
}

const GGUF_MAGIC = 0x46554747; // "GGUF" read as little-endian uint32
const CHUNK_BYTES = 1024 * 1024;
// Tokenizer vocabularies dominate the header. Anything past this is not a sane model.
const MAX_HEADER_BYTES = 512 * 1024 * 1024;
const MAX_STRING_BYTES = 64 * 1024 * 1024;
const MAX_KV_COUNT = 100_000;
const TYPE_STRING = 8;
const TYPE_ARRAY = 9;
const SCALAR_BYTES: Readonly<Record<number, number>> = {
  0: 1,
  1: 1,
  2: 2,
  3: 2,
  4: 4,
  5: 4,
  6: 4,
  7: 1,
  10: 8,
  11: 8,
  12: 8,
};
const NUMERIC_SUFFIXES = ['.context_length', '.block_count', '.nextn_predict_layers'];

class HeaderReader {
  private buffer = Buffer.alloc(0);
  private bufferStart = 0;
  private position = 0;
  private readonly limit: number;

  constructor(
    private readonly handle: FileHandle,
    size: number,
  ) {
    this.limit = Math.min(size, MAX_HEADER_BYTES);
  }

  private ensureWithinLimit(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || this.position + length > this.limit) {
      throw new Error('GGUF header is truncated or exceeds the metadata limit');
    }
  }

  async bytes(length: number): Promise<Buffer> {
    this.ensureWithinLimit(length);
    const offset = this.position - this.bufferStart;
    if (offset < 0 || offset + length > this.buffer.length) {
      const chunk = Buffer.alloc(
        Math.min(Math.max(length, CHUNK_BYTES), this.limit - this.position),
      );
      const { bytesRead } = await this.handle.read(chunk, 0, chunk.length, this.position);
      if (bytesRead < length) throw new Error('GGUF header is truncated');
      this.buffer = chunk.subarray(0, bytesRead);
      this.bufferStart = this.position;
    }
    const start = this.position - this.bufferStart;
    this.position += length;
    return this.buffer.subarray(start, start + length);
  }

  skip(length: number): void {
    this.ensureWithinLimit(length);
    this.position += length;
  }

  async u32(): Promise<number> {
    return (await this.bytes(4)).readUInt32LE(0);
  }

  async u64(): Promise<number> {
    const value = (await this.bytes(8)).readBigUInt64LE(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('GGUF length is out of range');
    return Number(value);
  }

  async string(): Promise<string> {
    const length = await this.u64();
    if (length > MAX_STRING_BYTES) throw new Error('GGUF string is too long');
    return (await this.bytes(length)).toString('utf8');
  }
}

const readScalar = async (reader: HeaderReader, type: number): Promise<number | boolean> => {
  const value = await reader.bytes(SCALAR_BYTES[type]!);
  switch (type) {
    case 0:
      return value.readUInt8(0);
    case 1:
      return value.readInt8(0);
    case 2:
      return value.readUInt16LE(0);
    case 3:
      return value.readInt16LE(0);
    case 4:
      return value.readUInt32LE(0);
    case 5:
      return value.readInt32LE(0);
    case 6:
      return value.readFloatLE(0);
    case 7:
      return value.readUInt8(0) !== 0;
    case 10:
      return Number(value.readBigUInt64LE(0));
    case 11:
      return Number(value.readBigInt64LE(0));
    default:
      return value.readDoubleLE(0);
  }
};

const parseGgufHeader = async (path: string): Promise<GgufModelMetadata | null> => {
  const handle = await open(path, 'r');
  try {
    const reader = new HeaderReader(handle, (await handle.stat()).size);
    if ((await reader.u32()) !== GGUF_MAGIC) return null;
    // Version 1 used 32-bit lengths; every current llama.cpp GGUF is v2 or v3.
    if ((await reader.u32()) < 2) return null;
    await reader.u64(); // tensor count
    const kvCount = await reader.u64();
    if (kvCount > MAX_KV_COUNT) return null;

    const strings = new Map<string, string>();
    const numbers = new Map<string, number>();
    for (let index = 0; index < kvCount; index += 1) {
      const key = await reader.string();
      const type = await reader.u32();
      if (type === TYPE_STRING) {
        if (key === 'general.architecture' || key === 'general.name') {
          strings.set(key, await reader.string());
        } else {
          reader.skip(await reader.u64());
        }
      } else if (type === TYPE_ARRAY) {
        const elementType = await reader.u32();
        const count = await reader.u64();
        if (elementType === TYPE_STRING) {
          for (let element = 0; element < count; element += 1) reader.skip(await reader.u64());
        } else {
          const width = SCALAR_BYTES[elementType];
          if (!width) return null;
          reader.skip(width * count);
        }
      } else if (SCALAR_BYTES[type]) {
        const value = await readScalar(reader, type);
        if (typeof value === 'number' && NUMERIC_SUFFIXES.some((suffix) => key.endsWith(suffix))) {
          numbers.set(key, value);
        }
      } else {
        return null;
      }
    }

    // Keys are namespaced by architecture, which may appear anywhere in the header.
    const architecture = strings.get('general.architecture');
    const numeric = (suffix: string): number | undefined =>
      architecture ? numbers.get(`${architecture}${suffix}`) : undefined;
    return {
      architecture,
      name: strings.get('general.name'),
      contextLength: numeric('.context_length'),
      blockCount: numeric('.block_count'),
      nextnPredictLayers: Math.max(0, numeric('.nextn_predict_layers') ?? 0),
    };
  } finally {
    await handle.close();
  }
};

const metadataCache = new Map<string, Promise<GgufModelMetadata | null>>();

/** Reads GGUF metadata once per file version. Unreadable or non-GGUF files yield null. */
export const readGgufMetadata = async (path: string): Promise<GgufModelMetadata | null> => {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  const key = `${path}\0${info.size}\0${info.mtimeMs}`;
  let pending = metadataCache.get(key);
  if (!pending) {
    pending = parseGgufHeader(path).catch(() => null);
    metadataCache.set(key, pending);
  }
  return pending;
};
