import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { open, seal } from './secrets.js';

/**
 * Personal MCP tokens: every person with a GitLab account issues their own in their profile and presents it as
 * `Authorization: Bearer <token>` when an MCP client (or REST) talks to this server. The server then knows WHICH person
 * is calling, which a shared token never can. A token is valid for at most 90 days, so it is rotated like a password.
 *
 * Only a SHA-256 hash of the token is kept (the token itself is long and random, so a fast hash is enough), sealed with the
 * rest of the portal's data at rest. The token is shown once, when it is issued, and cannot be read back afterwards.
 */
export const TOKEN_PREFIX = 'mnm_';
/** The longest a token may live. Rotation like a password (PCI DSS style 90 days). */
export const MAX_TOKEN_DAYS = 90;
/** Active tokens one person may hold at the same time (a laptop, a CI job, ...). They are still ONE seat. */
export const MAX_ACTIVE_TOKENS = 5;
const DAY_MS = 24 * 3600 * 1000;
/** Expired and revoked tokens stay visible in the profile this long, then they are forgotten. */
const KEEP_DEAD_MS = 30 * DAY_MS;
/** A token in use is written back at most this often to remember when and from where it was last used. */
const TOUCH_EVERY_MS = 60 * 1000;

export class TokenError extends Error {}

interface StoredToken {
  id: string;
  /** GitLab username of the owner. */
  user: string;
  /** The label the owner gave it, e.g. "Claude Code on my laptop". */
  name: string;
  /** SHA-256 (hex) of the token. */
  hash: string;
  /** The first characters after the prefix, so a person can tell their tokens apart. */
  hint: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt?: number;
  lastIp?: string;
  revokedAt?: number;
}

/** A token as the profile page shows it: everything but the hash. */
export interface TokenInfo {
  id: string;
  name: string;
  hint: string;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  lastIp: string | null;
  status: 'active' | 'expired' | 'revoked';
}

export type TokenCheck = { ok: true; id: string; user: string; name: string } | { ok: false; reason: 'unknown' | 'expired' | 'revoked' };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class TokenStore {
  private readonly byId = new Map<string, StoredToken>();
  private readonly byHash = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly encKey: Buffer,
  ) {
    this.load();
  }

  /** An unreadable or tampered file simply means nobody holds a token any more: everybody issues a new one. */
  private load(): void {
    try {
      const list = JSON.parse(open(this.encKey, readFileSync(this.file, 'utf8').trim())) as StoredToken[];
      for (const t of list) this.put(t);
    } catch {
      /* no file yet, or unreadable */
    }
  }

  private put(t: StoredToken): void {
    this.byId.set(t.id, t);
    this.byHash.set(t.hash, t.id);
  }

  private forget(t: StoredToken): void {
    this.byId.delete(t.id);
    this.byHash.delete(t.hash);
  }

  /** Serialised, atomic write of all tokens (a few per person). */
  private persist(): Promise<void> {
    const body = seal(this.encKey, JSON.stringify([...this.byId.values()]));
    const run = this.queue.then(async () => {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await writeFile(tmp, body, { mode: 0o600 });
        await rename(tmp, this.file);
      } catch (err) {
        console.error('tokens: could not save:', (err as Error).message);
      }
    });
    this.queue = run;
    return run;
  }

  private statusOf(t: StoredToken, now: number): TokenInfo['status'] {
    return t.revokedAt !== undefined ? 'revoked' : t.expiresAt <= now ? 'expired' : 'active';
  }

  private info(t: StoredToken, now: number): TokenInfo {
    return {
      id: t.id,
      name: t.name,
      hint: t.hint,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
      lastUsedAt: t.lastUsedAt ?? null,
      lastIp: t.lastIp ?? null,
      status: this.statusOf(t, now),
    };
  }

  /** The person's tokens, newest first. */
  list(user: string, now = Date.now()): TokenInfo[] {
    return [...this.byId.values()]
      .filter((t) => t.user === user)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => this.info(t, now));
  }

  /**
   * Issues a token. `days` is 1 to {@link MAX_TOKEN_DAYS} (default: the maximum). The returned `token` is the only time it can be seen.
   */
  async issue(user: string, input: { name?: unknown; days?: unknown }, now = Date.now()): Promise<{ token: string; info: TokenInfo }> {
    const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
    if (!name) throw new TokenError('Give the token a name, for example "Claude Code on my laptop".');
    if (name.length > 60) throw new TokenError('The name may be at most 60 characters.');
    const days = input.days === undefined || input.days === '' ? MAX_TOKEN_DAYS : Number(input.days);
    if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_DAYS) {
      throw new TokenError(`A token is valid for 1 to ${MAX_TOKEN_DAYS} days.`);
    }
    for (const t of [...this.byId.values()]) {
      if (this.statusOf(t, now) !== 'active' && now - Math.max(t.expiresAt, t.revokedAt ?? 0) > KEEP_DEAD_MS) this.forget(t);
    }
    if (this.list(user, now).filter((t) => t.status === 'active').length >= MAX_ACTIVE_TOKENS) {
      throw new TokenError(`You already hold ${MAX_ACTIVE_TOKENS} active tokens. Revoke one first.`);
    }
    const secret = randomBytes(32).toString('base64url');
    const token = `${TOKEN_PREFIX}${secret}`;
    const stored: StoredToken = {
      id: randomUUID(),
      user,
      name,
      hash: sha256(token),
      hint: secret.slice(0, 4),
      createdAt: now,
      expiresAt: now + days * DAY_MS,
    };
    this.put(stored);
    await this.persist();
    return { token, info: this.info(stored, now) };
  }

  /** Revokes one of the person's own tokens; false when there is no such active token of theirs. */
  async revoke(user: string, id: string, now = Date.now()): Promise<boolean> {
    const t = this.byId.get(id);
    if (!t || t.user !== user || t.revokedAt !== undefined) return false;
    t.revokedAt = now;
    await this.persist();
    return true;
  }

  /** Looks a presented token up. A token in use remembers when and from where it was last seen. */
  check(token: string, ip = '', now = Date.now()): TokenCheck {
    const id = this.byHash.get(sha256(token));
    const t = id ? this.byId.get(id) : undefined;
    if (!t) return { ok: false, reason: 'unknown' };
    if (t.revokedAt !== undefined) return { ok: false, reason: 'revoked' };
    if (t.expiresAt <= now) return { ok: false, reason: 'expired' };
    if (t.lastUsedAt === undefined || now - t.lastUsedAt >= TOUCH_EVERY_MS) {
      t.lastUsedAt = now;
      t.lastIp = ip || t.lastIp;
      void this.persist();
    }
    return { ok: true, id: t.id, user: t.user, name: t.name };
  }
}
