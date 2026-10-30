/**
 * LLM CALL — image generation.  *** COSTS MONEY ***
 *
 * Provider / model: whatever an administrator assigned to the "Images" job in Admin → LLM
 *   (planned default: Meta Model API, muse-image-1.0).
 * Cost: Meta lists muse-image-1.0 at about $0.01 per generated image (one image per call here).
 * Endpoint: POST {baseUrl}/images/generations  { model, prompt, n: 1 }  (OpenAI-compatible; Meta Model API).
 * Called only from the documentation generator, only after an administrator pressed
 *   "Create workflow diagram" and confirmed.
 */
import { fetchWithRetry } from './llm-call-chat.js';
import { ProviderValidationError, type Provider } from './provider-store.js';

export interface ImageResult {
  bytes: Buffer;
  /** Sniffed from the bytes, not trusted from the provider. */
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
}

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export function sniffImage(b: Buffer): ImageResult['mime'] | null {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

export async function generateImage(p: Provider, model: string, prompt: string, timeoutMs = 4 * 60_000): Promise<ImageResult> {
  const url = `${p.baseUrl.replace(/\/+$/, '')}/images/generations`;
  const res = await fetchWithRetry(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${p.apiKey}` }, body: JSON.stringify({ model, prompt, n: 1 }) },
    timeoutMs,
    'the provider for image generation',
  );
  if (res.status === 401 || res.status === 403) throw new ProviderValidationError(`The provider rejected the API key (HTTP ${res.status}).`);
  if (res.status === 429) throw new ProviderValidationError('The provider is rate-limiting this key (HTTP 429). Try again in a minute.');
  if (!res.ok) throw new ProviderValidationError(`The provider answered HTTP ${res.status} for image generation.`);

  const json = (await res.json().catch(() => null)) as { data?: { b64_json?: string; url?: string }[] } | null;
  const item = json?.data?.[0];
  let bytes: Buffer | null = null;
  if (item?.b64_json) bytes = Buffer.from(item.b64_json, 'base64');
  else if (item?.url && /^https:\/\//.test(item.url)) {
    try {
      const img = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
      if (img.ok) bytes = Buffer.from(await img.arrayBuffer());
    } catch {
      /* handled below */
    }
  }
  if (!bytes || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new ProviderValidationError('The provider returned no usable image.');
  const mime = sniffImage(bytes);
  if (!mime) throw new ProviderValidationError('The provider returned something that is not a PNG, JPEG or WebP image.');
  return { bytes, mime };
}
