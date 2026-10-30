import { mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { open, seal } from './secrets.js';

/**
 * What the documentation area remembers about a signed-in GitLab user between requests: their project
 * memberships, whether they are a GitLab administrator and the OAuth refresh token used to re-check both
 * silently on the server. Sealed (AES-256-GCM) on disk so that a restart or a deploy does not sign everybody
 * out - being sent through GitLab's redirect page again after every deploy is what this prevents.
 */
export interface MemberEntry {
  /** Epoch ms of the last successful check against GitLab. */
  at: number;
  admin: boolean;
  projects: { id: number; name: string; path: string; fullPath: string; webUrl: string }[] | null;
  /** GitLab refresh token (rotated on every use). Absent = the next check needs a browser sign-in. */
  refresh?: string;
}

export class MemberStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly encKey: Buffer,
  ) {}

  /** Read once at start-up; an unreadable or tampered file simply means everybody signs in again. */
  load(): Map<string, MemberEntry> {
    try {
      const raw = JSON.parse(open(this.encKey, readFileSync(this.file, 'utf8').trim())) as Record<string, MemberEntry>;
      return new Map(Object.entries(raw));
    } catch {
      return new Map();
    }
  }

  /** Serialised, atomic write of the whole map (it is small: one entry per signed-in user). */
  save(map: Map<string, MemberEntry>): Promise<void> {
    const body = seal(this.encKey, JSON.stringify(Object.fromEntries(map)));
    const run = this.queue.then(async () => {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await writeFile(tmp, body, { mode: 0o600 });
        await rename(tmp, this.file);
      } catch (err) {
        console.error('members: could not save:', (err as Error).message);
      }
    });
    this.queue = run;
    return run;
  }
}
