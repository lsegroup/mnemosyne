import type { ChatMessage, ChatOptions, Embedder, LLM } from '@mnemosyne/core';

interface OpenAIEmbedConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  dimensions: number;
}

/** Embedder backed by any `/v1/embeddings` endpoint (OpenAI, vLLM, LiteLLM, TEI, ...). */
export class OpenAICompatibleEmbedder implements Embedder {
  readonly id: string;
  readonly dimensions: number;
  private readonly url: string;

  constructor(private readonly cfg: OpenAIEmbedConfig) {
    this.dimensions = cfg.dimensions;
    this.id = `openai:${cfg.model}`;
    this.url = `${cfg.baseUrl.replace(/\/$/, '')}/embeddings`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.cfg.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`embeddings endpoint ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    return body.data
      .sort((a, b) => a.index - b.index)
      .map((d) => {
        if (d.embedding.length !== this.dimensions) {
          throw new Error(
            `model returned ${d.embedding.length}-d vectors, expected ${this.dimensions} (set MNEMOSYNE_EMBED_DIM)`,
          );
        }
        return Float32Array.from(d.embedding);
      });
  }
}

interface OpenAIChatConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** Chat model backed by any `/v1/chat/completions` endpoint. */
export class OpenAICompatibleLLM implements LLM {
  readonly id: string;
  private readonly url: string;

  constructor(private readonly cfg: OpenAIChatConfig) {
    this.id = `openai:${cfg.model}`;
    this.url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  }

  async complete(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens,
        ...(options.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`chat endpoint ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    return body.choices[0]?.message.content ?? '';
  }
}
