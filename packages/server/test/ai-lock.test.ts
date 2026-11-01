import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiLockFile, aiLockHeldBy, holdAiLock, releaseAiLock } from '../src/ai-lock.js';

describe('the lock that lets this server and the separate admin program share the one AI job', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mnemosyne-ailock-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('holds, is seen as somebody else\'s lock, and is released only by its holder', async () => {
    const file = aiLockFile(dir);
    expect(aiLockHeldBy(file, 'auto')).toBe(false);
    holdAiLock(file, 'person');
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ by: 'person' });
    expect(aiLockHeldBy(file, 'person')).toBe(true);
    expect(aiLockHeldBy(file, 'auto')).toBe(false);
    releaseAiLock(file, 'auto'); // not the holder: nothing happens
    expect(aiLockHeldBy(file, 'person')).toBe(true);
    releaseAiLock(file, 'person');
    expect(aiLockHeldBy(file, 'person')).toBe(false);
  });

  it('forgets a lock that is more than three hours old, so a crash never blocks the AI for good', () => {
    const file = aiLockFile(dir);
    const then = Date.now() - 4 * 3600 * 1000;
    holdAiLock(file, 'auto', then);
    expect(aiLockHeldBy(file, 'auto', then + 3600 * 1000)).toBe(true);
    expect(aiLockHeldBy(file, 'auto')).toBe(false);
    releaseAiLock(file, 'auto');
  });

  it('ignores a file that is not a lock', async () => {
    const file = aiLockFile(dir);
    await writeFile(file, 'not json');
    expect(aiLockHeldBy(file, 'auto')).toBe(false);
    releaseAiLock(file, 'auto');
    await writeFile(file, JSON.stringify({ by: 'auto' })); // no time stamp
    expect(aiLockHeldBy(file, 'auto')).toBe(false);
    await rm(file, { force: true });
  });
});
