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

let dir: string;
let svc: MnemosyneService;
let http: Server;
let baseUrl: string;
const TOKEN = 'test-token';

beforeAll(async () => {
  process.env.MNEMOSYNE_EMBED_BACKEND = 'hash';
  dir = await mkdtemp(join(tmpdir(), 'mnemosyne-mcp-'));
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'test');
  await git.commit('root', [], { '--allow-empty': null });

  const cfg = loadConfig(
    { MNEMOSYNE_REPO: dir, MNEMOSYNE_DB: join(dir, '.mnemosyne/index.db'), MNEMOSYNE_BEARER_TOKEN: TOKEN, MNEMOSYNE_EMBED_DIM: '256' },
    dir,
  );
  svc = await MnemosyneService.open(cfg);
  await svc.createNode({
    title: 'Redis cluster needs the -c flag or ZADD hits CROSSSLOT',
    type: 'gotcha',
    status: 'resolved',
    project: 'infra',
    body: 'A non-cluster redis client silently issued cross-slot multi-key writes; add -c / use a cluster client.',
  });

  const app = createHttpApp(cfg, svc);
  await new Promise<void>((resolve) => {
    http = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => {
  http?.close();
  await svc?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('MCP over Streamable HTTP', () => {
  it('rejects a client with no bearer token', async () => {
    const client = new Client({ name: 't', version: '0' });
    await expect(
      client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`))),
    ).rejects.toThrow();
  });

  it('lists all nine tools and runs search_memory', async () => {
    const client = new Client({ name: 't', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    );

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'create_node',
        'get_node',
        'get_node_history',
        'link_node_to_code',
        'link_nodes',
        'neighbors',
        'reindex',
        'search_memory',
        'update_node',
      ].sort(),
    );

    const res = await client.callTool({
      name: 'search_memory',
      arguments: { query: 'redis crossslot', mode: 'text' },
    });
    const rows = JSON.parse((res.content as { type: string; text: string }[])[0]!.text);
    expect(rows[0].project).toBe('infra');

    await client.close();
  });

  it('serves REST /health without auth and /search with auth', async () => {
    const health = await (await fetch(`${baseUrl}/health`)).json();
    expect(health.ok).toBe(true);

    const unauth = await fetch(`${baseUrl}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'redis' }),
    });
    expect(unauth.status).toBe(401);

    const ok = await fetch(`${baseUrl}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ query: 'crossslot', mode: 'text' }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json())[0].id).toContain('infra-');
  });
});
