/**
 * Asks an LLM provider which models its API key may use (`GET …/models`).
 * Calls: the provider's model-LIST endpoint only. No inference, no tokens, no cost.
 * Used by the admin UI step "fetch available models"; never called on its own.
 */
import { ProviderValidationError, type Provider } from './provider-store.js';

const TIMEOUT_MS = 15_000;
const MAX_BODY = 2_000_000;
const MAX_MODELS = 500;

/** Where the model list lives for each API format. */
export function modelsUrl(p: Pick<Provider, 'kind' | 'baseUrl'>): string {
  const base = p.baseUrl.replace(/\/+$/, '');
  if (p.kind === 'anthropic-messages' && !/\/v\d+$/.test(base)) return `${base}/v1/models`;
  return `${base}/models`;
}

/** Pull model ids out of the shapes providers use: `{data:[{id}]}`, `{models:[{name}]}`, `[…]`, or plain strings. */
export function parseModelIds(body: unknown): string[] {
  const list = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown })?.data)
      ? (body as { data: unknown[] }).data
      : Array.isArray((body as { models?: unknown })?.models)
        ? (body as { models: unknown[] }).models
        : [];
  const ids = new Set<string>();
  for (const item of list) {
    const raw = typeof item === 'string' ? item : ((item as { id?: unknown; name?: unknown })?.id ?? (item as { name?: unknown })?.name);
    if (typeof raw === 'string' && raw.trim()) ids.add(raw.trim().replace(/^models\//, ''));
  }
  return [...ids].sort((a, b) => a.localeCompare(b)).slice(0, MAX_MODELS);
}

export async function fetchModels(p: Provider): Promise<string[]> {
  const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${p.apiKey}` };
  if (p.kind === 'anthropic-messages') {
    headers['x-api-key'] = p.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }
  let res: Response;
  try {
    res = await fetch(modelsUrl(p), { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderValidationError('Could not reach the provider (check the base URL and network).');
  }
  if (res.status === 401 || res.status === 403) {
    throw new ProviderValidationError(`The provider rejected the API key (HTTP ${res.status}).`);
  }
  if (!res.ok) throw new ProviderValidationError(`The provider answered HTTP ${res.status} for its model list.`);
  const raw = await res.text();
  if (raw.length > MAX_BODY) throw new ProviderValidationError('The provider returned an unexpectedly large model list.');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ProviderValidationError('The provider did not return a JSON model list.');
  }
  const ids = parseModelIds(json);
  if (!ids.length) throw new ProviderValidationError('The provider returned no models for this key.');
  return ids;
}
