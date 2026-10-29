/**
 * LLM CALL — chat completion.  *** COSTS MONEY ***
 *
 * Provider / model: whatever an administrator assigned to the "Text" job in Admin → LLM
 *   (planned default: Meta Model API, muse-spark-1.3).
 * Cost: billed per token by the provider. Meta's list price for muse-spark-1.3 is $1.25 per million
 *   input tokens and $4.25 per million output tokens (muse-spark-1.3-contributor $0.10 / $0.20 but it
 *   trains on inputs; muse-wonder-1.0 $4.00 / $20.00). Every call reports its token usage.
 * Called only from the documentation generator, only after an administrator pressed a button and
 *   confirmed the cost estimate. Nothing in Mnemosyne calls a model on its own.
 */
import { ProviderValidationError, type Provider } from './provider-store.js';

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

const DEFAULT_TIMEOUT_MS = 6 * 60_000;

function endpoint(p: Pick<Provider, 'kind' | 'baseUrl'>): string {
  const base = p.baseUrl.replace(/\/+$/, '');
  if (p.kind === 'anthropic-messages') return /\/v\d+$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  return `${base}/chat/completions`;
}

export async function chat(
  p: Provider,
  model: string,
  system: string,
  user: string,
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<ChatResult> {
  const maxTokens = opts.maxTokens ?? 8000;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${p.apiKey}` };
  if (p.kind === 'anthropic-messages') {
    headers['x-api-key'] = p.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }

  const send = async (limitField: 'max_tokens' | 'max_completion_tokens') => {
    const body =
      p.kind === 'anthropic-messages'
        ? { model, system, max_tokens: maxTokens, messages: [{ role: 'user', content: user }] }
        : { model, [limitField]: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    try {
      return await fetch(endpoint(p), { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
    } catch {
      throw new ProviderValidationError('Could not reach the provider (network error or timeout).');
    }
  };

  let res = await send('max_tokens');
  if (res.status === 400) {
    // Some OpenAI-style APIs only accept the newer field name.
    const t = await res.text();
    if (/max_completion_tokens|max_tokens/i.test(t)) res = await send('max_completion_tokens');
    else throw new ProviderValidationError(`The provider rejected the request (HTTP 400).`);
  }
  if (res.status === 401 || res.status === 403) throw new ProviderValidationError(`The provider rejected the API key (HTTP ${res.status}).`);
  if (res.status === 429) throw new ProviderValidationError('The provider is rate-limiting this key (HTTP 429). Try again in a minute.');
  if (!res.ok) throw new ProviderValidationError(`The provider answered HTTP ${res.status}.`);

  const json = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: unknown } }[];
    content?: { type?: string; text?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
  } | null;
  const content =
    typeof json?.choices?.[0]?.message?.content === 'string'
      ? (json.choices[0]!.message!.content as string)
      : (json?.content ?? []).map((c) => (c.type === 'text' || c.text ? (c.text ?? '') : '')).join('');
  if (!content.trim()) throw new ProviderValidationError('The provider returned no text.');
  return {
    text: content,
    inputTokens: json?.usage?.prompt_tokens ?? json?.usage?.input_tokens ?? 0,
    outputTokens: json?.usage?.completion_tokens ?? json?.usage?.output_tokens ?? 0,
  };
}
