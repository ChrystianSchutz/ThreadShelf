// Minimal synthetic GGUF writer: header plus key/value metadata, no tensors.
export const u32 = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
};
export const u64 = (value) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
};
export const text = (value) => {
  const data = Buffer.from(value, 'utf8');
  return Buffer.concat([u64(data.length), data]);
};
export const kvString = (key, value) => Buffer.concat([text(key), u32(8), text(value)]);
export const kvU32 = (key, value) => Buffer.concat([text(key), u32(4), u32(value)]);
export const kvFloat = (key, value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(value);
  return Buffer.concat([text(key), u32(6), buffer]);
};
export const kvStringArray = (key, values) =>
  Buffer.concat([text(key), u32(9), u32(8), u64(values.length), ...values.map(text)]);
export const kvIntArray = (key, values) =>
  Buffer.concat([text(key), u32(9), u32(5), u64(values.length), ...values.map(u32)]);
export const gguf = (entries, { version = 3, kvCount = entries.length } = {}) =>
  Buffer.concat([Buffer.from('GGUF'), u32(version), u64(0), u64(kvCount), ...entries]);

/** A small GGUF shaped like a Qwen model with one MTP/NextN layer. */
export const syntheticMtpModel = (nextnPredictLayers = 1) =>
  gguf([
    kvString('general.architecture', 'qwen35'),
    kvString('general.name', 'Synthetic Qwen'),
    kvU32('qwen35.block_count', 65),
    kvU32('qwen35.context_length', 262_144),
    kvU32('qwen35.nextn_predict_layers', nextnPredictLayers),
  ]);
