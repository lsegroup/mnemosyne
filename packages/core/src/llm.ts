/**
 * Optional chat-completion interface for the features that genuinely need a model:
 * `mnemosyne extract` (commits -> candidate nodes), node dedupe/merge, and the
 * REST `/ask` RAG endpoint. All of these are off unless an LLM is configured.
 *
 * The only shipped implementation is OpenAICompatibleLLM (server package), which
 * targets any `/v1/chat/completions` gateway (vLLM, LiteLLM, TGI, Ollama's compat
 * endpoint, ...).
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** Ask the model to return a single JSON object. */
  json?: boolean;
}

export interface LLM {
  readonly id: string;
  complete(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}
