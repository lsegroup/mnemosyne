import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveKeys } from '../src/secrets.js';
import { MAX_ACTIVE_TOKENS, MAX_TOKEN_DAYS, TOKEN_PREFIX, TokenError, TokenStore } from '../src/token-store.js';

const DAY = 24 * 3600 * 1000;

describe('personal MCP tokens', () => {
  let dir: string;
  let file: string;
  const key = deriveKeys('a-test-secret-with-enough-length').enc;
  const fresh = () => new TokenStore(file, key);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mnemosyne-tokens-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('issues a long random token once, keeps only its hash, and seals the file', async () => {
    file = join(dir, 'issue.enc');
    const store = fresh();
    const { token, info } = await store.issue('dev', { name: '  Claude Code   on my laptop ' });
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(info).toMatchObject({ name: 'Claude Code on my laptop', status: 'active', lastUsedAt: null });
    expect(info.hint).toBe(token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 4));
    // what the profile lists never contains the token or its hash
    expect(JSON.stringify(store.list('dev'))).not.toContain(token);
    expect(Object.keys(store.list('dev')[0]!)).not.toContain('hash');
    // on disk: sealed (no JSON, no token)
    const raw = await readFile(file, 'utf8');
    expect(raw.startsWith('v1.')).toBe(true);
    expect(raw).not.toContain(token);
    // two tokens are never the same
    expect((await store.issue('dev', { name: 'second' })).token).not.toBe(token);
  });

  it('lives at most 90 days: the default is the maximum, anything longer or shorter than a day is refused', async () => {
    file = join(dir, 'days.enc');
    const store = fresh();
    const now = Date.UTC(2026, 10, 1);
    expect((await store.issue('dev', { name: 'a' }, now)).info.expiresAt).toBe(now + MAX_TOKEN_DAYS * DAY);
    expect((await store.issue('dev', { name: 'b', days: 7 }, now)).info.expiresAt).toBe(now + 7 * DAY);
    expect((await store.issue('dev', { name: 'c', days: '30' }, now)).info.expiresAt).toBe(now + 30 * DAY);
    for (const days of [0, -1, 91, 365, 1.5, 'forever', NaN]) {
      await expect(store.issue('dev', { name: 'x', days }, now), String(days)).rejects.toThrow(/valid for 1 to 90 days/);
    }
    await expect(store.issue('dev', { name: '' })).rejects.toThrow(TokenError);
    await expect(store.issue('dev', { name: 'n'.repeat(61) })).rejects.toThrow(/at most 60/);
    await expect(store.issue('dev', {})).rejects.toThrow(/Give the token a name/);
  });

  it('accepts a valid token, names its owner, and refuses unknown, expired and revoked ones with the reason', async () => {
    file = join(dir, 'check.enc');
    const store = fresh();
    const now = Date.UTC(2026, 10, 1);
    const live = await store.issue('dev', { name: 'live', days: 30 }, now);
    const short = await store.issue('dev', { name: 'short', days: 1 }, now);
    const gone = await store.issue('dev', { name: 'gone', days: 30 }, now);

    expect(store.check(live.token, '203.0.113.7', now + DAY / 2)).toMatchObject({ ok: true, user: 'dev', name: 'live' });
    expect(store.check(`${TOKEN_PREFIX}not-a-token`, '', now)).toEqual({ ok: false, reason: 'unknown' });
    expect(store.check(short.token, '', now + DAY / 2)).toMatchObject({ ok: true });
    expect(store.check(short.token, '', now + DAY)).toEqual({ ok: false, reason: 'expired' }); // exactly at the end it is over
    expect(store.list('dev', now + 2 * DAY).find((t) => t.name === 'short')?.status).toBe('expired');

    expect(await store.revoke('dev', gone.info.id, now)).toBe(true);
    expect(store.check(gone.token, '', now)).toEqual({ ok: false, reason: 'revoked' });
    expect(await store.revoke('dev', gone.info.id, now)).toBe(false); // already revoked
  });

  it('remembers when and from where a token was last used, without writing on every call', async () => {
    file = join(dir, 'used.enc');
    const store = fresh();
    const now = Date.UTC(2026, 10, 1);
    const t = await store.issue('dev', { name: 'laptop' }, now);
    expect(store.list('dev', now)[0]).toMatchObject({ lastUsedAt: null, lastIp: null });
    store.check(t.token, '203.0.113.5', now + 1000);
    expect(store.list('dev', now + 2000)[0]).toMatchObject({ lastUsedAt: now + 1000, lastIp: '203.0.113.5' });
    store.check(t.token, '198.51.100.9', now + 2000); // within a minute: not recorded again
    expect(store.list('dev', now + 3000)[0]).toMatchObject({ lastUsedAt: now + 1000, lastIp: '203.0.113.5' });
    store.check(t.token, '198.51.100.9', now + 120_000);
    expect(store.list('dev', now + 130_000)[0]).toMatchObject({ lastUsedAt: now + 120_000, lastIp: '198.51.100.9' });
  });

  it('lets a person revoke only their own tokens and hold at most five active ones', async () => {
    file = join(dir, 'own.enc');
    const store = fresh();
    const mine = await store.issue('dev', { name: 'mine' });
    expect(await store.revoke('other', mine.info.id)).toBe(false);
    expect(store.check(mine.token)).toMatchObject({ ok: true });
    expect(await store.revoke('dev', 'no-such-id')).toBe(false);
    expect(store.list('other')).toEqual([]);

    for (let i = 1; i < MAX_ACTIVE_TOKENS; i++) await store.issue('dev', { name: `t${i}` });
    await expect(store.issue('dev', { name: 'one too many' })).rejects.toThrow(/already hold 5 active tokens/);
    await store.issue('other', { name: 'someone else is not limited by dev' });
    expect(await store.revoke('dev', mine.info.id)).toBe(true);
    await store.issue('dev', { name: 'room again' }); // revoking made room
  });

  it('survives a restart, and forgets tokens that have been dead for more than 30 days', async () => {
    file = join(dir, 'restart.enc');
    const first = fresh();
    const t0 = Date.UTC(2026, 0, 1);
    const old = await first.issue('dev', { name: 'old', days: 1 }, t0);
    const kept = await first.issue('dev', { name: 'kept' }, t0);

    const again = fresh(); // a new process reads the sealed file
    expect(again.check(kept.token, '', t0 + DAY)).toMatchObject({ ok: true, user: 'dev' });
    expect(again.list('dev', t0 + 5 * DAY).map((t) => t.name).sort()).toEqual(['kept', 'old']);

    const later = t0 + 60 * DAY; // 'old' ended 59 days ago
    await again.issue('dev', { name: 'new' }, later);
    expect(again.list('dev', later).map((t) => t.name).sort()).toEqual(['kept', 'new']);
    expect(again.check(old.token, '', later)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('starts empty when the file is unreadable or sealed with another key', async () => {
    file = join(dir, 'foreign.enc');
    const foreign = new TokenStore(file, deriveKeys('another-secret-with-enough-length').enc);
    await foreign.issue('dev', { name: 'theirs' });
    expect(fresh().list('dev')).toEqual([]);
  });
});
