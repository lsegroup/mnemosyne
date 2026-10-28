import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { open, seal } from './secrets.js';

export type ProviderKind = 'openai-compatible' | 'anthropic-messages';

export interface Provider {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** What the browser may see: the API key is never sent back, only a hint. */
export type ProviderPublic = Omit<Provider, 'apiKey'> & { hasKey: boolean; keyHint: string };

export interface ProviderInput {
  id?: string;
  label?: unknown;
  kind?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  /** Empty / omitted on update keeps the stored key. */
  apiKey?: unknown;
}

interface StoreFile {
  providers: Provider[];
  activeId: string | null;
}

export class ProviderValidationError extends Error {}

function text(v: unknown, field: string, max: number): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new ProviderValidationError(`${field} is required`);
  if (s.length > max) throw new ProviderValidationError(`${field} is too long`);
  return s;
}

function hint(key: string): string {
  return key.length >= 12 ? `••••${key.slice(-4)}` : key ? '••••' : '';
}

function toPublic(p: Provider): ProviderPublic {
  const { apiKey, ...rest } = p;
  return { ...rest, hasKey: apiKey.length > 0, keyHint: hint(apiKey) };
}

/**
 * LLM provider settings set from the admin UI. Persisted as one AES-256-GCM
 * sealed file next to the index cache (`.mnemosyne/`, never in the nodes repo —
 * git is the audit trail and must not hold API keys).
 */
export class ProviderStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly encKey: Buffer,
  ) {}

  private async read(): Promise<StoreFile> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { providers: [], activeId: null };
      throw err;
    }
    return JSON.parse(open(this.encKey, raw.trim())) as StoreFile;
  }

  private async write(data: StoreFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, seal(this.encKey, JSON.stringify(data)), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  /** Serialise read-modify-write cycles so concurrent admin requests cannot lose updates. */
  private mutate<T>(fn: (data: StoreFile) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const data = await this.read();
      const result = fn(data);
      await this.write(data);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async list(): Promise<{ providers: ProviderPublic[]; activeId: string | null }> {
    const data = await this.read();
    return { providers: data.providers.map(toPublic), activeId: data.activeId };
  }

  /** The active provider including its key, for server-side use only. */
  async getActive(): Promise<Provider | null> {
    const data = await this.read();
    return data.providers.find((p) => p.id === data.activeId) ?? null;
  }

  upsert(input: ProviderInput): Promise<ProviderPublic> {
    const label = text(input.label, 'label', 80);
    const model = text(input.model, 'model', 120);
    const kind = input.kind;
    if (kind !== 'openai-compatible' && kind !== 'anthropic-messages') {
      throw new ProviderValidationError('kind must be openai-compatible or anthropic-messages');
    }
    const baseUrl = text(input.baseUrl, 'baseUrl', 300).replace(/\/+$/, '');
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new ProviderValidationError('baseUrl is not a valid URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new ProviderValidationError('baseUrl must be http(s)');
    }
    const newKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (newKey.length > 500) throw new ProviderValidationError('apiKey is too long');

    return this.mutate((data) => {
      const existing = input.id ? data.providers.find((p) => p.id === input.id) : undefined;
      if (input.id && !existing) throw new ProviderValidationError('unknown provider id');
      const provider: Provider = {
        id: existing?.id ?? randomUUID(),
        label,
        kind,
        baseUrl,
        model,
        apiKey: newKey || existing?.apiKey || '',
      };
      if (existing) data.providers[data.providers.indexOf(existing)] = provider;
      else data.providers.push(provider);
      if (!data.activeId) data.activeId = provider.id;
      return toPublic(provider);
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate((data) => {
      data.providers = data.providers.filter((p) => p.id !== id);
      if (data.activeId === id) data.activeId = data.providers[0]?.id ?? null;
    });
  }

  activate(id: string): Promise<void> {
    return this.mutate((data) => {
      if (!data.providers.some((p) => p.id === id)) throw new ProviderValidationError('unknown provider id');
      data.activeId = id;
    });
  }
}
