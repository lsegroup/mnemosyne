// SPDX-License-Identifier: Apache-2.0
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
  /** Who may start the AI jobs (documentation, workflow diagram) on the project pages: one switch per level. Set in Admin -> Access. */
  generate?: Partial<GenerateRoles>;
}

/** The levels a switch exists for: GitLab administrators and the access level a person has on the GitLab project of the notes. */
export const GENERATE_LEVELS = ['admin', 'owner', 'maintainer', 'developer', 'reporter', 'guest'] as const;
export type GenerateLevel = (typeof GENERATE_LEVELS)[number];
export type GenerateRoles = Record<GenerateLevel, boolean>;
/** Nothing saved = administrators and owners may generate, nobody else. */
export const DEFAULT_GENERATE: GenerateRoles = { admin: true, owner: true, maintainer: false, developer: false, reporter: false, guest: false };

/** The saved switches over the defaults (only real booleans count). */
export function generateRoles(s: PortalSettings): GenerateRoles {
  const out = { ...DEFAULT_GENERATE };
  for (const k of GENERATE_LEVELS) if (typeof s.generate?.[k] === 'boolean') out[k] = s.generate[k]!;
  return out;
}

/** A GitLab access level (5 minimal, 10 guest, 15 planner, 20 reporter, 30 developer, 40 maintainer, 50 owner) as a switch. */
export function levelKey(level: number): Exclude<GenerateLevel, 'admin'> {
  return level >= 50 ? 'owner' : level >= 40 ? 'maintainer' : level >= 30 ? 'developer' : level >= 20 ? 'reporter' : 'guest';
}

/**
 * May this person start AI jobs for a project? A GitLab administrator if the Admin switch is on, or anybody whose access level on the
 * project's GitLab project has its switch on. Every grant counts (an administrator who is also an owner needs either). A level that is
 * not known yet (the person has not been re-checked against GitLab since this existed) counts as no level.
 */
export function mayGenerate(roles: GenerateRoles, who: { admin: boolean }, level: number | null | undefined): boolean {
  if (who.admin && roles.admin) return true;
  return typeof level === 'number' && level > 0 && roles[levelKey(level)];
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
