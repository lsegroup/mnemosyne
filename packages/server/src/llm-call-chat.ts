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
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ProviderValidationError, type Provider } from './provider-store.js';

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** A 50,000-token answer can take ten minutes; the job runs in the background and the page polls. */
const DEFAULT_TIMEOUT_MS = 20 * 60_000;

/** Technical reason of a failed fetch (undici hides it in `cause`), e.g. "ECONNRESET" or "other side closed". Never contains secrets. */
export function networkDetail(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string; message?: string } };
  if (e?.name === 'TimeoutError') return 'timed out';
  return e?.cause?.code ?? e?.code ?? e?.cause?.message ?? e?.message ?? 'unknown error';
}

/**
 * POST with up to two retries when the connection itself fails (reset, closed, DNS), with a short pause.
 * A timeout is not retried. The retried request is part of the job the administrator agreed to; at these
 * sizes it costs a fraction of a cent.
 */
/**
 * One POST over node:http(s). Not fetch: Node's fetch (undici) drops a request that has received no response
 * headers after 5 minutes, and a non-streamed answer of tens of thousands of tokens arrives only when it is complete.
 */
function postOnce(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? httpRequest : httpsRequest;
    const timer = setTimeout(() => {
      const e = new Error('timed out');
      e.name = 'TimeoutError';
      req.destroy(e);
    }, timeoutMs);
    const req = lib(u, { method: init.method ?? 'POST', headers: init.headers as Record<string, string> }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      res.on('end', () => {
        clearTimeout(timer);
        const status = res.statusCode ?? 502;
        const body = Buffer.concat(chunks);
        resolve(new Response(status === 204 || status === 304 ? null : body, { status }));
      });
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.write(String(init.body ?? ''));
    req.end();
  });
}

export async function fetchWithRetry(url: string, init: RequestInit, timeoutMs: number, what: string): Promise<Response> {
  let detail = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await postOnce(url, init, timeoutMs);
    } catch (err) {
      detail = networkDetail(err);
      if (detail === 'timed out') break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw new ProviderValidationError(`Could not reach ${what} (${detail}).`);
}

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
  opts: { maxTokens?: number; timeoutMs?: number; temperature?: number; topP?: number } = {},
): Promise<ChatResult> {
  const maxTokens = opts.maxTokens ?? 8000;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${p.apiKey}` };
  if (p.kind === 'anthropic-messages') {
    headers['x-api-key'] = p.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }

  const send = async (limitField: 'max_tokens' | 'max_completion_tokens', limit: number) => {
    // temperature / top_p are sent only when an administrator set them; otherwise the provider's own default applies
    const sampling = { ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}), ...(opts.topP !== undefined ? { top_p: opts.topP } : {}) };
    const body =
      p.kind === 'anthropic-messages'
        ? { model, system, max_tokens: limit, ...sampling, messages: [{ role: 'user', content: user }] }
        : { model, [limitField]: limit, ...sampling, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    return fetchWithRetry(endpoint(p), { method: 'POST', headers, body: JSON.stringify(body) }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'the provider');
  };

  // A 400 is not billed. Try the other field name (some OpenAI-style APIs only know the newer one) and, for very
  // large limits, a smaller limit in case the model's maximum output is lower than asked.
  const attempts: ['max_tokens' | 'max_completion_tokens', number][] = [['max_tokens', maxTokens], ['max_completion_tokens', maxTokens]];
  if (maxTokens > 16_000) attempts.push(['max_tokens', 16_000], ['max_completion_tokens', 16_000]);
  let res!: Response;
  let usedLimit = maxTokens;
  let why = '';
  for (const [field, limit] of attempts) {
    res = await send(field, limit);
    usedLimit = limit;
    if (res.status !== 400) break;
    const t = await res.text();
    why = (/"message"\s*:\s*"([^"]{1,200})/.exec(t)?.[1] ?? '').trim();
  }
  if (res.status === 400) throw new ProviderValidationError(`The provider rejected the request (HTTP 400${why ? `: ${why}` : ''}).`);
  if (res.status === 401 || res.status === 403) throw new ProviderValidationError(`The provider rejected the API key (HTTP ${res.status}).`);
  if (res.status === 429) throw new ProviderValidationError('The provider is rate-limiting this key (HTTP 429). Try again in a minute.');
  if (!res.ok) throw new ProviderValidationError(`The provider answered HTTP ${res.status}.`);

  const json = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }; finish_reason?: string }[];
    stop_reason?: string;
    content?: { type?: string; text?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
  } | null;
  const content =
    typeof json?.choices?.[0]?.message?.content === 'string'
      ? (json.choices[0]!.message!.content as string)
      : (json?.content ?? []).map((c) => (c.type === 'text' || c.text ? (c.text ?? '') : '')).join('');
  if (!content.trim()) {
    // Reasoning models spend part of the limit on thinking; with a small limit nothing is left for the answer.
    const finish = json?.choices?.[0]?.finish_reason ?? json?.stop_reason ?? 'unknown';
    const out = json?.usage?.completion_tokens ?? json?.usage?.output_tokens ?? 0;
    const thought = Boolean(json?.choices?.[0]?.message?.reasoning_content ?? json?.choices?.[0]?.message?.reasoning);
    throw new ProviderValidationError(
      `The provider returned no text (finish reason: ${finish}, ${out} output tokens${thought ? ', the model only produced reasoning' : ''}). ` +
        (finish === 'length' || finish === 'max_tokens' ? `The limit of ${usedLimit} tokens was used up before the answer - it needs a higher limit.` : 'Try again or choose another model in Admin → LLM.'),
    );
  }
  return {
    text: content,
    inputTokens: json?.usage?.prompt_tokens ?? json?.usage?.input_tokens ?? 0,
    outputTokens: json?.usage?.completion_tokens ?? json?.usage?.output_tokens ?? 0,
  };
}
