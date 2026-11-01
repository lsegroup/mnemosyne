import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { MnemosyneService } from '../src/service.js';
import { createHttpApp } from '../src/http.js';
import { deriveKeys } from '../src/secrets.js';
import { TokenStore } from '../src/token-store.js';

const SECRET = 'a-test-secret-with-enough-length';
const SHARED = 'the-shared-token';
const DAY = 24 * 3600 * 1000;

describe('MCP and REST with personal tokens', () => {
  let dir: string;
  let svc: MnemosyneService;
  const servers: Server[] = [];
  let strict = ''; // MNEMOSYNE_REQUIRE_TOKEN: only tokens get in
  let open = ''; // nothing required: a presented token is still checked
  let shared = ''; // shared token set as well as personal tokens
  let live = '';
  let expired = '';
  let revoked = '';

  const start = async (env: Record<string, string>) => {
    const cfg = loadConfig(
      {
        MNEMOSYNE_REPO: dir,
        MNEMOSYNE_DB: join(dir, '.mnemosyne/index.db'),
        MNEMOSYNE_EMBED_DIM: '256',
        MNEMOSYNE_SECRET: SECRET,
        MNEMOSYNE_PUBLIC_URL: 'http://127.0.0.1:1',
        MNEMOSYNE_TOKENS_FILE: join(dir, 'tokens.enc'),
        ...env,
      },
      dir,
    );
    const app = createHttpApp(cfg, svc);
    const http = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    servers.push(http);
    return `http://127.0.0.1:${(http.address() as AddressInfo).port}${cfg.http.basePath}`;
  };

  beforeAll(async () => {
    process.env.MNEMOSYNE_EMBED_BACKEND = 'hash';
    dir = await mkdtemp(join(tmpdir(), 'mnemosyne-token-auth-'));
    const git = simpleGit(dir);
    await git.init();
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'test');
    await git.commit('root', [], { '--allow-empty': null });
    svc = await MnemosyneService.open(loadConfig({ MNEMOSYNE_REPO: dir, MNEMOSYNE_DB: join(dir, '.mnemosyne/index.db'), MNEMOSYNE_EMBED_DIM: '256' }, dir));
    await svc.createNode({ title: 'A note for the token tests', type: 'howto', status: 'working', project: 'infra', body: 'Reachable only with a valid token.' });

    // the people issue their tokens in the profile; here the same store does it before the servers start
    const store = new TokenStore(join(dir, 'tokens.enc'), deriveKeys(SECRET).enc);
    const now = Date.now();
    live = (await store.issue('dev', { name: 'live' })).token;
    expired = (await store.issue('dev', { name: 'old', days: 1 }, now - 3 * DAY)).token;
    const r = await store.issue('dev', { name: 'revoked' });
    revoked = r.token;
    await store.revoke('dev', r.info.id);

    strict = await start({ MNEMOSYNE_REQUIRE_TOKEN: '1' });
    open = await start({});
    shared = await start({ MNEMOSYNE_BEARER_TOKEN: SHARED });
  });

  afterAll(async () => {
    for (const s of servers) s.close();
    await svc?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const get = async (base: string, token?: string) => {
    const res = await fetch(`${base}/nodes/no-such-node`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: (await res.json()) as { error?: string } };
  };

  it('with MNEMOSYNE_REQUIRE_TOKEN only a valid personal token gets in', async () => {
    expect((await get(strict)).status).toBe(401); // no token
    expect((await get(strict, 'mnm_made-up')).status).toBe(401);
    expect((await get(strict, 'some-other-token')).status).toBe(401);
    expect((await get(strict, live)).status).toBe(404); // let in: it is the node that does not exist
    expect(await get(strict, expired)).toEqual({ status: 401, body: { error: 'token expired' } });
    expect(await get(strict, revoked)).toEqual({ status: 401, body: { error: 'token revoked' } });
  });

  it('the health check stays open and tells nothing', async () => {
    expect((await fetch(`${strict}/health`)).status).toBe(200);
  });

  it('without the switch nothing changes for clients that send no token, but a presented personal token is always checked', async () => {
    expect((await get(open)).status).toBe(404); // as before: no token required
    expect((await get(open, 'whatever-the-client-sends')).status).toBe(404);
    expect((await get(open, live)).status).toBe(404);
    expect(await get(open, expired)).toEqual({ status: 401, body: { error: 'token expired' } }); // an expired token is a signal to rotate, not to be ignored
    expect(await get(open, revoked)).toEqual({ status: 401, body: { error: 'token revoked' } });
  });

  it('a shared token keeps working next to the personal ones', async () => {
    expect((await get(shared)).status).toBe(401);
    expect((await get(shared, 'wrong')).status).toBe(401);
    expect((await get(shared, SHARED)).status).toBe(404);
    expect((await get(shared, live)).status).toBe(404);
    expect((await get(shared, expired)).body.error).toBe('token expired');
  });

  it('an MCP client connects with a personal token and is refused without one', async () => {
    const url = new URL(`${strict}/mcp`);
    await expect(new Client({ name: 't', version: '0' }).connect(new StreamableHTTPClientTransport(url))).rejects.toThrow();
    await expect(
      new Client({ name: 't', version: '0' }).connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${expired}` } } })),
    ).rejects.toThrow();
    const client = new Client({ name: 't', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${live}` } } }));
    const found = await client.callTool({ name: 'search_memory', arguments: { query: 'token tests' } });
    expect(JSON.stringify(found)).toContain('A note for the token tests');
    await client.close();
  });
});
