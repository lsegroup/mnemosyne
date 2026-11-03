// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Only ONE AI job runs at a time, although two programs can start one: this server (a person pressed a button on a project page) and the
 * separate admin program in front of it (the Auto scheduler). They agree through a small file next to the other portal state that says who is working:
 * "person" or "auto". A lock older than a few hours is forgotten, so a crash never blocks the AI for good.
 */
export type LockHolder = 'person' | 'auto';

const STALE_MS = 3 * 3600 * 1000;

export const aiLockFile = (dir: string) => join(dir, 'ai-busy.json');

function read(file: string): { by?: string; since?: string } | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { by?: string; since?: string };
  } catch {
    return null;
  }
}

export function holdAiLock(file: string, by: LockHolder, now = Date.now()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ by, since: new Date(now).toISOString() }), { mode: 0o600 });
  } catch {
    /* a lock that cannot be written must not stop the job: the in-memory check still holds inside this program */
  }
}

/** Removes the lock, but only when it is held by `by`. */
export function releaseAiLock(file: string, by: LockHolder): void {
  if (read(file)?.by === by) rmSync(file, { force: true });
}

/** Somebody else's fresh lock. */
export function aiLockHeldBy(file: string, by: LockHolder, now = Date.now()): boolean {
  const s = read(file);
  if (!s || s.by !== by || !s.since) return false;
  const since = Date.parse(s.since);
  return Number.isFinite(since) && now - since < STALE_MS;
}
