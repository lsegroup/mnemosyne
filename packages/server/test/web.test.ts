import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { simpleGit } from 'simple-git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createHttpApp } from '../src/http.js';
import { ProviderStore, ProviderValidationError } from '../src/provider-store.js';
import { MnemosyneService } from '../src/service.js';
import { deriveKeys, open, seal, signToken, verifyToken } from '../src/secrets.js';
import { createWebPortal } from '../src/web.js';

const SECRET = 'a-test-secret-with-enough-length';

describe('secrets', () => {
  const k = deriveKeys(SECRET);

  it('seals and opens, and rejects the wrong key or tampering', () => {
    const sealed = seal(k.enc, 'sk-very-secret');
    expect(sealed).not.toContain('sk-very-secret');
    expect(open(k.enc, sealed)).toBe('sk-very-secret');
    expect(() => open(deriveKeys('another-secret-of-length').enc, sealed)).toThrow();
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => open(k.enc, parts.join('.'))).toThrow();
  });

  it('signs tokens, rejecting tampered, foreign-key and expired ones', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = signToken(k.sign, { u: 'a', exp });
    expect(verifyToken<{ u: string; exp: number }>(k.sign, token)?.u).toBe('a');
    expect(verifyToken(k.sign, `${token}x`)).toBeNull();
    expect(verifyToken(deriveKeys('another-secret-of-length').sign, token)).toBeNull();
    expect(verifyToken(k.sign, signToken(k.sign, { u: 'a', exp: 1 }))).toBeNull();
    expect(verifyToken(k.sign, undefined)).toBeNull();
  });
});

describe('ProviderStore', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mnemosyne-prov-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('stores keys encrypted, never exposes them, and keeps the key on edit', async () => {
    const file = join(dir, 'providers.enc');
    const store = new ProviderStore(file, deriveKeys(SECRET).enc);
    const created = await store.upsert({
      label: 'Meta',
      kind: 'openai-compatible',
      baseUrl: 'https://api.meta.ai/v1/',
      model: 'muse-spark-1.3',
      apiKey: 'meta-key-1234567890',
    });
    expect(created.baseUrl).toBe('https://api.meta.ai/v1');
    expect(created).not.toHaveProperty('apiKey');
    expect(created.keyHint).toBe('••••7890');

    expect(await readFile(file, 'utf8')).not.toContain('meta-key');
    const listed = await store.list();
    expect(listed.activeId).toBe(created.id); // first provider becomes active
    expect(JSON.stringify(listed)).not.toContain('meta-key');

    await store.upsert({ id: created.id, label: 'Meta 2', kind: 'openai-compatible', baseUrl: 'https://api.meta.ai/v1', model: 'm', apiKey: '' });
    expect((await store.getActive())?.apiKey).toBe('meta-key-1234567890');
    expect((await store.getActive())?.label).toBe('Meta 2');
  });

  it('validates input and handles activate / remove', async () => {
    const store = new ProviderStore(join(dir, 'p2.enc'), deriveKeys(SECRET).enc);
    await expect(async () => store.upsert({ label: '', kind: 'openai-compatible', baseUrl: 'https://x', model: 'm' })).rejects.toThrow(ProviderValidationError);
    await expect(async () => store.upsert({ label: 'a', kind: 'weird', baseUrl: 'https://x', model: 'm' })).rejects.toThrow(/kind/);
    await expect(async () => store.upsert({ label: 'a', kind: 'openai-compatible', baseUrl: 'ftp://x', model: 'm' })).rejects.toThrow(/http/);
    const a = await store.upsert({ label: 'a', kind: 'openai-compatible', baseUrl: 'https://a.example', model: 'm', apiKey: 'k' });
    const b = await store.upsert({ label: 'b', kind: 'anthropic-messages', baseUrl: 'https://b.example', model: 'm' });
    await store.activate(b.id);
    expect((await store.list()).activeId).toBe(b.id);
    await store.remove(b.id);
    expect((await store.list()).activeId).toBe(a.id);
    await expect(store.activate('nope')).rejects.toThrow(/unknown/);
  });
});

// --- full portal flow against a fake GitLab ---------------------------------

describe('web portal', () => {
  let tmp: string;
  let fake: Server;
  let portal: Server;
  let portalApp: express.Express;
  let base: string;
  let challenge = '';
  const gitlabUsers: Record<string, object> = {
    'admin-code': { username: 'obecker', name: 'Olaf Becker', email: 'obecker@lumanet.info', state: 'active' },
    'dev-code': { username: 'dev', name: 'Some Dev', email: 'dev@example.com', state: 'active' },
  };

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'mnemosyne-web-'));

    fake = createServer((req: IncomingMessage, res: ServerResponse) => {
      const json = (status: number, body: object) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/oauth/token' && req.method === 'POST') {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const p = new URLSearchParams(raw);
          const code = p.get('code') ?? '';
          const verifierOk = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') === challenge;
          if (p.get('client_secret') !== 'csecret' || !verifierOk || !gitlabUsers[code]) json(400, { error: 'invalid_grant' });
          else json(200, { access_token: code });
        });
      } else if (req.url === '/api/v4/user') {
        const t = (req.headers.authorization ?? '').replace('Bearer ', '');
        if (gitlabUsers[t]) json(200, gitlabUsers[t]!);
        else json(401, { message: '401 Unauthorized' });
      } else json(404, {});
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    const gitlabUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

    portal = createServer((q, s) => portalApp(q, s));
    await new Promise<void>((r) => portal.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;

    const cfg = loadConfig({
      MNEMOSYNE_REPO: tmp,
      MNEMOSYNE_SECRET: SECRET,
      MNEMOSYNE_PUBLIC_URL: origin,
      MNEMOSYNE_GITLAB_URL: gitlabUrl,
      MNEMOSYNE_GITLAB_CLIENT_ID: 'cid',
      MNEMOSYNE_GITLAB_CLIENT_SECRET: 'csecret',
      MNEMOSYNE_ADMIN_USERS: 'Obecker',
    });
    portalApp = express();
    portalApp.use(express.json());
    portalApp.use(cfg.http.basePath, createWebPortal(cfg).router);
    base = `${origin}${cfg.http.basePath}`;
  });

  afterAll(async () => {
    fake?.close();
    portal?.close();
    await rm(tmp, { recursive: true, force: true });
  });

  const cookiesOf = (res: Response) =>
    res.headers.getSetCookie().map((c) => c.split(';')[0]!).filter((c) => !c.endsWith('=')).join('; ');

  /** Runs login -> GitLab -> callback for a fake GitLab user code; returns the callback response. */
  async function signIn(code: string) {
    const login = await fetch(`${base}/auth/login`, { redirect: 'manual' });
    expect(login.status).toBe(302);
    const authorize = new URL(login.headers.get('location')!);
    expect(authorize.pathname).toBe('/oauth/authorize');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('scope')).toBe('read_user');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${base}/auth/callback`);
    challenge = authorize.searchParams.get('code_challenge')!;
    const state = authorize.searchParams.get('state')!;
    const cb = await fetch(`${base}/auth/callback?code=${code}&state=${state}`, {
      redirect: 'manual',
      headers: { cookie: cookiesOf(login) },
    });
    return cb;
  }

  it('shows the dark public login screen without any session', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Sign in with GitLab');
    expect(html).toContain('color-scheme:dark');
    expect(html).toContain('/assets/logo.webp');
    expect(html).toContain('class="net"'); // inline-SVG background (no external assets under the strict CSP)
    expect(html).not.toContain('<script');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("img-src 'self'");
  });

  it('serves the logo publicly as a cacheable WebP', async () => {
    const res = await fetch(`${base}/assets/logo.webp`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('cache-control')).toContain('max-age');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString()).toBe('WEBP');
  });

  it('keeps /admin and its API closed to anonymous visitors', async () => {
    const page = await fetch(`${base}/admin/`, { redirect: 'manual' });
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe(`${new URL(base).pathname}/`);
    expect((await fetch(`${base}/admin/api/providers`)).status).toBe(401);
  });

  it('rejects a callback with a bad or missing state', async () => {
    const res = await fetch(`${base}/auth/callback?code=admin-code&state=forged`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('error=state');
    expect(res.headers.getSetCookie().some((c) => c.startsWith('mnemosyne_session=') && !c.startsWith('mnemosyne_session=;'))).toBe(false);
  });

  it('lets a listed GitLab user into admin and manage providers', async () => {
    const cb = await signIn('admin-code');
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe(`${new URL(base).pathname}/admin/`);
    const cookie = cookiesOf(cb);
    expect(cb.headers.getSetCookie().join(';')).toMatch(/HttpOnly/);

    const page = await fetch(`${base}/admin/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('LLM providers');
    expect(html).toContain('Olaf Becker');
    const nonce = /<script nonce="([^"]+)"/.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(page.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`);

    const headers = { cookie, 'content-type': 'application/json', 'x-requested-with': 'mnemosyne-admin' };
    const created = await fetch(`${base}/admin/api/providers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ label: 'Meta', kind: 'openai-compatible', baseUrl: 'https://api.meta.ai/v1', model: 'muse-spark-1.3', apiKey: 'secret-key-abcdef123456' }),
    });
    expect(created.status).toBe(200);
    const listed = await (await fetch(`${base}/admin/api/providers`, { headers: { cookie } })).text();
    expect(listed).toContain('Meta');
    expect(listed).not.toContain('secret-key-abcdef123456');

    const bad = await fetch(`${base}/admin/api/providers`, { method: 'POST', headers, body: JSON.stringify({ label: '' }) });
    expect(bad.status).toBe(400);
  });

  it('refuses state-changing admin calls that lack the same-origin marker', async () => {
    const cookie = cookiesOf(await signIn('admin-code'));
    const body = JSON.stringify({ label: 'x', kind: 'openai-compatible', baseUrl: 'https://x.example', model: 'm' });
    const noHeader = await fetch(`${base}/admin/api/providers`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body });
    expect(noHeader.status).toBe(403);
    const foreignOrigin = await fetch(`${base}/admin/api/providers`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'mnemosyne-admin', origin: 'https://evil.example' },
      body,
    });
    expect(foreignOrigin.status).toBe(403);
  });

  it('signs in a GitLab user who is not an admin but keeps them out of admin', async () => {
    const cb = await signIn('dev-code');
    expect(cb.headers.get('location')).toBe(`${new URL(base).pathname}/`);
    const cookie = cookiesOf(cb);
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(home).toContain('Some Dev');
    expect(home).toContain('no admin rights');
    expect((await fetch(`${base}/admin/`, { headers: { cookie }, redirect: 'manual' })).status).toBe(302);
    expect((await fetch(`${base}/admin/api/providers`, { headers: { cookie } })).status).toBe(403);
  });

  it('ignores a forged session cookie', async () => {
    const forged = `mnemosyne_session=${encodeURIComponent(Buffer.from(JSON.stringify({ u: 'x', n: 'x', e: '', a: true, exp: 9999999999 })).toString('base64url') + '.AAAA')}`;
    expect((await fetch(`${base}/admin/api/providers`, { headers: { cookie: forged } })).status).toBe(401);
  });

  it('signs out', async () => {
    const out = await fetch(`${base}/auth/logout`, { method: 'POST', redirect: 'manual' });
    expect(out.status).toBe(303);
    expect(out.headers.getSetCookie().join(';')).toContain('mnemosyne_session=;');
  });
});

describe('web portal when not configured', () => {
  it('says so on the login screen and keeps admin closed', async () => {
    const cfg = loadConfig({ MNEMOSYNE_REPO: tmpdir() });
    const app = express();
    app.use(cfg.http.basePath, createWebPortal(cfg).router);
    const srv = await new Promise<Server>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    try {
      const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}${cfg.http.basePath}`;
      const html = await (await fetch(`${base}/`)).text();
      expect(html).toContain('not configured');
      expect(html).not.toContain('Sign in with GitLab');
      expect((await fetch(`${base}/admin/`, { redirect: 'manual' })).status).toBe(302);
      expect((await fetch(`${base}/admin/api/providers`)).status).toBe(401);
    } finally {
      srv.close();
    }
  });
});

describe('MCP/REST stay gated exactly as before', () => {
  let dir: string;
  let svc: MnemosyneService;
  let srv: Server;
  let base: string;

  beforeAll(async () => {
    process.env.MNEMOSYNE_EMBED_BACKEND = 'hash';
    dir = await mkdtemp(join(tmpdir(), 'mnemosyne-webmcp-'));
    const git = simpleGit(dir);
    await git.init();
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'test');
    await git.commit('root', [], { '--allow-empty': null });
    const cfg = loadConfig({ MNEMOSYNE_REPO: dir, MNEMOSYNE_DB: join(dir, '.mnemosyne/index.db'), MNEMOSYNE_BEARER_TOKEN: 'tok', MNEMOSYNE_EMBED_DIM: '256' }, dir);
    svc = await MnemosyneService.open(cfg);
    const app = createHttpApp(cfg, svc);
    await new Promise<void>((r) => {
      srv = app.listen(0, '127.0.0.1', r);
    });
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}${cfg.http.basePath}`;
  });

  afterAll(async () => {
    srv?.close();
    await svc?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the public login page without a bearer but still demands one for REST and MCP', async () => {
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"x"}' })).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});
