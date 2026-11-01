import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { Script } from 'node:vm';
import { join } from 'node:path';
import express from 'express';
import { simpleGit } from 'simple-git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createHttpApp } from '../src/http.js';
import { ProviderStore, ProviderUnreachableError, ProviderValidationError } from '../src/provider-store.js';
import { modelsUrl, parseModelIds } from '../src/llm-models.js';
import { MnemosyneService } from '../src/service.js';
import { deriveKeys, open, seal, signToken, verifyToken } from '../src/secrets.js';
import { createWebPortal } from '../src/web.js';
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
      MNEMOSYNE_AI_DAILY_LIMIT: '4',
      MNEMOSYNE_ALIAS_HOSTS: 'Old-Name.example.test, other.example.test',
    });
    webCfg = cfg;
    portalApp = express();
    portalApp.use(express.json());
    const built = createWebPortal(cfg);
    portalApp.use(cfg.http.basePath, built.router);
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

  it('rejects a callback with a bad or missing state', async () => {
    const res = await fetch(`${base}/auth/callback?code=admin-code&state=forged`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('error=state');
    expect(res.headers.getSetCookie().some((c) => c.startsWith('mnemosyne_session=') && !c.startsWith('mnemosyne_session=;'))).toBe(false);
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

  it('shows the signed-in person as a card with a link to their profile, on every page', async () => {
    const dev = cookiesOf(await signIn('dev-code'));
    const home = await (await fetch(`${base}/`, { headers: { cookie: dev } })).text();
    expect(home).toContain('<details class="usermenu">'); // a click on the name opens the card, no script needed
    expect(home).toContain('<strong>Some Dev</strong>');
    expect(home).toContain('@dev');
    expect(home).toContain('<span class="upill">Member</span>');
    expect(home).toContain(`<a class="btn primary" href="${new URL(base).pathname}/profile">Profile</a>`);
    expect(await (await fetch(`${base}/p/alpha`, { headers: { cookie: dev } })).text()).toContain('class="usermenu"');

    const admin = cookiesOf(await signIn('admin-code'));
    expect(await (await fetch(`${base}/`, { headers: { cookie: admin } })).text()).toContain('<span class="upill">GitLab administrator</span>');
  });

  it('has a profile page for the signed-in person only, with their details and nothing of anybody else', async () => {
    expect((await fetch(`${base}/profile`, { redirect: 'manual' })).status).toBe(302); // not signed in: back to the login page

    const dev = cookiesOf(await signIn('dev-code'));
    const res = await fetch(`${base}/profile`, { headers: { cookie: dev } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'nonce-");
    const html = await res.text();
    expect(html).toContain('<h1>Your profile</h1>');
    for (const detail of ['Some Dev', '@dev', 'dev@example.com', 'Member', 'GitLab projects', 'Checked with GitLab', 'Signed in until']) expect(html, detail).toContain(detail);
    expect(html).toMatch(/<dt>GitLab projects<\/dt><dd>2<\/dd>/); // dev belongs to two GitLab projects
    expect(html).toContain('/dev</a>'); // link to the GitLab profile
    expect(html).not.toContain('store@lumanet.info');
    expect(html).toContain('at most <strong>90 days</strong>');
    expect(html).toContain('<option value="90" selected>90 days (maximum)</option>');
    expect(html).not.toMatch(/<option value="(91|180|365)"/);
    expect(html).toContain('http://127.0.0.1'); // the MCP address ...
    expect(html).toContain('This address is plain http'); // ... and a warning, because it is not https

    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(script).toContain('/profile/api/tokens');
    expect(() => new Script(script)).not.toThrow(); // the page script is valid JavaScript

    const admin = await (await fetch(`${base}/profile`, { headers: { cookie: cookiesOf(await signIn('admin-code')) } })).text();
    expect(admin).toContain('GitLab administrator');
    expect(admin).toContain('store@lumanet.info');
    expect(admin).not.toContain('dev@example.com');
  });

  it('lets a person issue, list and revoke their own MCP tokens: valid for at most 90 days, shown once, never audited in clear', async () => {
    const dev = cookiesOf(await signIn('dev-code'));
    const other = cookiesOf(await signIn('admin-code'));
    const api = `${base}/profile/api/tokens`;
    const origin = new URL(base).origin;
    const post = (url: string, cookie: string, body?: object, marked = true) =>
      fetch(url, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin, ...(marked ? { 'x-requested-with': 'mnemosyne-docs' } : {}) }, body: JSON.stringify(body ?? {}) });

    // the same-origin marker is required, and so is a sign-in
    expect((await post(api, dev, { name: 'x' }, false)).status).toBe(403);
    expect((await post(api, '', { name: 'x' })).status).toBe(401);

    const made = await post(api, dev, { name: 'Claude Code on my laptop' });
    expect(made.status).toBe(201);
    const body = (await made.json()) as { token: string; info: { id: string; name: string; hint: string; createdAt: number; expiresAt: number; status: string }; tokens: { id: string }[] };
    expect(body.token).toMatch(/^mnm_[A-Za-z0-9_-]{40,}$/);
    expect(body.info).toMatchObject({ name: 'Claude Code on my laptop', status: 'active' });
    expect(Math.round((body.info.expiresAt - body.info.createdAt) / 86_400_000)).toBe(90);
    expect(made.headers.get('cache-control')).toBe('no-store');

    // too long or nameless: refused with the reason
    expect(await (await post(api, dev, { name: 'long', days: 91 })).json()).toEqual({ error: 'A token is valid for 1 to 90 days.' });
    expect(((await (await post(api, dev, { name: ' ' })).json()) as { error: string }).error).toMatch(/Give the token a name/);
    const week = (await (await post(api, dev, { name: 'one week', days: 7 })).json()) as { info: { createdAt: number; expiresAt: number } };
    expect(Math.round((week.info.expiresAt - week.info.createdAt) / 86_400_000)).toBe(7);

    // the profile lists the token by name and first characters, never the token
    const page = await (await fetch(`${base}/profile`, { headers: { cookie: dev } })).text();
    expect(page).toContain('Claude Code on my laptop');
    expect(page).toContain(`mnm_${body.info.hint}`);
    expect(page).not.toContain(body.token);
    expect(page).toContain(`data-revoke="${body.info.id}"`);
    // somebody else's profile does not list it
    const others = await (await fetch(`${base}/profile`, { headers: { cookie: other } })).text();
    expect(others).not.toContain(body.info.id);
    expect(others).not.toContain(`mnm_${body.info.hint}`);

    // only the owner can revoke it
    expect((await post(`${api}/${body.info.id}/revoke`, other)).status).toBe(404);
    const revoked = await post(`${api}/${body.info.id}/revoke`, dev);
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as { tokens: { id: string; status: string }[] }).tokens.find((t) => t.id === body.info.id)?.status).toBe('revoked');
    expect((await post(`${api}/${body.info.id}/revoke`, dev)).status).toBe(404); // already revoked

    // the audit trail knows who issued and revoked, and never holds the token (its writes are queued: wait for the last one)
    let audit = '';
    for (let i = 0; i < 40 && !audit.includes('token_revoke'); i++) {
      audit = await readFile(webCfg.web.auditFile, 'utf8').catch(() => '');
      if (!audit.includes('token_revoke')) await new Promise((r) => setTimeout(r, 50));
    }
    expect(audit).not.toContain(body.token);
    const events = audit.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: string; user: string; entityName?: string });
    expect(events.some((e) => e.event === 'token_issue' && e.user === 'dev' && e.entityName === 'Claude Code on my laptop')).toBe(true);
    expect(events.some((e) => e.event === 'token_revoke' && e.user === 'dev')).toBe(true);
    // and the sealed file on disk holds neither the token nor a readable name
    const sealed = await readFile(webCfg.web.tokensFile, 'utf8');
    expect(sealed).not.toContain(body.token);
    expect(sealed.startsWith('v1.')).toBe(true);
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

  describe('one host name for sign-in (owner: the SSO broke when the portal was opened under the gitlab name)', () => {
    // fetch() cannot choose the Host header reliably, so use http.request
    const getAs = (host: string, path: string, method = 'GET') =>
      new Promise<{ status: number; location?: string }>((resolve, reject) => {
        const u = new URL(base);
        const req = httpRequest({ host: u.hostname, port: u.port, path: `${u.pathname}${path}`, method, headers: { host } }, (res) => {
          res.resume();
          resolve({ status: res.statusCode!, location: res.headers.location });
        });
        req.on('error', reject);
        req.end();
      });

    it('redirects a page opened under another name of this server to the same path under the public URL, so the sign-in cookie and the return address share one host', async () => {
      const origin = new URL(base).origin;
      for (const path of ['/', '/p/alpha?v=20261030T120000Z', '/auth/login', '/admin/', '/admin/auth/login']) {
        const r = await getAs('old-name.example.test:40000', path);
        expect(r.status, path).toBe(302);
        expect(r.location, path).toBe(`${origin}/mnemosyne${path}`);
      }
      expect((await getAs('other.example.test', '/')).location).toBe(`${origin}/mnemosyne/`); // second listed name, no port
    });

    it('serves the Mnemosyne Wiki badge that gitlab-links puts on every GitLab project (public, no sign-in, an image that holds no script)', async () => {
      const r = await fetch(`${base}/assets/wiki-badge.svg`, { redirect: 'manual' });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('image/svg+xml');
      expect(r.headers.get('content-security-policy')).toContain('sandbox');
      const svg = await r.text();
      expect(svg).toContain('>Mnemosyne<');
      expect(svg).toContain('>Wiki<');
      expect(svg).not.toMatch(/<script|href=/);
    });

    it('does nothing under the public host itself, never follows an unknown Host header, and leaves MCP, REST and non-page requests alone', async () => {
      const own = new URL(base).host;
      expect((await getAs(own, '/')).status).toBe(200); // the login page, no redirect
      expect((await getAs('evil.example.test', '/')).status).toBe(200); // not one of our names: the header is never copied anywhere
      expect((await getAs('evil.example.test', '/auth/login')).location ?? '').not.toContain('evil.example.test');
      for (const path of ['/mcp', '/nodes', '/search', '/health']) expect((await getAs('old-name.example.test', path)).status, path).not.toBe(302);
      expect((await getAs('old-name.example.test', '/auth/login', 'POST')).status).not.toBe(302); // only GET page requests are redirected
    });

    it('the sign-in started under the public host completes: cookie and return address are on one host', async () => {
      const login = await fetch(`${base}/auth/login`, { redirect: 'manual' });
      expect(login.status).toBe(302);
      const to = new URL(login.headers.get('location')!);
      expect(to.searchParams.get('redirect_uri')).toBe(`${new URL(base).origin}/mnemosyne/auth/callback`);
      expect(login.headers.get('set-cookie')).toContain('mnemosyne_oauth=');
    });
  });

  it('resolves a project key spelled differently (case, dash, underscore) to the real notes project - the GitLab links use the slug of the GitLab path - but never for a person who may not read it', async () => {
    const dev = cookiesOf(await signIn('dev-code')); // member of alpha
    const to = (r: Response) => new URL(r.headers.get('location') ?? 'http://none', base).pathname + new URL(r.headers.get('location') ?? 'http://none', base).search;
    const r1 = await fetch(`${base}/p/ALPHA`, { headers: { cookie: dev }, redirect: 'manual' });
    expect(r1.status).toBe(302);
    expect(to(r1)).toBe(`${new URL(base).pathname}/p/alpha`);
    const r2 = await fetch(`${base}/p/Alpha?v=20261030T120000Z`, { headers: { cookie: dev }, redirect: 'manual' });
    expect(to(r2)).toBe(`${new URL(base).pathname}/p/alpha?v=20261030T120000Z`); // the rest of the address is kept
    expect((await fetch(`${base}/p/alpha`, { headers: { cookie: dev }, redirect: 'manual' })).status).toBe(200); // the real name: no redirect
    const none = cookiesOf(await signIn('scope-code')); // no project at all
    const r3 = await fetch(`${base}/p/ALPHA`, { headers: { cookie: none }, redirect: 'manual' });
    expect(r3.status).toBe(404); // nothing is revealed: not redirected to a page that exists
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
    const calls = { chat: 0, image: 0, imagePrompt: '', failImage: false, briefMax: 0, limits: [] as number[], lastChat: null as null | { max_tokens?: number; max_completion_tokens?: number; temperature?: number; top_p?: number; reasoning_effort?: string; messages: { role: string; content: string }[] } };
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
              choices: [{ message: { content: wantsBrief ? JSON.stringify(DIAGRAM_PLAN) : '# Alpha\n\nAlpha is a test project.\n\n## Overview\n\nIt does **things**.\n\n### Details\n\nMore about the things.\n\n## History\n\n- first\n- second\n\n## Known issues\n\nNone documented.' } }],
              usage: { prompt_tokens: 1200, completion_tokens: 300 },
            });
          } else if (req.url === '/v1/images/generations') {
            calls.image++;
            calls.imagePrompt = (JSON.parse(raw) as { prompt?: string }).prompt ?? '';
            if (calls.failImage) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end('{}');
            } else reply({ data: [{ b64_json: png.toString('base64') }] });
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
      // headings and Contents: the main sections are h2, their sub-sections h3, and the Contents card lists both as links (owner request 2026-10-31)
      expect(page).toContain('<h2 id="h-overview">Overview</h2>');
      expect(page).toContain('<h3 id="h-details">Details</h3>');
      expect(page).toMatch(/<nav class="card contents"><strong>Contents<\/strong><ol>[\s\S]*<li><a href="#h-overview">Overview<\/a><ul><li><a href="#h-details">Details<\/a><\/li><\/ul><\/li>[\s\S]*<li><a href="#h-known-issues">Known issues<\/a><\/li>[\s\S]*<li><a href="#h-change-history">Change history<\/a><\/li><\/ol><\/nav>/);
      expect(page).toContain('Regenerate documentation');

      // workflow diagram: the text model writes the plan, Mnemosyne draws it itself (exact words) AND the image model chosen in Admin paints it
      // as a picture from the same plan, only after agreement
      const est = await (await api(admin, '/estimate?kind=diagram')).json();
      expect(est.facts.map((f: string[]) => f[0])).toEqual(expect.arrayContaining(['Text model', 'Image model', 'Estimated cost']));
      expect(est.facts.find((f: string[]) => f[0] === 'Image model')[1]).toBe('Fake AI / image-model');
      expect(est.what).toContain('paints the workflow diagram as a picture');
      expect((await api(admin, '/generate', 'POST', { kind: 'diagram', token: est.token })).status).toBe(202);
      expect((await waitIdle(admin)).state).toBe('done');
      expect(calls.image).toBe(1); // the image model IS called: this is the picture the owner ordered
      // it is told every word of the plan, and to use no other
      expect(calls.imagePrompt).toContain('"Browser"');
      expect(calls.imagePrompt).toContain('"GitLab SSO"');
      expect(calls.imagePrompt).toContain('"Browser" -> "Notes <service> & \'index\'"'); // arrows name the boxes by their exact label (a quotation mark inside a label becomes an apostrophe)
      expect(calls.imagePrompt).toContain('label on the arrow: "HTTPS"');
      expect(calls.imagePrompt).toContain('spell every word EXACTLY');
      const after = await (await fetch(`${base}/p/alpha`, { headers: { cookie: admin } })).text();
      // the painted picture is shown first, in the card, and served with the type of its bytes
      const painted = /<img src="([^"]+\/picture\/[^"]+)" alt="Workflow diagram of alpha, painted by the image model"/.exec(after)?.[1];
      expect(painted).toBeTruthy();
      expect(after).toContain('painted ');
      expect(after).toContain('by Fake AI / image-model');
      const pimg = await fetch(`${new URL(base).origin}${painted}`, { headers: { cookie: admin } });
      expect(pimg.status).toBe(200);
      expect(pimg.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await pimg.arrayBuffer()).equals(png)).toBe(true);
      expect((await fetch(`${new URL(base).origin}${painted}`, { redirect: 'manual' })).status).toBe(302); // not signed in
      const src = /<img src="([^"]+\/diagram\/[^"]+)" alt="Workflow diagram/.exec(after)?.[1];
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
      // a connection that never opened is typed, so the Auto run knows it may wait and send the same call again
      await expect(chat(provider, 'm', 'sys', 'DROP-ALWAYS hello', { maxTokens: 100 })).rejects.toBeInstanceOf(ProviderUnreachableError);
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

    it('administrators get an Admin button in the user area that opens the admin, members see no Admin button', async () => {
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
      expect((bytes.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThanOrEqual(6); // cover, index, painted workflow diagram, overview, detail picture, content
      expect(bytes.toString('latin1')).not.toContain('/MediaBox [0 0 841.89 595.28]'); // every page stays portrait; a wide diagram is turned on its page
      const page = await (await fetch(`${base}/p/alpha`, { headers: { cookie: dev } })).text();
      expect(page).toContain('Download PDF');
      expect(page).toContain('Workflow diagram');
    });

    it('keeps the exact diagrams and says why when the image model cannot paint the picture', async () => {
      const admin = cookiesOf(await signIn('admin-code'));
      const est = await (await api(admin, '/estimate?kind=diagram')).json();
      calls.failImage = true;
      try {
        expect((await api(admin, '/generate', 'POST', { kind: 'diagram', token: est.token })).status).toBe(202);
        const st = await waitIdle(admin);
        expect(st.state).toBe('done'); // the diagrams are saved
        expect(st.warning).toContain('could not paint the workflow diagram');
        expect(st.warning).toContain('image-model');
      } finally {
        calls.failImage = false;
      }
      const page = await (await fetch(`${base}/p/alpha`, { headers: { cookie: admin } })).text();
      expect(page).toContain('by Mnemosyne, planned by Fake AI / text-model'); // the new exact diagram
      expect(page).toContain('alt="Workflow diagram of alpha, painted by the image model"'); // the picture of the earlier run stays until a new one is painted
    });

    it('stops at the daily limit and records every agreement in the audit trail', async () => {
      const admin = cookiesOf(await signIn('admin-code'));
      // three runs so far (wiki, diagram, diagram); the limit is 4
      const e3 = await (await api(admin, '/estimate?kind=wiki')).json();
      expect((await api(admin, '/generate', 'POST', { kind: 'wiki', token: e3.token })).status).toBe(202);
      await waitIdle(admin);
      const e4 = await (await api(admin, '/estimate?kind=wiki')).json();
      const blocked = await api(admin, '/generate', 'POST', { kind: 'wiki', token: e4.token });
      expect(blocked.status).toBe(429);
      expect((await blocked.json()).error).toContain('daily limit');
      expect(calls.chat).toBe(4); // article, two diagram plans, second article; the fifth run never reached the provider

      await new Promise((r) => setTimeout(r, 250)); // audit lines are written asynchronously
      const audit = (await readFile(join(tmp, '.mnemosyne', 'audit.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const starts = audit.filter((e) => e.event === 'ai_start');
      expect(starts.length).toBe(4);
      expect(starts[0].description).toContain('Agreed to use AI');
      expect(starts[0].description).toContain('Estimated cost');
      expect(audit.filter((e) => e.event === 'ai_done').length).toBe(5); // article, diagram, painted picture, diagram (its picture failed), article
      expect(audit.some((e) => e.event === 'ai_failed' && e.entityType === 'docs_picture')).toBe(true);
      expect(audit.some((e) => e.event === 'denied' && /daily limit/.test(e.description))).toBe(true);
      expect(audit.some((e) => e.event === 'denied' && /no valid agreement/.test(e.description))).toBe(true);
    });

  });

  it('signs out', async () => {
    const out = await fetch(`${base}/auth/logout`, { method: 'POST', redirect: 'manual' });
    expect(out.status).toBe(303);
    expect(out.headers.getSetCookie().join(';')).toContain('mnemosyne_session=;');
  });
});

describe('web portal when not configured', () => {
  it('says so on the login screen', async () => {
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
      expect((await fetch(`${base}/admin/`)).status).toBe(404); // the admin is a separate program
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
