interface PipelineOutput {
  readonly data: Float32Array;
  readonly dims?: number[];
}

type Pipeline = (
  text: string | string[],
  options: Record<string, unknown>,
) => Promise<PipelineOutput>;

const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const DIMENSION = 384;

export const getDimension = (): number => {
  return DIMENSION;
};

const loadPipeline = async (): Promise<Pipeline> => {
  const { pipeline } = await import('@huggingface/transformers');
  return (await pipeline('feature-extraction', MODEL, {
    dtype: 'q8',
    progress_callback: (p: unknown) => {
      const info = p as { status?: string; file?: string; progress?: number };
      if (info.status === 'progress') console.error('[embedding]', info.file, info.progress);
    },
  })) as Pipeline;
};

export const createEmbedder = (load: () => Promise<Pipeline>) => {
  let pipeline: Promise<Pipeline> | undefined;
  return async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return [];
    pipeline ??= load().catch((error) => {
      pipeline = undefined;
      throw error;
    });
    const pipe = await pipeline;
    const options = { pooling: 'mean', normalize: true };

    try {
      const out = await pipe(texts, options);
      const data = Array.from(out.data);
      const batchSize = out.dims?.[0] === texts.length ? texts.length : texts.length === 1 ? 1 : 0;
      if (batchSize > 0 && data.length % batchSize === 0) {
        const stride = data.length / batchSize;
        return texts.map((_, index) => data.slice(index * stride, (index + 1) * stride));
      }
    } catch (e) {
      if (texts.length === 1) throw e;
    }

    const results: number[][] = [];
    for (const text of texts) {
      const out = await pipe(text, options);
      results.push(Array.from(out.data));
    }
    return results;
  };
};

export const embed = createEmbedder(loadPipeline);

export const embedOne = async (text: string): Promise<number[]> => {
  const [v] = await embed([text]);
  return v!;
};
