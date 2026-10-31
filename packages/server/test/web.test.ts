import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { Script, createContext } from 'node:vm';
import { join } from 'node:path';
import express from 'express';
import { simpleGit } from 'simple-git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createHttpApp } from '../src/http.js';
import { ProviderStore, ProviderValidationError } from '../src/provider-store.js';
import { modelsUrl, parseModelIds } from '../src/llm-models.js';
import { MnemosyneService } from '../src/service.js';
import { deriveKeys, hashPassword, open, seal, signToken, verifyPassword, verifyToken } from '../src/secrets.js';
import { SettingsStore } from '../src/settings-store.js';
import { createWebPortal } from '../src/web.js';
import { adminPage } from '../src/web-pages.js';
import { renderMarkdown } from '../src/markdown.js';
import { matchProject, redact } from '../src/docs.js';

const SECRET = 'a-test-secret-with-enough-length';
// Fake credentials for the masking tests, assembled at runtime so no credential-shaped text sits in the source
// (the public GitHub mirror scans every commit for such text and refuses to push if it finds any).
const FAKE_TOKEN = ['glpat', 'abcdefghijklmnopqrstuvwx'].join('-');
const FAKE_AWS = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const FAKE_PEM_BEGIN = '-----BEGIN RSA ' + 'PRIVATE KEY-----';
const FAKE_PEM_END = '-----END RSA ' + 'PRIVATE KEY-----';

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

  const input = { label: 'Meta', kind: 'openai-compatible', baseUrl: 'https://api.meta.ai/v1/', apiKey: 'meta-key-1234567890' };

  it('stores keys encrypted, never exposes them, keeps the key on edit', async () => {
    const file = join(dir, 'providers.enc');
    const store = new ProviderStore(file, deriveKeys(SECRET).enc);
    const created = await store.upsert(input);
    expect(created.baseUrl).toBe('https://api.meta.ai/v1');
    expect(created).not.toHaveProperty('apiKey');
    expect(created.keyHint).toBe('••••7890');
    expect(created.models).toEqual([]);

    expect(await readFile(file, 'utf8')).not.toContain('meta-key');
    expect(JSON.stringify(await store.list())).not.toContain('meta-key');

    await store.upsert({ id: created.id, ...input, label: 'Meta 2', apiKey: '' });
    expect((await store.getFull(created.id)).apiKey).toBe('meta-key-1234567890');
    expect((await store.getFull(created.id)).label).toBe('Meta 2');
  });

  it('validates input', async () => {
    const store = new ProviderStore(join(dir, 'p2.enc'), deriveKeys(SECRET).enc);
    await expect(async () => store.upsert({ ...input, label: '' })).rejects.toThrow(ProviderValidationError);
    await expect(async () => store.upsert({ ...input, kind: 'weird' })).rejects.toThrow(/format/);
    await expect(async () => store.upsert({ ...input, baseUrl: 'ftp://x' })).rejects.toThrow(/http/);
    await expect(async () => store.upsert({ ...input, apiKey: '' })).rejects.toThrow(/key is required/);
  });

  it('assigns one model per job, only from the models the provider reported', async () => {
    const store = new ProviderStore(join(dir, 'p3.enc'), deriveKeys(SECRET).enc);
    const a = await store.upsert(input);
    const b = await store.upsert({ ...input, label: 'Other', baseUrl: 'https://b.example/v1', apiKey: 'other-key-1234567890' });
    await expect(store.setAssignments({ text: { providerId: a.id, model: 'm1' } })).rejects.toThrow(/not one of the models/); // nothing fetched yet
    await store.setModels(a.id, ['m1', 'img-1']);
    await store.setModels(b.id, ['b1']);

    await store.setAssignments({ text: { providerId: a.id, model: 'm1' }, image: { providerId: a.id, model: 'img-1' }, pdf: { providerId: b.id, model: 'b1' } });
    expect((await store.list()).assignments).toEqual({
      text: { providerId: a.id, model: 'm1' },
      image: { providerId: a.id, model: 'img-1' },
      pdf: { providerId: b.id, model: 'b1' },
    });
    expect((await store.getAssigned('image'))?.model).toBe('img-1');
    await expect(store.setAssignments({ text: { providerId: 'nope', model: 'x' } })).rejects.toThrow(/unknown provider/);

    // a refreshed list that no longer offers a chosen model clears that choice only
    await store.setModels(a.id, ['m1']);
    expect(Object.keys((await store.list()).assignments).sort()).toEqual(['pdf', 'text']);

    // a new key or endpoint forgets the models and the choices made from them
    await store.upsert({ id: a.id, ...input, apiKey: 'a-different-key-123456' });
    const after = await store.list();
    expect(after.providers.find((p) => p.id === a.id)!.models).toEqual([]);
    expect(after.assignments.text).toBeUndefined();
    expect(after.assignments.pdf?.providerId).toBe(b.id);

    await store.remove(b.id);
    expect((await store.list()).assignments).toEqual({});
  });

  it('still reads the first-generation file (one model per provider + one active provider)', async () => {
    const file = join(dir, 'legacy.enc');
    const keys = deriveKeys(SECRET);
    await writeFile(
      file,
      seal(keys.enc, JSON.stringify({ providers: [{ id: 'old', label: 'Old', kind: 'openai-compatible', baseUrl: 'https://o.example/v1', model: 'gpt-x', apiKey: 'k-1234567890abc' }], activeId: 'old' })),
    );
    const listed = await new ProviderStore(file, keys.enc).list();
    expect(listed.providers[0]!.models).toEqual(['gpt-x']);
    expect(listed.assignments.text).toEqual({ providerId: 'old', model: 'gpt-x' });
  });
});

describe('model discovery', () => {
  it('knows where each API format keeps its model list and parses the common shapes', () => {
    expect(modelsUrl({ kind: 'openai-compatible', baseUrl: 'https://api.meta.ai/v1/' })).toBe('https://api.meta.ai/v1/models');
    expect(modelsUrl({ kind: 'anthropic-messages', baseUrl: 'https://api.meta.ai' })).toBe('https://api.meta.ai/v1/models');
    expect(modelsUrl({ kind: 'anthropic-messages', baseUrl: 'https://x.example/v1' })).toBe('https://x.example/v1/models');
    expect(parseModelIds({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] })).toEqual(['a', 'b']);
    expect(parseModelIds({ models: [{ name: 'models/gem-1' }] })).toEqual(['gem-1']);
    expect(parseModelIds(['x', 'y'])).toEqual(['x', 'y']);
    expect(parseModelIds({ nothing: true })).toEqual([]);
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
    'admin-code': { username: 'store', name: 'Store Admin', email: 'store@lumanet.info', state: 'active', is_admin: true },
    'dev-code': { username: 'dev', name: 'Some Dev', email: 'dev@example.com', state: 'active' },
    'scope-code': { username: 'noscope', name: 'No Scope', email: 'ns@example.com', state: 'active' },
  };

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'mnemosyne-web-'));
    const note = (project: string, id: string, title: string, body: string) =>
      mkdir(join(tmp, 'nodes', project), { recursive: true }).then(() =>
        writeFile(join(tmp, 'nodes', project, `${id}.md`), `---\nid: ${id}\ntitle: ${title}\ntype: howto\nstatus: working\nproject: ${project}\ncomponents: [web]\nlinks:\n  - rel: relates-to\n    target: alpha-second\nobserved_at: 2026-10-20\n---\n\n${body}\n`),
      );
    await note('alpha', 'alpha-first', 'Alpha first note', '## Setup\n\nRun `make` then **deploy**.\n\n<script>alert(1)</script>\n\n[ok](https://example.com) [bad](javascript:alert(1))\n\npassword: hunter2-secret-value\n\ntoken ' + FAKE_TOKEN + '\n');
    await note('alpha', 'alpha-second', 'Alpha second note', 'Second.');
    await note('beta', 'beta-first', 'Beta private note', 'Only beta members.');
    await note('lse', 'lse-first', 'Catch-all note', 'No single GitLab project.');

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
          if (p.get('grant_type') === 'refresh_token') {
            const rt = p.get('refresh_token') ?? '';
            if (p.get('client_secret') !== 'csecret' || !gitlabUsers[rt]) json(400, { error: 'invalid_grant' });
            else json(200, { access_token: rt, refresh_token: rt });
          } else if (p.get('client_secret') !== 'csecret' || !verifierOk || !gitlabUsers[code]) json(400, { error: 'invalid_grant' });
          else json(200, { access_token: code, refresh_token: code });
        });
      } else if (req.url?.startsWith('/api/v4/projects')) {
        const t = (req.headers.authorization ?? '').replace('Bearer ', '');
        if (t === 'scope-code') json(403, { message: '403 Forbidden - insufficient_scope' });
        else if (!gitlabUsers[t]) json(401, { message: '401 Unauthorized' });
        else
          json(
            200,
            t === 'dev-code'
              ? [{ id: 1, name: 'Alpha', path: 'alpha', path_with_namespace: 'grp/alpha', web_url: 'https://gl.example/grp/alpha' },
                  { id: 2, name: 'Zeta', path: 'zeta', path_with_namespace: 'grp/zeta', web_url: 'https://gl.example/grp/zeta' }]
              : [],
          );
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
      MNEMOSYNE_AI_DAILY_LIMIT: '3',
    });
    webCfg = cfg;
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

  let webCfg: ReturnType<typeof loadConfig>;

  const cookiesOf = (res: Response) =>
    res.headers.getSetCookie().map((c) => c.split(';')[0]!).filter((c) => !c.endsWith('=')).join('; ');

  /** Runs login -> GitLab -> callback for a fake GitLab user code; returns the callback response. */
  async function signIn(code: string, prefix = '') {
    const login = await fetch(`${base}${prefix}/auth/login`, { redirect: 'manual' });
    expect(login.status).toBe(302);
    const authorize = new URL(login.headers.get('location')!);
    expect(authorize.pathname).toBe('/oauth/authorize');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('scope')).toBe(prefix === '/admin' ? 'read_user' : 'read_user read_api'); // admin asks only who you are; public also reads your GitLab projects
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${base}${prefix}/auth/callback`);
    challenge = authorize.searchParams.get('code_challenge')!;
    const state = authorize.searchParams.get('state')!;
    const cb = await fetch(`${base}${prefix}/auth/callback?code=${code}&state=${state}`, {
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
    expect(page.status).toBe(200); // the admin has its own sign-in page, no redirect to the public one
    const html = await page.text();
    expect(html).toContain('Administration');
    expect(html).not.toContain('id="tab-llm"');
    expect((await fetch(`${base}/admin/api/providers`)).status).toBe(401);
  });

  it('admin page GitLab link starts the ADMIN flow (own login route and callback)', async () => {
    const html = await (await fetch(`${base}/admin/`)).text();
    const href = /<a class="btn[^"]*" href="([^"]+)">Sign in with GitLab/.exec(html)?.[1];
    expect(href).toBe(`${new URL(base).pathname}/admin/auth/login`);
    const res = await fetch(new URL(href!, base), { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('redirect_uri')).toBe(`${base}/admin/auth/callback`);
  });

  it('rejects a callback with a bad or missing state', async () => {
    const res = await fetch(`${base}/auth/callback?code=admin-code&state=forged`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('error=state');
    expect(res.headers.getSetCookie().some((c) => c.startsWith('mnemosyne_session=') && !c.startsWith('mnemosyne_session=;'))).toBe(false);
  });

  it('lets a listed GitLab user into admin: menu, connect a provider, fetch its real models, choose per job', async () => {
    const cb = await signIn('admin-code', '/admin');
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe(`${new URL(base).pathname}/admin/`);
    const cookie = cookiesOf(cb);
    expect(cb.headers.getSetCookie().join(';')).toMatch(/mnemosyne_admin=.*HttpOnly.*Path=\/mnemosyne\/admin/);

    const page = await fetch(`${base}/admin/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('id="tab-llm"');
    expect(html).toContain('data-tab="llm"'); // left menu: LLM
    expect(html).toContain('data-tab="sso"'); // left menu: SSO
    expect(html).toContain('Choose the model and settings for each job');
    expect(html).toContain('--title:#8473de'); // login palette: purple main titles
    expect(html).toContain('--teal:#3cc4cc'); // turquoise second-level titles
    expect(html).toContain('Store Admin');
    const nonce = /<script nonce="([^"]+)"/.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(page.headers.get('content-security-policy')).toContain(`'nonce-${nonce}'`);

    // a fake provider whose model list depends on the key
    const llm = createServer((req, res) => {
      const ok = req.headers.authorization === 'Bearer good-key-1234567890';
      res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { data: [{ id: 'muse-spark-1.3' }, { id: 'muse-image-1.0' }, { id: 'muse-wonder-1.0' }] } : { error: 'no' }));
    });
    await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
    try {
      const llmBase = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
      const headers = { cookie, 'content-type': 'application/json', 'x-requested-with': 'mnemosyne-admin' };
      const post = (path: string, body: object, method = 'POST') => fetch(`${base}/admin/api${path}`, { method, headers, body: JSON.stringify(body) });

      // step 1: connect (key stored, never shown again)
      const created = await (await post('/providers', { label: 'Meta', kind: 'openai-compatible', baseUrl: llmBase, apiKey: 'good-key-1234567890' })).json();
      expect(created.models).toEqual([]);
      const listed = await (await fetch(`${base}/admin/api/providers`, { headers: { cookie } })).text();
      expect(listed).toContain('Meta');
      expect(listed).not.toContain('good-key-1234567890');

      // step 3 before step 2 is refused: nothing has been fetched yet
      expect((await post('/llm/assignments', { text: { providerId: created.id, model: 'muse-spark-1.3' } }, 'PUT')).status).toBe(400);

      // step 2: fetch what the key can really use
      const pulled = await (await post(`/providers/${created.id}/models`, {})).json();
      expect(pulled.models).toEqual(['muse-image-1.0', 'muse-spark-1.3', 'muse-wonder-1.0']);
      expect(JSON.stringify(pulled)).not.toContain('good-key');

      // step 3: one model per job; a model the provider did not report is refused
      const ok = await post('/llm/assignments', { text: { providerId: created.id, model: 'muse-spark-1.3' }, image: { providerId: created.id, model: 'muse-image-1.0' }, pdf: { providerId: created.id, model: 'muse-wonder-1.0' } }, 'PUT');
      expect(ok.status).toBe(200);
      expect((await post('/llm/assignments', { text: { providerId: created.id, model: 'made-up' } }, 'PUT')).status).toBe(400);
      const after = await (await fetch(`${base}/admin/api/providers`, { headers: { cookie } })).json();
      expect(after.assignments.image).toEqual({ providerId: created.id, model: 'muse-image-1.0' });

      // a provider that rejects the key is reported without leaking it
      const bad = await (await post('/providers', { label: 'Bad', kind: 'openai-compatible', baseUrl: llmBase, apiKey: 'wrong-key-0987654321' })).json();
      const rejected = await post(`/providers/${bad.id}/models`, {});
      expect(rejected.status).toBe(400);
      const err = await rejected.text();
      expect(err).toContain('rejected the API key');
      expect(err).not.toContain('wrong-key');

      const missing = await post('/providers', { label: '' });
      expect(missing.status).toBe(400);
    } finally {
      llm.close();
    }
  });

  it('refuses state-changing admin calls that lack the same-origin marker', async () => {
    const cookie = cookiesOf(await signIn('admin-code', '/admin'));
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

  it('shows a member only the projects they belong to in GitLab, and refuses the rest', async () => {
    const cb = await signIn('dev-code');
    const cookie = cookiesOf(cb);
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(home).toContain('Your projects');
    expect(home).toContain('grp/alpha'); // matched by name to the GitLab project the user belongs to
    expect(home).not.toContain('Beta');
    expect(home).not.toContain('beta');
    expect(home).not.toContain('Catch-all');

    const project = await fetch(`${base}/p/alpha`, { headers: { cookie } });
    expect(project.status).toBe(200);
    expect(project.headers.get('content-security-policy')).toContain("script-src 'nonce-");
    const blank = await project.text();
    expect(blank).toContain('No documentation has been generated yet'); // default blank page
    expect(blank).not.toContain('Alpha first note'); // raw notes are not shown to members
    expect(blank).not.toContain('data-ai='); // members cannot start AI generation
    expect(blank).toContain('id="pdfBtn" disabled'); // PDF button inactive until a document exists
    for (const path of ['/p/alpha/notes', '/p/alpha/alpha-first']) expect((await fetch(`${base}${path}`, { headers: { cookie } })).status, path).toBe(404);

    // a project the user does not belong to, and the catch-all, look exactly like a missing page
    for (const path of ['/p/beta', '/p/lse', '/p/beta/beta-first', '/p/lse/lse-first', '/p/alpha/beta-first', '/p/nope']) {
      const r = await fetch(`${base}${path}`, { headers: { cookie } });
      expect(r.status, path).toBe(404);
      expect(await r.text()).not.toContain('Beta private note');
    }
    // not signed in: back to the login page, never content
    expect((await fetch(`${base}/p/alpha`, { redirect: 'manual' })).status).toBe(302);
  });

  it('renders source notes (administrators only) safely: no script, no javascript: links, credentials masked', async () => {
    const cookie = cookiesOf(await signIn('admin-code'));
    const html = await (await fetch(`${base}/p/alpha/alpha-first`, { headers: { cookie } })).text();
    expect(html).toContain('<h3 id="h-setup">Setup</h3>');
    expect(html).toContain('<code>make</code>');
    expect(html).toContain('<strong>deploy</strong>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('hunter2-secret-value');
    expect(html).not.toContain(FAKE_TOKEN);
    expect(html).toContain('[redacted');
    expect(html).toContain('Alpha second note'); // related note, linked
  });

  it('lets a GitLab administrator see every project, marking those with no GitLab project', async () => {
    const cookie = cookiesOf(await signIn('admin-code'));
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    for (const name of ['alpha', 'beta', 'lse']) expect(home).toContain(`/p/${name}`);
    expect(home).toContain('administrators only');
    expect((await fetch(`${base}/p/lse/lse-first`, { headers: { cookie } })).status).toBe(200);
  });

  it('fails closed when GitLab does not share the project list (missing read_api scope)', async () => {
    const cookie = cookiesOf(await signIn('scope-code'));
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(home).toContain('read_api');
    expect(home).not.toContain('/p/alpha');
    expect((await fetch(`${base}/p/alpha`, { headers: { cookie } })).status).toBe(404);
  });

  describe('AI documentation (agreement, spending guards, PDF)', () => {
    let llm: Server;
    let llmBase = '';
    const calls = { chat: 0, image: 0, briefMax: 0, limits: [] as number[], lastChat: null as null | { max_tokens?: number; max_completion_tokens?: number; temperature?: number; top_p?: number; messages: { role: string; content: string }[] } };
    const dropped = { once: false };
    // what the fake text model answers when asked for a diagram plan (the label holds characters that must be escaped in the SVG)
    const DIAGRAM_PLAN = {
      title: 'Alpha',
      diagrams: [
        {
          name: 'Overview',
          columns: [
            { title: 'Clients', nodes: [{ id: 'u', label: 'Browser', detail: 'people', lane: 'path' }] },
            { title: 'Service', nodes: [{ id: 's', label: 'Notes <service> & "index"', detail: 'HTTP :40000', lane: 'path' }, { id: 'g', label: 'GitLab SSO', detail: 'OAuth 2 + PKCE', lane: 'control' }] },
          ],
          links: [{ from: 'u', to: 's', label: 'HTTPS' }, { from: 's', to: 'g', label: 'sign in' }],
        },
        {
          name: 'Sign-in and security',
          columns: [
            { title: 'Service', nodes: [{ id: 'w', label: 'Web portal', detail: 'cookies', lane: 'path' }] },
            { title: 'Identity', nodes: [{ id: 'i', label: 'GitLab OAuth', detail: 'code + PKCE', lane: 'path' }] },
          ],
          links: [{ from: 'w', to: 'i', label: 'authorize' }],
        },
      ],
    };
    let png: Buffer;

    beforeAll(async () => {
      const sharp = (await import('sharp')).default;
      png = await sharp({ create: { width: 64, height: 40, channels: 3, background: '#7a66e0' } }).png().toBuffer();
      llm = createServer((req, res) => {
        const reply = (body: object) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          if (req.headers.authorization !== 'Bearer llm-key-1234567890') {
            res.writeHead(401);
            res.end('{}');
          } else if (req.url === '/v1/chat/completions' && raw.includes('LIMIT-TEST')) {
            const b = JSON.parse(raw) as { max_tokens?: number; max_completion_tokens?: number };
            const asked = b.max_tokens ?? b.max_completion_tokens ?? 0;
            calls.limits.push(asked);
            if (asked > 16000) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { message: 'max_tokens is too large: this model supports at most 16000 output tokens' } }));
            } else reply({ choices: [{ message: { content: 'ok within the model limit' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } });
          } else if (req.url === '/v1/chat/completions' && raw.includes('DROP-ALWAYS')) {
            req.socket.destroy(); // connection reset, every time
          } else if (req.url === '/v1/chat/completions' && raw.includes('DROP-ONCE') && !dropped.once) {
            dropped.once = true;
            req.socket.destroy(); // connection reset on the first try only
          } else if (req.url === '/v1/chat/completions') {
            calls.chat++;
            calls.lastChat = JSON.parse(raw);
            const wantsBrief = /solutions architect/i.test(raw); // the diagram plan request
            if (wantsBrief) {
              const b = JSON.parse(raw) as { max_tokens?: number; max_completion_tokens?: number };
              calls.briefMax = b.max_tokens ?? b.max_completion_tokens ?? 0;
            }
            if (raw.includes('EMPTY-REASONING')) {
              reply({ choices: [{ message: { content: '', reasoning_content: 'thinking...' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 700 } });
              return;
            }
            reply({
              choices: [{ message: { content: wantsBrief ? JSON.stringify(DIAGRAM_PLAN) : '# Alpha\n\nAlpha is a test project.\n\n## Overview\n\nIt does **things**.\n\n## History\n\n- first\n- second\n\n## Known issues\n\nNone documented.' } }],
              usage: { prompt_tokens: 1200, completion_tokens: 300 },
            });
          } else if (req.url === '/v1/images/generations') {
            calls.image++;
            reply({ data: [{ b64_json: png.toString('base64') }] });
          } else {
            res.writeHead(404);
            res.end('{}');
          }
        });
      });
      await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
      llmBase = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
    });
    afterAll(() => llm?.close());

    const hdr = (cookie: string) => ({ cookie, 'content-type': 'application/json', 'x-requested-with': 'mnemosyne-docs', origin: base.replace(/\/mnemosyne$/, '') });
    const api = (cookie: string, path: string, method = 'GET', body?: object) =>
      fetch(`${base}/p/alpha/api${path}`, { method, headers: hdr(cookie), body: body ? JSON.stringify(body) : undefined });
    const waitIdle = async (cookie: string) => {
      for (let i = 0; i < 60; i++) {
        const st = await (await api(cookie, '/status')).json();
        if (st.state !== 'running') return st;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('job did not finish');
    };

    it('needs models chosen first, and members cannot start anything', async () => {
      const admin = cookiesOf(await signIn('admin-code'));
      const store = new ProviderStore(join(tmp, '.mnemosyne', 'providers.enc'), deriveKeys(SECRET).enc);
      await store.setAssignments({}); // earlier tests chose models; start from "nothing chosen"
      const est = await api(admin, '/estimate?kind=wiki');
      expect(est.status).toBe(400);
      expect((await est.json()).error).toContain('Choose a model for Text');

      const prov = await store.upsert({ label: 'Fake AI', kind: 'openai-compatible', baseUrl: llmBase, apiKey: 'llm-key-1234567890' });
      await store.setModels(prov.id, ['text-model', 'image-model']);
      await store.setAssignments({ text: { providerId: prov.id, model: 'text-model' }, image: { providerId: prov.id, model: 'image-model' } });

      const dev = cookiesOf(await signIn('dev-code'));
      expect((await api(dev, '/estimate?kind=wiki')).status).toBe(404); // admin-only: looks like a missing page
      expect((await api(dev, '/generate', 'POST', { kind: 'wiki', token: 'x' })).status).toBe(404);
      expect(calls.chat + calls.image).toBe(0);
    });

    it('never calls the AI without a valid agreement; a used or foreign agreement is refused', async () => {
      const admin = cookiesOf(await signIn('admin-code'));
      // no token / garbage token
      for (const token of [undefined, 'garbage', 'a.b']) {
        const r = await api(admin, '/generate', 'POST', { kind: 'wiki', token });
        expect(r.status).toBe(403);
      }
      expect(calls.chat).toBe(0);

      // the estimate shows model + size + cost and carries the one-time token
      const est = await (await api(admin, '/estimate?kind=wiki')).json();
      expect(est.what).toContain('costs'.slice(0, 0) + 'Fake AI');
      expect(est.facts.map((f: string[]) => f[0])).toEqual(expect.arrayContaining(['Provider', 'Model', 'Notes sent', 'Size', 'Estimated cost']));
      expect(typeof est.token).toBe('string');

      // a token made for a different kind does not authorise this one
      expect((await api(admin, '/generate', 'POST', { kind: 'diagram', token: est.token })).status).toBe(403);
      expect(calls.chat).toBe(0);

      // a valid agreement starts exactly one run ...
      const ok = await api(admin, '/generate', 'POST', { kind: 'wiki', token: est.token });
      expect(ok.status).toBe(202);
      expect((await waitIdle(admin)).state).toBe('done');
      expect(calls.chat).toBe(1);
      // ... and cannot be replayed
      expect((await api(admin, '/generate', 'POST', { kind: 'wiki', token: est.token })).status).toBe(403);
      expect(calls.chat).toBe(1);

      // cross-site calls are refused outright
      const evil = await fetch(`${base}/p/alpha/api/generate`, { method: 'POST', headers: { ...hdr(admin), origin: 'https://evil.example' }, body: JSON.stringify({ kind: 'wiki', token: est.token }) });
      expect(evil.status).toBe(403);
    });

    it('shows the article with its date stamp, then the diagram, and the PDF button becomes active', async () => {
      const admin = cookiesOf(await signIn('admin-code'));
      const page = await (await fetch(`${base}/p/alpha`, { headers: { cookie: admin } })).text();
      expect(page).toContain('Alpha is a test project');
      expect(page).toMatch(/generated <b>\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC<\/b>/);
      expect(page).toContain('Fake AI / text-model');
      expect(page).not.toContain('id="pdfBtn" disabled'); // active now
      expect(page).toContain('Regenerate documentation');

      // workflow diagram: ONE text call writes the plan, Mnemosyne draws it itself (no image model), only after agreement
      const est = await (await api(admin, '/estimate?kind=diagram')).json();
      expect(est.facts.map((f: string[]) => f[0])).toEqual(expect.arrayContaining(['Text model', 'Estimated cost']));
      expect(est.facts.map((f: string[]) => f[0])).not.toContain('Image model');
      expect(est.what).toContain('No image model is used');
      expect((await api(admin, '/generate', 'POST', { kind: 'diagram', token: est.token })).status).toBe(202);
      expect((await waitIdle(admin)).state).toBe('done');
      expect(calls.image).toBe(0);
      const after = await (await fetch(`${base}/p/alpha`, { headers: { cookie: admin } })).text();
      const src = /<img src="([^"]+)" alt="Workflow diagram/.exec(after)?.[1];
      expect(src).toContain('/p/alpha/diagram/');
      expect(after).toContain('by Mnemosyne, planned by Fake AI / text-model');
      const img = await fetch(`${new URL(base).origin}${src}`, { headers: { cookie: admin } });
      expect(img.headers.get('content-type')).toBe('image/svg+xml');
      expect(img.headers.get('content-security-policy')).toContain('sandbox');
      const svg = await img.text();
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toContain('>GitLab SSO<'); // spelled exactly as in the plan
      expect(svg).toContain('Notes &lt;service&gt; &amp; &quot;index&quot;'); // escaped, never markup
      expect(svg).not.toContain('<script');

      // a second, detail picture: thumbnail under the overview in the card, drawn on request, its own page in the PDF
      const detail = /<a class="pic sub" href="([^"]+\/diagram\/\d{8}T\d{6}Z\/1)"/.exec(after)?.[1];
      expect(detail).toBeTruthy();
      expect(after).toContain('Detail pictures · click to enlarge');
      // Wikipedia layout (owner demand 2026-10-31): ONE scrollbar - the info box floats at the top right and the text flows around it;
      // no sticky column, no height cap, no inner scrolling
      expect(after).toContain('.side{float:right;width:310px;');
      expect(after).not.toMatch(/\.side\{[^}]*(position:sticky|max-height|overflow)/);
      expect(after).toContain('.wp article{display:flow-root}'); // the article card contains the float
      expect(after).toContain('<span>Sign-in and security</span>');
      const dres = await fetch(`${new URL(base).origin}${detail}`, { headers: { cookie: admin } });
      expect(dres.status).toBe(200);
      expect(dres.headers.get('content-type')).toBe('image/svg+xml');
      const dsvg = await dres.text();
      expect(dsvg).toContain('>GitLab OAuth<');
      expect(dsvg).toContain('Alpha - Sign-in and security'); // the title names the topic
      expect((await fetch(`${new URL(base).origin}${detail!.replace(/\/1$/, '/2')}`, { headers: { cookie: admin } })).status).toBe(404); // there is no third picture
      expect((await fetch(`${new URL(base).origin}${detail}`, { redirect: 'manual' })).status).toBe(302); // not signed in
      expect((await fetch(`${new URL(base).origin}${src}`, { redirect: 'manual' })).status).toBe(302); // not signed in

      // layout: article left, infobox card right with the small clickable diagram, rule, then the change history
      // the box comes FIRST inside the article card (a float sits at the top only if it comes first), then the text; the change history follows the card
      expect(after).toMatch(/<div class="wp"><div class="main"><article><aside class="side"><div class="card">[\s\S]*<\/aside>[\s\S]*<\/article><hr class="rule"><section class="hist"><h2 id="h-change-history">Change history<\/h2>[\s\S]*<\/section><\/div><\/div>/);
      expect(after).toMatch(/<aside class="side"><div class="card">[\s\S]*<a class="pic" id="pic" href="[^"]*\/p\/alpha\/diagram\/[^"]*"[\s\S]*click to enlarge/);
      expect(after).toContain('id="lightbox"');
      expect(after).toMatch(/<nav class="card contents"><strong>Contents<\/strong>[\s\S]*href="#h-change-history"/);
      expect((after.match(/<tr><td>\d{4}-\d{2}-\d{2}/g) ?? []).length).toBeLessThanOrEqual(20);
      expect((after.match(/<tr><td>\d{4}-\d{2}-\d{2}/g) ?? []).length).toBeGreaterThan(0);
    });

    it('lists every GitLab project of the person, also those without notes, with a blank page', async () => {
      const dev = cookiesOf(await signIn('dev-code'));
      const home = await (await fetch(`${base}/`, { headers: { cookie: dev } })).text();
      // the ring carries the GitLab project ID (Zeta is project 2), a dash when there is no GitLab project
      expect(home).toMatch(/<span class="c" aria-label="GitLab project ID">2<\/span>\s*<span class="t">Zeta/);
      expect(home).toMatch(/<span class="c" aria-label="GitLab project ID">1<\/span>\s*<span class="t">Alpha/);
      expect(home).not.toContain('class="gid"');
      expect(home).toMatch(/<b>\d+ projects\.<\/b>/);
      expect(home).toContain('repeat(5,minmax(0,1fr))'); // five cards per row
      expect(home).toContain(`href="${base.replace(new URL(base).origin, '')}/p/zeta"`);
      const page = await fetch(`${base}/p/zeta`, { headers: { cookie: dev } });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('No documentation has been generated yet');
      expect((await fetch(`${base}/p/not-a-project`, { headers: { cookie: dev } })).status).toBe(404);
    });

    it('stays signed in across a restart and re-checks GitLab silently with the refresh token', async () => {
      const { MemberStore } = await import('../src/member-store.js');
      const store = new MemberStore(webCfg.web.membersFile, deriveKeys(SECRET).enc);
      const wait = () => new Promise((r) => setTimeout(r, 200));
      const boot = async () => {
        const app = express();
        app.use(express.json());
        app.use(webCfg.http.basePath, createWebPortal(webCfg).router);
        const srv = createServer(app);
        await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
        return { srv, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}${webCfg.http.basePath}` };
      };
      const cookie = cookiesOf(await signIn('dev-code'));
      await wait();
      // 1) a new process (empty memory) still knows the person: no second trip through GitLab
      let inst = await boot();
      let home = await (await fetch(`${inst.url}/`, { headers: { cookie } })).text();
      expect(home).toContain('Your projects');
      expect(await readFile(webCfg.web.membersFile, 'utf8')).not.toContain('dev-code'); // sealed, refresh token not readable
      inst.srv.close();
      // 2) last GitLab check older than 12 h: re-validated on the server, still signed in
      const map = store.load();
      const [name, entry] = [...map.entries()][0]!;
      expect(entry.refresh).toBe('dev-code');
      map.set(name, { ...entry, at: Date.now() - 13 * 3600 * 1000 });
      await store.save(map);
      inst = await boot();
      home = await (await fetch(`${inst.url}/`, { headers: { cookie } })).text();
      expect(home).toContain('Your projects');
      await wait();
      expect(Date.now() - store.load().get(name)!.at).toBeLessThan(60_000);
      inst.srv.close();
      // 3) GitLab no longer accepts the refresh token (revoked / blocked): signed out
      const map2 = store.load();
      map2.set(name, { ...map2.get(name)!, at: Date.now() - 30 * 3600 * 1000, refresh: 'revoked-token' });
      await store.save(map2);
      inst = await boot();
      home = await (await fetch(`${inst.url}/`, { headers: { cookie } })).text();
      expect(home).toContain('Sign in with GitLab');
      inst.srv.close();
    });

    it('gives the drawing brief room to think and explains an empty answer', async () => {
      expect(calls.briefMax).toBeGreaterThanOrEqual(4000); // 700 left a reasoning model with nothing to say
      const { chat } = await import('../src/llm-call-chat.js');
      const provider = { id: 'x', label: 'Fake', kind: 'openai-compatible', baseUrl: llmBase, apiKey: 'llm-key-1234567890' } as never;
      const before = calls.chat;
      await expect(chat(provider, 'm', 'sys', 'EMPTY-REASONING please', { maxTokens: 700 })).rejects.toThrow(/finish reason: length.*only produced reasoning.*700 tokens was used up/);
      calls.chat = before; // this direct call must not count against the spending-guard assertions below
    });

    it('retries a dropped connection and reports the technical reason when it keeps failing', async () => {
      const { chat } = await import('../src/llm-call-chat.js');
      const provider = { id: 'x', label: 'Fake', kind: 'openai-compatible', baseUrl: llmBase, apiKey: 'llm-key-1234567890' } as never;
      const before = calls.chat;
      const ok = await chat(provider, 'm', 'sys', 'DROP-ONCE hello', { maxTokens: 100 });
      expect(ok.text.length).toBeGreaterThan(0); // the second try went through
      await expect(chat(provider, 'm', 'sys', 'DROP-ALWAYS hello', { maxTokens: 100 })).rejects.toThrow(/Could not reach the provider \((?!network error)[^)]+\)/);
      calls.chat = before;
    }, 20_000);

    it('asks for up to 50,000 tokens, falls back to the model maximum when the provider refuses, and shows the worst case cost', async () => {
      const { chat } = await import('../src/llm-call-chat.js');
      const provider = { id: 'x', label: 'Fake', kind: 'openai-compatible', baseUrl: llmBase, apiKey: 'llm-key-1234567890' } as never;
      const store = new ProviderStore(join(tmp, '.mnemosyne', 'providers.enc'), deriveKeys(SECRET).enc);
      const cur = (await store.list()).assignments.text!;
      await store.setJob('text', cur, {}); // back to the defaults
      const r = await chat(provider, 'm', 'sys', 'LIMIT-TEST please', { maxTokens: 50_000 });
      expect(r.text).toContain('within the model limit');
      expect(calls.limits.slice(-5)).toEqual([50_000, 50_000, 16_000]); // refused twice (both field names), then the model maximum worked
      const admin = cookiesOf(await signIn('admin-code'));
      const est = await (await api(admin, '/estimate?kind=wiki')).json();
      const facts = Object.fromEntries(est.facts as string[][]);
      expect(facts['Size']).toContain('up to 50,000 out');
      expect(facts['Estimated cost']).toBeTruthy(); // the fake model has no list price, so it says so; priced models add 'at most $X'
    });

    it('pages the audit trail: 10 events per page, newest first, pages do not overlap', async () => {
      const admin = cookiesOf(await signIn('admin-code'));
      for (let i = 0; i < 12; i++) await fetch(`${base}/p/alpha`, { headers: { cookie: admin } }); // each visit is an audit event
      await new Promise((r) => setTimeout(r, 300));
      const h = { cookie: cookiesOf(await signIn('admin-code', '/admin')) };
      const page = async (n: number) => (await (await fetch(`${base}/admin/api/audit?limit=10&offset=${n * 10}`, { headers: h })).json()) as { events: { time: string; description: string; entityName: string }[]; total: number };
      const p1 = await page(0);
      const p2 = await page(1);
      expect(p1.events).toHaveLength(10);
      expect(p2.events.length).toBeGreaterThan(0);
      expect(p1.total).toBe(p2.total);
      expect(p1.total).toBeGreaterThanOrEqual(12);
      expect(p1.events[0]!.time >= p1.events[9]!.time).toBe(true); // newest first
      expect(p1.events[9]!.time >= p2.events[0]!.time).toBe(true); // page 2 continues where page 1 ends
      const key = (e: { time: string; description: string; entityName: string }) => `${e.time}|${e.entityName}|${e.description}`;
      const seen = new Set(p1.events.map(key));
      expect(p2.events.some((e) => seen.has(key(e)) && p1.events.filter((x) => key(x) === key(e)).length === 1)).toBe(false);
      // the last page is partial, an offset past the end is empty but still reports the total
      const lastPage = Math.floor((p1.total - 1) / 10);
      expect((await page(lastPage)).events.length).toBe(p1.total - lastPage * 10);
      expect((await page(lastPage + 1)).events).toHaveLength(0);
    });

    it('administrators get an Admin button in the user area, the admin area has a way back, members see no Admin button', async () => {
      const admin = cookiesOf(await signIn('admin-code'));
      const dev = cookiesOf(await signIn('dev-code'));
      const adminPaths = ['/', '/p/alpha', '/p/alpha/notes'];
      for (const path of adminPaths) {
        const html = await (await fetch(`${base}${path}`, { headers: { cookie: admin } })).text();
        expect(html, path).toMatch(/<a class="topbtn" href="[^"]*\/admin\/" title="Open the admin area"><svg[\s\S]*?<span>Admin<\/span><\/a>/);
      }
      for (const path of ['/', '/p/alpha']) {
        const html = await (await fetch(`${base}${path}`, { headers: { cookie: dev } })).text();
        expect(html, path).not.toContain('class="topbtn"');
        expect(html).not.toContain('Open the admin area');
      }
      // the admin area links back to the projects (its own sign-in stays separate)
      const adminHtml = await (await fetch(`${base}/admin/`, { headers: { cookie: cookiesOf(await signIn('admin-code', '/admin')) } })).text();
      expect(adminHtml).toMatch(/<a class="topbtn" href="[^"]*\/" title="Back to the projects and their documentation"><svg[\s\S]*?<span>Projects<\/span><\/a>/);
    });

    it('compresses large pages with gzip when the browser accepts it', async () => {
      const dev = cookiesOf(await signIn('dev-code'));
      const plain = await fetch(`${base}/`, { headers: { cookie: dev, 'accept-encoding': 'identity' } });
      expect(plain.headers.get('content-encoding')).toBeNull();
      const raw = await new Promise<{ enc: string | undefined; bytes: number }>((resolve, reject) => {
        const u = new URL(`${base}/`);
        import('node:http').then(({ request }) => {
          const r = request({ host: u.hostname, port: u.port, path: u.pathname, headers: { cookie: dev, 'accept-encoding': 'gzip' } }, (res) => {
            let n = 0;
            res.on('data', (c: Buffer) => (n += c.length));
            res.on('end', () => resolve({ enc: res.headers['content-encoding'] as string | undefined, bytes: n }));
          });
          r.on('error', reject);
          r.end();
        });
      });
      expect(raw.enc).toBe('gzip');
      expect(raw.bytes).toBeLessThan((await plain.text()).length);
    });

    it('asks the AI for description, requirements and disaster recovery, and builds the change history itself', async () => {
      const { buildWikiPrompt, changeHistory, historyMarkdown } = await import('../src/docgen.js');
      const mk = (i: number) => ({ id: `n${i}`, title: `Note ${i}`, type: 'event', status: 'active', project: 'alpha', components: [], links: [], body: 'x', observed_at: `2026-10-${String(10 + (i % 20)).padStart(2, '0')}T10:00:00Z` }) as never;
      const notes = Array.from({ length: 30 }, (_, i) => mk(i));
      const p = buildWikiPrompt('alpha', null, notes);
      for (const must of ['product-description paragraph', '## Features and how it works', '## Specifications', '## Hardware and software requirements', '## Disaster recovery', '### Installation / rebuild steps', '### Access', '### Testing and verification']) expect(p.user).toContain(must);
      expect(p.user).toContain('do NOT write a change history');
      const h = changeHistory(notes);
      expect(h).toHaveLength(20);
      const { missingSections } = await import('../src/docgen.js');
      expect(missingSections('Intro\n\n## Overview\n')).toHaveLength(7);
      expect(missingSections('## Features and how it works\n## Specifications\n## Hardware and software requirements\n## Disaster recovery\n### Installation / rebuild steps\n### Access\n### Testing and verification')).toEqual([]);
      expect(h[0]!.date >= h[19]!.date).toBe(true); // newest first
      const md = historyMarkdown(h);
      expect(md).toContain('\n---\n');
      expect(md).toContain('## Change history');
      expect(md.split('\n').filter((l) => l.startsWith('| 2026')).length).toBe(20);
    });

    it('any member can build the PDF (no AI): cover, index, article, diagram', async () => {
      const dev = cookiesOf(await signIn('dev-code'));
      const before = calls.chat + calls.image;
      const made = await api(dev, '/pdf', 'POST', {});
      expect(made.status).toBe(200);
      const { id } = await made.json();
      expect(calls.chat + calls.image).toBe(before); // building a PDF spends nothing
      const pdf = await fetch(`${base}/p/alpha/pdf/${id}`, { headers: { cookie: dev } });
      expect(pdf.headers.get('content-type')).toBe('application/pdf');
      expect(pdf.headers.get('content-disposition')).toContain('alpha-documentation-');
      const bytes = Buffer.from(await pdf.arrayBuffer());
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      expect((bytes.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThanOrEqual(5); // cover, index, overview, detail picture, content
      expect(bytes.toString('latin1')).not.toContain('/MediaBox [0 0 841.89 595.28]'); // every page stays portrait; a wide diagram is turned on its page
      const page = await (await fetch(`${base}/p/alpha`, { headers: { cookie: dev } })).text();
      expect(page).toContain('Download PDF');
      expect(page).toContain('Workflow diagram');
    });

    it('every AI value is editable in the admin (limits, sampling, prompts): validated, saved per job, and it invalidates an old agreement', async () => {
      const admin = cookiesOf(await signIn('admin-code'));
      const adminArea = cookiesOf(await signIn('admin-code', '/admin'));
      const h = { cookie: adminArea, 'content-type': 'application/json', 'x-requested-with': 'mnemosyne-admin' };
      const get = async () => (await (await fetch(`${base}/admin/api/llm/jobs`, { headers: h })).json()).jobs;
      const put = (role: string, body: object) => fetch(`${base}/admin/api/llm/jobs/${role}`, { method: 'PUT', headers: h, body: JSON.stringify(body) });

      let jobs = await get();
      expect(Object.keys(jobs)).toEqual(['text', 'image', 'pdf']);
      expect(jobs.text.effective.maxTokens).toBe(50_000);
      expect(jobs.text.effective.systemPrompt).toContain('technical writer');
      expect(jobs.text.effective.userPrompt).toContain('{{notes}}');
      expect(jobs.text.def.placeholders.map((p: { name: string }) => p.name)).toEqual(['project', 'notes_count', 'notes']);
      expect(jobs.image.def.placeholders.map((p: { name: string }) => p.name)).toEqual(['project', 'article']);
      expect(jobs.pdf.def.usesAi).toBe(false);
      // the PDF block has the very same fields as the other two, empty because nothing uses them yet
      const pageHtml = await (await fetch(`${base}/admin/`, { headers: h })).text();
      for (const role of ['text', 'image', 'pdf']) for (const f of ['maxTokens', 'temperature', 'topP', 'timeoutMinutes']) expect(pageHtml, `${f}-${role}`).toContain(`id="${f}-${role}"`);
      for (const id of ['sys-pdf', 'usr-pdf']) expect(pageHtml).toContain(`id="${id}"`);
      expect(jobs.pdf.effective.systemPrompt).toBe('');
      expect(jobs.pdf.effective.userPrompt).toBe('');
      const pdfSaved = await put('pdf', { model: jobs.pdf.assignment, maxTokens: '8000', temperature: '0.3', systemPrompt: 'PDF-SYSTEM', userPrompt: 'Handbook for {{project}}: {{article}}' });
      expect(pdfSaved.status).toBe(200);
      expect((await get()).pdf.settings).toMatchObject({ maxTokens: 8000, temperature: 0.3, systemPrompt: 'PDF-SYSTEM' });
      expect((await put('pdf', { model: jobs.pdf.assignment, userPrompt: 'bad {{bogus}}' })).status).toBe(400);
      await put('pdf', { model: jobs.pdf.assignment }); // back to empty
      expect((await put('image', { model: jobs.image.assignment, maxTokens: 1_000_000 })).status).toBe(200); // Meta allows up to 1 million output tokens per call
      expect((await get()).image.settings.maxTokens).toBe(1_000_000);
      await put('image', { model: jobs.image.assignment }); // back to the defaults
      const model = jobs.text.assignment;
      expect(model.model).toBe('text-model');

      // refused: out-of-range numbers, text, a missing or unknown placeholder, an unknown job
      for (const bad of [{ maxTokens: 10 }, { maxTokens: 'abc' }, { maxTokens: 1_000_001 }, { temperature: 5 }, { topP: 0 }, { timeoutMinutes: 999 }, { userPrompt: 'no placeholder here' }, { userPrompt: 'x {{notes}} {{bogus}}' }]) {
        expect((await put('text', { model, ...bad })).status, JSON.stringify(bad)).toBe(400);
      }
      expect((await put('nope', {})).status).toBe(400);
      expect((await put('image', { model: jobs.image.assignment, userPrompt: 'no article placeholder' })).status).toBe(400);

      // an agreement given for the old settings
      const oldEst = await (await api(admin, '/estimate?kind=wiki')).json();
      expect(oldEst.facts.find((f: string[]) => f[0] === 'Size')[1]).toContain('up to 50,000 out');

      const saved = await put('text', { model, maxTokens: '20000', temperature: '0.2', topP: '0.9', timeoutMinutes: '5', systemPrompt: 'CUSTOM-SYSTEM write short.', userPrompt: 'Project {{project}} CUSTOM-USER\n{{notes}}' });
      expect(saved.status).toBe(200);
      jobs = await get();
      expect(jobs.text.settings).toMatchObject({ maxTokens: 20_000, temperature: 0.2, topP: 0.9, timeoutMinutes: 5 });
      expect(jobs.text.effective.systemPrompt).toBe('CUSTOM-SYSTEM write short.');
      expect(jobs.image.assignment).toBeTruthy(); // saving one job leaves the others alone
      expect(jobs.image.settings).toEqual({});

      // the agreement popup shows the new limit, and the old agreement no longer fits
      const est = await (await api(admin, '/estimate?kind=wiki')).json();
      expect(est.facts.find((f: string[]) => f[0] === 'Size')[1]).toContain('up to 20,000 out');
      const stale = await api(admin, '/generate', 'POST', { kind: 'wiki', token: oldEst.token });
      expect(stale.status).toBe(403);

      // unchanged defaults are not stored (later improvements of the defaults still apply)
      const same = await put('image', { model: jobs.image.assignment, maxTokens: '50000', systemPrompt: jobs.image.effective.systemPrompt, userPrompt: jobs.image.effective.userPrompt });
      expect(same.status).toBe(200);
      expect((await get()).image.settings).toEqual({});

      // the change is in the audit trail without secrets
      await new Promise((r) => setTimeout(r, 250));
      const audit = (await readFile(join(tmp, '.mnemosyne', 'audit.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const ev = audit.filter((e) => e.event === 'update' && e.entityType === 'llm_job' && e.entityId === 'text').pop();
      expect(ev.changes).toContain('+ maxTokens: 20000');
      expect(ev.changes).toContain('+ temperature: 0.2');
    });

    it('stops at the daily limit and records every agreement in the audit trail', async () => {
      const admin = cookiesOf(await signIn('admin-code'));
      // two runs so far (wiki + diagram); the limit is 3
      const e3 = await (await api(admin, '/estimate?kind=wiki')).json();
      expect((await api(admin, '/generate', 'POST', { kind: 'wiki', token: e3.token })).status).toBe(202);
      await waitIdle(admin);
      // that run used the values set in the admin: limit, sampling and both prompts
      const sent = calls.lastChat!;
      expect(sent.max_tokens ?? sent.max_completion_tokens).toBe(20_000);
      expect(sent.temperature).toBe(0.2);
      expect(sent.top_p).toBe(0.9);
      expect(sent.messages[0]!.content).toBe('CUSTOM-SYSTEM write short.');
      expect(sent.messages[1]!.content).toContain('CUSTOM-USER');
      expect(sent.messages[1]!.content).toContain('Alpha first note'); // {{notes}} was replaced by the project's notes
      const e4 = await (await api(admin, '/estimate?kind=wiki')).json();
      const blocked = await api(admin, '/generate', 'POST', { kind: 'wiki', token: e4.token });
      expect(blocked.status).toBe(429);
      expect((await blocked.json()).error).toContain('daily limit');
      expect(calls.chat).toBe(3); // article, diagram brief, second article; the fourth run never reached the provider

      await new Promise((r) => setTimeout(r, 250)); // audit lines are written asynchronously
      const audit = (await readFile(join(tmp, '.mnemosyne', 'audit.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const starts = audit.filter((e) => e.event === 'ai_start');
      expect(starts.length).toBe(3);
      expect(starts[0].description).toContain('Agreed to use AI');
      expect(starts[0].description).toContain('Estimated cost');
      expect(audit.filter((e) => e.event === 'ai_done').length).toBe(3);
      expect(audit.some((e) => e.event === 'denied' && /daily limit/.test(e.description))).toBe(true);
      expect(audit.some((e) => e.event === 'denied' && /no valid agreement/.test(e.description))).toBe(true);
    });
  });

  it('keeps the two sign-in systems apart: a public GitLab session never opens admin', async () => {
    const cb = await signIn('dev-code');
    expect(cb.headers.get('location')).toBe(`${new URL(base).pathname}/`);
    const cookie = cookiesOf(cb);
    const home = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    expect(home).toContain('Some Dev');
    expect(home).not.toContain('Open admin');
    const adminPageHtml = await (await fetch(`${base}/admin/`, { headers: { cookie } })).text();
    expect(adminPageHtml).toContain('Administration');
    expect(adminPageHtml).not.toContain('id="tab-llm"');
    expect((await fetch(`${base}/admin/api/providers`, { headers: { cookie } })).status).toBe(401);
  });

  it('refuses admin sign-in for a GitLab user who is not an admin and sets no admin cookie', async () => {
    const cb = await signIn('dev-code', '/admin');
    expect(cb.headers.get('location')).toBe(`${new URL(base).pathname}/admin/?error=noadmin`);
    expect(cb.headers.getSetCookie().some((c) => c.startsWith('mnemosyne_admin=') && !c.startsWith('mnemosyne_admin=;'))).toBe(false);
  });

  it('ignores a forged session cookie', async () => {
    const forged = `mnemosyne_admin=${encodeURIComponent(Buffer.from(JSON.stringify({ u: 'x', n: 'x', e: '', a: true, exp: 9999999999 })).toString('base64url') + '.AAAA')}`;
    expect((await fetch(`${base}/admin/api/providers`, { headers: { cookie: forged } })).status).toBe(401);
  });

  it('signs out', async () => {
    const out = await fetch(`${base}/auth/logout`, { method: 'POST', redirect: 'manual' });
    expect(out.status).toBe(303);
    expect(out.headers.getSetCookie().join(';')).toContain('mnemosyne_session=;');
    const adminOut = await fetch(`${base}/admin/auth/logout`, { method: 'POST', redirect: 'manual' });
    expect(adminOut.status).toBe(303);
    expect(adminOut.headers.getSetCookie().join(';')).toContain('mnemosyne_admin=;');
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
      const adminHtml = await (await fetch(`${base}/admin/`)).text();
      expect(adminHtml).toContain('not configured');
      expect(adminHtml).not.toContain('id="tab-llm"');
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

// --- built-in admin account + settings UI ------------------------------------

describe('local admin account and GitLab SSO settings', () => {
  let tmp: string;
  const servers: Server[] = [];
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'mnemosyne-local-'));
  });
  afterAll(async () => {
    servers.forEach((x) => x.close());
    await rm(tmp, { recursive: true, force: true });
  });

  /** A portal with no GitLab at all, only the built-in account, over a shared data dir. */
  async function start(env: Record<string, string> = {}) {
    const app = express();
    const srv = createServer((q, r) => app(q, r));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    servers.push(srv);
    const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const cfg = loadConfig({
      MNEMOSYNE_REPO: tmp,
      MNEMOSYNE_SECRET: SECRET,
      MNEMOSYNE_PUBLIC_URL: origin,
      MNEMOSYNE_LOCAL_ADMIN_PASSWORD: 'mnemosyne',
      ...env,
    });
    app.use(express.json());
    app.use(cfg.http.basePath, createWebPortal(cfg).router);
    return { base: `${origin}${cfg.http.basePath}`, origin, cfg };
  }

  const login = (base: string, username: string, password: string) =>
    fetch(`${base}/admin/auth/local`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password }),
    });
  const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0]!;

  it('hashes passwords with scrypt and verifies them in constant time', () => {
    const h = hashPassword('mnemosyne');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(h).not.toContain('mnemosyne');
    expect(verifyPassword('mnemosyne', h)).toBe(true);
    expect(verifyPassword('Mnemosyne', h)).toBe(false);
    expect(verifyPassword('x', undefined)).toBe(false);
    expect(verifyPassword('x', 'garbage')).toBe(false);
  });

  it('has no default account unless the operator sets a password', async () => {
    const { base } = await start({ MNEMOSYNE_LOCAL_ADMIN_PASSWORD: '' });
    expect(await (await fetch(`${base}/`)).text()).toContain('not configured');
    expect((await login(base, 'admin', '')).headers.get('location')).toContain('error=local');
  });

  it('signs the local admin in and rejects wrong credentials', async () => {
    const { base } = await start();
    const page = await (await fetch(`${base}/admin/`)).text();
    expect(page).toContain('name="password"');
    expect(page).not.toContain('Sign in with GitLab'); // SSO not configured yet
    expect(await (await fetch(`${base}/`)).text()).not.toContain('name="password"'); // never on the public page

    const bad = await login(base, 'admin', 'nope');
    expect(bad.headers.get('location')).toContain('error=local');
    expect(bad.headers.get('set-cookie') ?? '').not.toContain('mnemosyne_session=ey');
    expect((await login(base, 'mnemosyne', 'mnemosyne')).headers.get('location')).toContain('error=local');

    const ok = await login(base, 'admin', 'mnemosyne');
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/mnemosyne/admin/');
    const cookie = cookieOf(ok);
    expect((await fetch(`${base}/admin`, { headers: { cookie } })).status).toBe(200);
    expect(await (await fetch(`${base}/admin`)).text()).not.toContain('id="tab-llm"');
  });

  it('submits the admin form exactly as the page defines it (action URL must be a live route)', async () => {
    const { base } = await start();
    const html = await (await fetch(`${base}/admin/`)).text();
    const action = /<form class="local" method="post" action="([^"]+)"/.exec(html)?.[1];
    expect(action).toBe(`${new URL(base).pathname}/admin/auth/local`);
    const res = await fetch(new URL(action!, base), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'mnemosyne' }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${new URL(base).pathname}/admin/`);
  });

  it('locks a client out after five misses, even with the right password', async () => {
    const { base } = await start();
    for (let i = 0; i < 5; i++) await login(base, 'admin', `wrong${i}`);
    expect((await login(base, 'admin', 'mnemosyne')).headers.get('location')).toContain('error=throttled');
  });

  it('configures GitLab SSO from the admin page and never returns the secret', async () => {
    const { base, origin, cfg } = await start();
    const cookie = cookieOf(await login(base, 'admin', 'mnemosyne'));
    const hdr = { cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'mnemosyne-admin', origin };

    const put = await fetch(`${base}/admin/api/settings`, {
      method: 'PUT',
      headers: hdr,
      body: JSON.stringify({ gitlabUrl: 'https://gitlab.example.com/', clientId: 'app-id', clientSecret: 'super-secret-value' }),
    });
    expect(put.status).toBe(200);
    const got = await (await fetch(`${base}/admin/api/settings`, { headers: { cookie } })).json();
    expect(got.redirectUris).toHaveLength(2);
    expect(got).toMatchObject({ gitlabUrl: 'https://gitlab.example.com', clientId: 'app-id', hasSecret: true, ssoActive: true });
    expect(got).not.toHaveProperty('adminUsers'); // admin rights come from GitLab, not from a list
    expect(JSON.stringify(got)).not.toContain('super-secret-value');
    expect(await readFile(cfg.web.settingsFile, 'utf8')).not.toContain('super-secret-value');

    // an empty secret keeps the stored one; the login page now offers GitLab too
    await fetch(`${base}/admin/api/settings`, { method: 'PUT', headers: hdr, body: JSON.stringify({ gitlabUrl: 'https://gitlab.example.com', clientId: 'app-id', clientSecret: '' }) });
    expect((await (await fetch(`${base}/admin/api/settings`, { headers: { cookie } })).json()).hasSecret).toBe(true);
    expect(await (await fetch(`${base}/`)).text()).toContain('Sign in with GitLab');

    // cross-site writes are refused
    const csrf = await fetch(`${base}/admin/api/settings`, { method: 'PUT', headers: { ...hdr, origin: 'https://evil.example' }, body: '{}' });
    expect(csrf.status).toBe(403);
  });

  it('switches the local account off 24h after GitLab SSO went live, including open sessions', async () => {
    const { base, cfg } = await start();
    const store = new SettingsStore(cfg.web.settingsFile, deriveKeys(SECRET).enc);
    const now = Math.floor(Date.now() / 1000);

    await store.update((st) => void (st.ssoLiveAt = now - 3600)); // live for 1h: still allowed
    const cookie = cookieOf(await login(base, 'admin', 'mnemosyne'));
    expect((await fetch(`${base}/admin`, { headers: { cookie } })).status).toBe(200);

    await store.update((st) => void (st.ssoLiveAt = now - 25 * 3600)); // live for 25h: off
    expect((await login(base, 'admin', 'mnemosyne')).headers.get('location')).toContain('error=local');
    expect(await (await fetch(`${base}/admin/`)).text()).not.toContain('name="password"');
    expect((await fetch(`${base}/admin/api/settings`, { headers: { cookie } })).status).toBe(401);
    expect(await (await fetch(`${base}/admin`, { headers: { cookie } })).text()).not.toContain('id="tab-llm"');

    // recovery switch for operators
    process.env.MNEMOSYNE_LOCAL_ADMIN_FORCE = '1';
    try {
      expect((await login(base, 'admin', 'mnemosyne')).status).toBe(303);
    } finally {
      delete process.env.MNEMOSYNE_LOCAL_ADMIN_FORCE;
    }
  });
  const isolated = () => ({ MNEMOSYNE_SETTINGS_FILE: join(tmp, `s-${Math.random()}.enc`), MNEMOSYNE_AUDIT_FILE: join(tmp, `a-${Math.random()}.jsonl`) });

  it('writes an audit trail: sign-ins, failures with the client address, and changes without secrets', async () => {
    const { base, origin, cfg } = await start(isolated());
    // rightmost X-Forwarded-For entry (added by our own :40000 front) is the client; anything before it is client-supplied
    const post = (u: string, p: string) =>
      fetch(`${base}/admin/auth/local`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': '9.9.9.9, 203.0.113.7' },
        body: new URLSearchParams({ username: u, password: p }),
      });
    await post('admin', 'wrong-password');
    const ok = await post('admin', 'mnemosyne');
    const cookie = cookieOf(ok);
    const hdr = { cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'mnemosyne-admin', origin };
    await fetch(`${base}/admin/api/settings`, { method: 'PUT', headers: hdr, body: JSON.stringify({ gitlabUrl: 'https://gl.example.com', clientId: 'cid-1', clientSecret: 'top-secret-value-xyz' }) });
    await fetch(`${base}/admin/api/providers`, { method: 'POST', headers: hdr, body: JSON.stringify({ label: 'Meta', kind: 'openai-compatible', baseUrl: 'https://api.meta.ai/v1', apiKey: 'meta-key-aaaaaaaa1234' }) });
    await new Promise((r) => setTimeout(r, 100));

    const got = await (await fetch(`${base}/admin/api/audit`, { headers: { cookie } })).json();
    const events = got.events as { event: string; entityType: string; user: string; ip: string; changes: string | null; description: string }[];
    expect(got.total).toBe(events.length);
    const failed = events.find((e) => e.event === 'login_failed');
    expect(failed).toMatchObject({ entityType: 'admin_local', user: 'admin', ip: '203.0.113.7' });
    expect(events.find((e) => e.event === 'login')).toMatchObject({ entityType: 'admin_local', user: 'admin', ip: '203.0.113.7' });
    const sso = events.find((e) => e.entityType === 'sso')!;
    expect(sso.event).toBe('update');
    expect(sso.changes).toContain('+ gitlabUrl: "https://gl.example.com"');
    expect(sso.changes).toContain('clientSecret');
    const prov = events.find((e) => e.entityType === 'llm_provider')!;
    expect(prov.event).toBe('create');
    expect(events[0]!.event).toBe('create'); // newest first

    // nothing secret ever reaches the file
    const file = await readFile(cfg.web.auditFile, 'utf8');
    expect(file).not.toContain('top-secret-value-xyz');
    expect(file).not.toContain('meta-key-aaaaaaaa1234');
    expect(file).not.toContain('mnemosyne"'); // no password material either

    // search + paging
    const q = await (await fetch(`${base}/admin/api/audit?q=gitlab`, { headers: { cookie } })).json();
    expect(q.events.length).toBeGreaterThan(0);
    expect(q.events.every((e: { entityType: string; description: string; changes: string | null }) => `${e.entityType} ${e.description} ${e.changes}`.toLowerCase().includes('gitlab'))).toBe(true);
    const paged = await (await fetch(`${base}/admin/api/audit?offset=1`, { headers: { cookie } })).json();
    expect(paged.events.length).toBe(got.total - 1);

    // admin only
    expect((await fetch(`${base}/admin/api/audit`)).status).toBe(401);
    // sign-out is recorded too
    await fetch(`${base}/admin/auth/logout`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
    const after = await (await new Promise<Response>((r) => setTimeout(r, 100)).then(() => fetch(`${base}/admin/auth/local`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'admin', password: 'mnemosyne' }) }))).headers.get('set-cookie');
    const again = await (await fetch(`${base}/admin/api/audit`, { headers: { cookie: (after ?? '').split(';')[0]! } })).json();
    expect(again.events.some((e: { event: string }) => e.event === 'logout')).toBe(true);
  });

  it('keeps the audit table styles on the ADMIN page (not on the login page)', async () => {
    const { base } = await start(isolated());
    const cookie = cookieOf(await login(base, 'admin', 'mnemosyne'));
    const admin = await (await fetch(`${base}/admin/`, { headers: { cookie } })).text();
    for (const rule of ['.tablewrap{overflow-x:auto', 'table.audit{', 'pre.chg{', '.ev.login_failed']) expect(admin).toContain(rule);
    const loginHtml = await (await fetch(`${base}/admin/`)).text();
    expect(loginHtml).not.toContain('table.audit');
  });

  it('shows an Audit tab with the CenTest-style columns and has no typed admin list', async () => {
    const { base } = await start(isolated());
    const cookie = cookieOf(await login(base, 'admin', 'mnemosyne'));
    const html = await (await fetch(`${base}/admin/`, { headers: { cookie } })).text();
    expect(html).toContain('data-tab="audit"');
    for (const col of ['Date / Time', 'Event', 'Entity Type', 'Name / ID', 'User', 'IP Address', 'Changes', 'Description']) expect(html).toContain(`<th>${col}</th>`);
    expect(html).not.toContain('GitLab admins');
    expect(html).not.toContain('id="adminUsers"');
    expect(html).toContain('only a GitLab administrator');
  });
});

describe('admin page script', () => {
  // The page's inline script is generated from a template literal; an escape mistake there is a
  // SyntaxError in the browser and the whole page goes dead. Compile it and run it against a stub page.
  it('compiles, runs, and wires every form and tab handler', async () => {
    const html = adminPage({ basePath: '/mnemosyne', nonce: 'n', user: { name: 'A', username: 'a' }, redirectUris: ['u1', 'u2'] });
    const js = /<script nonce="n">([\s\S]*?)<\/script>/.exec(html)![1]!;
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
    const make = (id: string) => {
      const el: Record<string, unknown> & { handlers: Record<string, unknown> } = {
        id, handlers: {}, style: {}, hidden: false, className: '', textContent: '', value: '', disabled: false, placeholder: '', children: [] as unknown[],
        appendChild(c: unknown) { (el.children as unknown[]).push(c); return c; },
        addEventListener(type: string, fn: unknown) { el.handlers[type] = fn; },
        scrollIntoView() {}, getAttribute: () => 'llm', reset() {},
      };
      return el;
    };
    const els = new Map(ids.map((id) => [id, make(id)]));
    const missing: string[] = [];
    const ok = { status: 200, ok: true, json: async () => ({ providers: [], assignments: {}, events: [], total: 0, gitlabUrl: '', clientId: '', hasSecret: false }) };
    const sandbox = {
      document: { getElementById: (id: string) => els.get(id) ?? (missing.push(id), null), createElement: () => make('new'), querySelectorAll: () => [make('a')], querySelector: () => make('r') },
      window: { addEventListener() {} },
      location: { hash: '#audit', href: '' },
      fetch: async () => ok,
      confirm: () => true,
      Intl,
      Date,
      setInterval: () => 0,
      setTimeout,
      clearTimeout,
      encodeURIComponent,
    };
    new Script(js).runInContext(createContext(sandbox)); // throws on a SyntaxError or a top-level error
    await new Promise((r) => setTimeout(r, 50));
    expect(missing).toEqual([]);
    for (const form of ['form', 'job-text', 'job-image', 'job-pdf', 'ssoForm']) expect(typeof els.get(form)!.handlers.submit).toBe('function');
    for (const btn of ['auditRefresh', 'cancel']) expect(typeof els.get(btn)!.handlers.click).toBe('function');
    expect(els.has('auditPager')).toBe(true); // numbered pages, 10 events each
    expect(html).not.toContain('Load more');
    expect(els.get('tab-audit')!.hidden).toBe(false); // #audit opens the Audit tab
    expect(els.get('tab-llm')!.hidden).toBe(true);
  });
});

describe('documentation helpers', () => {
  it('matches a notes project to a GitLab project by name, never by guess', () => {
    const projects = [
      { id: 1, name: 'CenTest', path: 'centest', fullPath: 'GCD-Group/centest', webUrl: '' },
      { id: 2, name: 'SMM NodeJS', path: 'smm-nodejs', fullPath: 'LSE-Group/smm-nodejs', webUrl: '' },
    ];
    expect(matchProject('centest', projects)?.fullPath).toBe('GCD-Group/centest');
    expect(matchProject('smm-nodejs', projects)?.id).toBe(2);
    expect(matchProject('lse', projects)).toBeNull();
    expect(matchProject('cen', projects)).toBeNull();
  });

  it('masks credentials in note text', () => {
    const out = redact(`db password: S3cretValue1\nBearer abcdefghijklmnopqrstuvwxyz0123\nkey ${FAKE_AWS}\n${FAKE_PEM_BEGIN}\nxx\n${FAKE_PEM_END}\nplain text stays`);
    expect(out).not.toMatch(new RegExp(`S3cretValue1|abcdefghijklmnopqrstuvwxyz0123|${FAKE_AWS}|BEGIN RSA`));
    expect(out).toContain('plain text stays');
  });

  it('renders markdown without letting any markup through', () => {
    const html = renderMarkdown('# T\n\n- a\n- **b**\n\n| x | y |\n|---|---|\n| 1 | <b>2</b> |\n\n```\n<i>code</i>\n```\n\n[x](https://e.com/a?b=1&c=2) ![i](http://e.com/i.png) <img src=x onerror=alert(1)>');
    expect(html).toContain('<h2 id="h-t">T</h2>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<table>');
    expect(html).toContain('&lt;b&gt;2&lt;/b&gt;');
    expect(html).toContain('<pre><code>&lt;i&gt;code&lt;/i&gt;</code></pre>');
    expect(html).not.toMatch(/<img|onerror=alert\(1\)>/);
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });
});
