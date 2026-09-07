import type { Embedder } from '@mnemosyne/core';

/**
 * Local ONNX embedder via the optional `fastembed` dependency. Loaded lazily so
 * the package installs and runs without it; if `fastembed` is absent the caller
 * falls back to HashEmbedder.
 */
export class LocalEmbedder implements Embedder {
  readonly id: string;
  readonly dimensions: number;
  private model: unknown;
  private readonly modelName: string;

  private constructor(modelName: string, dimensions: number, model: unknown) {
    this.modelName = modelName;
    this.dimensions = dimensions;
    this.model = model;
    this.id = `fastembed:${modelName}`;
  }

  static async create(modelName = 'BGE-small-en-v1.5'): Promise<LocalEmbedder> {
    let fastembed: any;
    try {
      fastembed = await import('fastembed');
    } catch {
      throw new Error('fastembed is not installed; set MNEMOSYNE_EMBED_BASE_URL or install it');
    }
    const { FlagEmbedding, EmbeddingModel } = fastembed;
    const key =
      (EmbeddingModel &&
        Object.keys(EmbeddingModel).find((k) => k.toLowerCase().includes('bgesmall'))) ||
      undefined;
    const model = await FlagEmbedding.init(key ? { model: EmbeddingModel[key] } : {});
    return new LocalEmbedder(modelName, 384, model);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const model = this.model as {
      embed: (docs: string[], batch?: number) => AsyncGenerator<number[][]>;
    };
    const out: Float32Array[] = [];
    for await (const batch of model.embed(texts, 32)) {
      for (const v of batch) out.push(Float32Array.from(v));
    }
    return out;
  }
}
