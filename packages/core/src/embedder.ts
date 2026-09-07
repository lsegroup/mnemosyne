import { createHash } from 'node:crypto';

/**
 * Turns text into a fixed-length vector for semantic search.
 * Implementations: HashEmbedder (here, zero-dep fallback), LocalEmbedder
 * (fastembed / ONNX) and OpenAICompatibleEmbedder both live in the server package.
 */
export interface Embedder {
  readonly id: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Deterministic, offline, dependency-free embedder: hashed bag-of-tokens projected
 * into `dimensions` buckets, L2-normalized. Quality is modest — it captures lexical
 * overlap, not deep semantics — but it makes hybrid search work out of the box and
 * keeps tests hermetic. Swap in a real model via config for production recall.
 */
export class HashEmbedder implements Embedder {
  readonly id: string;
  readonly dimensions: number;

  constructor(dimensions = 256) {
    this.dimensions = dimensions;
    this.id = `hash-${dimensions}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): Float32Array {
    const vec = new Float32Array(this.dimensions);
    const tokens = text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
    for (const tok of tokens) {
      const h = createHash('md5').update(tok).digest();
      const bucket = h.readUInt32LE(0) % this.dimensions;
      const sign = (h[4]! & 1) === 0 ? 1 : -1;
      vec[bucket] = (vec[bucket] ?? 0) + sign;
    }
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i]! /= norm;
    return vec;
  }
}
