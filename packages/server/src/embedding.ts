import { HashEmbedder, type Embedder, type LLM } from '@mnemosyne/core';
import type { MnemosyneConfig } from './config.js';
import { OpenAICompatibleEmbedder, OpenAICompatibleLLM } from './adapters/openai.js';
import { LocalEmbedder } from './adapters/local-embedder.js';

/**
 * Pick an embedder from config:
 *   1. MNEMOSYNE_EMBED_BASE_URL set        -> OpenAI-compatible endpoint (the self-hosted gateway)
 *   2. MNEMOSYNE_EMBED_BACKEND=hash        -> force the offline HashEmbedder
 *   3. fastembed installed (and not forced off) -> local ONNX model
 *   4. otherwise                           -> HashEmbedder (deterministic, offline, modest quality)
 */
export async function resolveEmbedder(cfg: MnemosyneConfig): Promise<Embedder> {
  if (cfg.embed.baseUrl) {
    return new OpenAICompatibleEmbedder({
      baseUrl: cfg.embed.baseUrl,
      apiKey: cfg.embed.apiKey,
      model: cfg.embed.model,
      dimensions: cfg.embed.dimensions,
    });
  }
  const backend = (process.env.MNEMOSYNE_EMBED_BACKEND ?? '').toLowerCase();
  if (backend !== 'hash' && backend !== 'none') {
    try {
      return await LocalEmbedder.create();
    } catch {
      /* fall through to hash */
    }
  }
  return new HashEmbedder(cfg.embed.dimensions);
}

/** Optional chat model; null unless MNEMOSYNE_LLM_BASE_URL is set. */
export function resolveLLM(cfg: MnemosyneConfig): LLM | null {
  if (!cfg.llm.baseUrl) return null;
  return new OpenAICompatibleLLM({
    baseUrl: cfg.llm.baseUrl,
    apiKey: cfg.llm.apiKey,
    model: cfg.llm.model,
  });
}
