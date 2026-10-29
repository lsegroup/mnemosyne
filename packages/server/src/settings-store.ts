import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { open, seal } from './secrets.js';

export interface GitLabSettings {
  url?: string;
  clientId?: string;
  clientSecret?: string;
}

/** Portal settings editable from the admin UI; they override the environment values. */
export interface PortalSettings {
  gitlab?: GitLabSettings;
  /** Epoch seconds of the first successful GitLab admin sign-in: SSO is proven live from then on. */
  ssoLiveAt?: number;
}

export class SettingsValidationError extends Error {}

/** Sealed (AES-256-GCM) file next to the index cache, same protection as the provider keys. */
export class SettingsStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly encKey: Buffer,
  ) {}

  async get(): Promise<PortalSettings> {
    try {
      return JSON.parse(open(this.encKey, (await readFile(this.file, 'utf8')).trim())) as PortalSettings;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  /** Serialised read-modify-write so concurrent admin requests cannot lose updates. */
  update(fn: (s: PortalSettings) => void): Promise<PortalSettings> {
    const run = this.queue.then(async () => {
      const s = await this.get();
      fn(s);
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, seal(this.encKey, JSON.stringify(s)), { mode: 0o600 });
      await rename(tmp, this.file);
      return s;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function str(v: unknown, field: string, max: number): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length > max) throw new SettingsValidationError(`${field} is too long`);
  return s;
}

/** Validate the SSO form; an empty clientSecret keeps the stored one. Admin rights come from GitLab, never from a list here. */
export function applyPortalInput(s: PortalSettings, input: Record<string, unknown>): void {
  const url = str(input.gitlabUrl, 'GitLab URL', 300).replace(/\/+$/, '');
  if (url) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new SettingsValidationError('GitLab URL is not a valid URL');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SettingsValidationError('GitLab URL must be http(s)');
  }
  const clientId = str(input.clientId, 'Application ID', 200);
  const newSecret = str(input.clientSecret, 'Secret', 500);
  s.gitlab = { url, clientId, clientSecret: newSecret || s.gitlab?.clientSecret || '' };
}
