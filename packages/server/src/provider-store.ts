import type { JobsFile, JobSettings } from './ai-jobs.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { open, seal } from './secrets.js';

export type ProviderKind = 'openai-compatible' | 'anthropic-messages';

/** The jobs a model can be assigned to in the admin UI. */
export const ROLES = ['text', 'image', 'pdf'] as const;
export type Role = (typeof ROLES)[number];

/** A provider connection: endpoint + API key, plus the models its API reported when last fetched. */
export interface Provider {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  /** Model ids returned by the provider's own model-list endpoint (empty until fetched). */
  models: string[];
  /** Epoch ms of the last successful fetch. */
  modelsPulledAt?: number;
}

export interface Assignment {
  providerId: string;
  model: string;
}
export type Assignments = Partial<Record<Role, Assignment>>;

/** What the browser may see: the API key is never sent back, only a hint. */
export type ProviderPublic = Omit<Provider, 'apiKey'> & { hasKey: boolean; keyHint: string };

export interface ProviderInput {
  id?: string;
  label?: unknown;
  kind?: unknown;
  baseUrl?: unknown;
  /** Empty / omitted on update keeps the stored key. */
  apiKey?: unknown;
}

interface StoreFile {
  providers: Provider[];
  assignments: Assignments;
  /** Per-job AI settings (limits, sampling, prompts) set in the admin UI; see ai-jobs.ts. */
  jobs?: JobsFile;
  /** Legacy (single "active" provider with one model); migrated on read. */
  activeId?: string | null;
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
 * LLM connections and the model chosen for each job, set from the admin UI. Persisted as one
 * AES-256-GCM sealed file next to the index cache (`.mnemosyne/`, never in the nodes repo —
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
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { providers: [], assignments: {} };
      throw err;
    }
    const data = JSON.parse(open(this.encKey, raw.trim())) as StoreFile & { providers: (Provider & { model?: string })[] };
    // Migrate the first-generation layout: one model per provider + one active provider.
    for (const p of data.providers) {
      p.models ??= p.model ? [p.model] : [];
    }
    data.assignments ??= {};
    if (data.activeId && !data.assignments.text) {
      const active = data.providers.find((p) => p.id === data.activeId);
      const model = (active as { model?: string } | undefined)?.model;
      if (active && model) data.assignments.text = { providerId: active.id, model };
    }
    return data;
  }

  private async write(data: StoreFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const clean: StoreFile = { providers: data.providers.map(({ ...p }) => p), assignments: data.assignments, jobs: data.jobs ?? {} };
    await writeFile(tmp, seal(this.encKey, JSON.stringify(clean)), { mode: 0o600 });
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

  async list(): Promise<{ providers: ProviderPublic[]; assignments: Assignments; jobs: JobsFile }> {
    const data = await this.read();
    return { providers: data.providers.map(toPublic), assignments: data.assignments, jobs: data.jobs ?? {} };
  }

  /** The stored (non-default) settings of every job. */
  async getJobs(): Promise<JobsFile> {
    return (await this.read()).jobs ?? {};
  }

  /**
   * Saves one job: its model (providerId + model, or null to clear it) and its settings. Other jobs stay untouched.
   * The model must be one the provider reported.
   */
  setJob(role: Role, assignment: { providerId?: unknown; model?: unknown } | null, settings: JobSettings): Promise<{ assignment: Assignments[Role]; settings: JobSettings }> {
    return this.mutate((data) => {
      if (assignment && (assignment.providerId || assignment.model)) {
        const provider = data.providers.find((p) => p.id === assignment.providerId);
        if (!provider) throw new ProviderValidationError(`${role}: unknown provider`);
        if (typeof assignment.model !== 'string' || !provider.models.includes(assignment.model)) {
          throw new ProviderValidationError(`${role}: model is not one of the models this provider reported`);
        }
        data.assignments[role] = { providerId: provider.id, model: assignment.model };
      } else delete data.assignments[role];
      data.jobs ??= {};
      if (Object.keys(settings).length) data.jobs[role] = settings;
      else delete data.jobs[role];
      return { assignment: data.assignments[role], settings: data.jobs[role] ?? {} };
    });
  }

  /** A provider including its key, for server-side use only (fetching models, later: LLM calls). */
  async getFull(id: string): Promise<Provider> {
    const p = (await this.read()).providers.find((x) => x.id === id);
    if (!p) throw new ProviderValidationError('unknown provider id');
    return p;
  }

  /** The provider and model chosen for a job, including the key; null when none is chosen. */
  async getAssigned(role: Role): Promise<{ provider: Provider; model: string } | null> {
    const data = await this.read();
    const a = data.assignments[role];
    const provider = a && data.providers.find((p) => p.id === a.providerId);
    return a && provider ? { provider, model: a.model } : null;
  }

  upsert(input: ProviderInput): Promise<ProviderPublic> {
    const label = text(input.label, 'name', 80);
    const kind = input.kind;
    if (kind !== 'openai-compatible' && kind !== 'anthropic-messages') {
      throw new ProviderValidationError('API format must be openai-compatible or anthropic-messages');
    }
    const baseUrl = text(input.baseUrl, 'base URL', 300).replace(/\/+$/, '');
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new ProviderValidationError('base URL is not a valid URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new ProviderValidationError('base URL must be http(s)');
    }
    const newKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (newKey.length > 500) throw new ProviderValidationError('API key is too long');

    return this.mutate((data) => {
      const existing = input.id ? data.providers.find((p) => p.id === input.id) : undefined;
      if (input.id && !existing) throw new ProviderValidationError('unknown provider id');
      if (!existing && !newKey) throw new ProviderValidationError('API key is required');
      // A different endpoint or key may expose different models: forget the old list and any choice made from it.
      const changed = !existing || existing.baseUrl !== baseUrl || (newKey !== '' && newKey !== existing.apiKey);
      const provider: Provider = {
        id: existing?.id ?? randomUUID(),
        label,
        kind,
        baseUrl,
        apiKey: newKey || existing?.apiKey || '',
        models: changed ? [] : existing!.models,
        modelsPulledAt: changed ? undefined : existing!.modelsPulledAt,
      };
      if (existing) {
        data.providers[data.providers.indexOf(existing)] = provider;
        if (changed) this.dropAssignments(data, provider.id);
      } else data.providers.push(provider);
      return toPublic(provider);
    });
  }

  /** Remember the models a provider reported; a choice that is no longer offered is dropped. */
  setModels(id: string, models: string[]): Promise<ProviderPublic> {
    return this.mutate((data) => {
      const p = data.providers.find((x) => x.id === id);
      if (!p) throw new ProviderValidationError('unknown provider id');
      p.models = models;
      p.modelsPulledAt = Date.now();
      for (const role of ROLES) {
        const a = data.assignments[role];
        if (a && a.providerId === id && !models.includes(a.model)) delete data.assignments[role];
      }
      return toPublic(p);
    });
  }

  /** Choose one model per job. A missing / null role is cleared; the model must be one the provider reported. */
  setAssignments(input: Record<string, unknown>): Promise<Assignments> {
    return this.mutate((data) => {
      const next: Assignments = {};
      for (const role of ROLES) {
        const v = input[role] as { providerId?: unknown; model?: unknown } | null | undefined;
        if (!v) continue;
        const provider = data.providers.find((p) => p.id === v.providerId);
        if (!provider) throw new ProviderValidationError(`${role}: unknown provider`);
        if (typeof v.model !== 'string' || !provider.models.includes(v.model)) {
          throw new ProviderValidationError(`${role}: model is not one of the models this provider reported`);
        }
        next[role] = { providerId: provider.id, model: v.model };
      }
      data.assignments = next;
      return next;
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate((data) => {
      data.providers = data.providers.filter((p) => p.id !== id);
      this.dropAssignments(data, id);
    });
  }

  private dropAssignments(data: StoreFile, providerId: string): void {
    for (const role of ROLES) if (data.assignments[role]?.providerId === providerId) delete data.assignments[role];
  }
}
