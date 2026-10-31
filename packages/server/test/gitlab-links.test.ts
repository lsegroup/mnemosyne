import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BADGE_NAME, badgeImageUrl, linkKey, notesProjectNames, syncGitLabLinks, wikiUrl } from '../src/gitlab-links.js';

const PORTAL = 'https://host.example:40000/mnemosyne';
const projects = [
  { id: 1, name: 'CenTest', path: 'CenTest', path_with_namespace: 'GCD-Group/CenTest' },
  { id: 12, name: 'bootstrap_access', path: 'bootstrap_access', path_with_namespace: 'infrastructure/bootstrap_access' },
  { id: 20, name: 'Brand New', path: 'brand-new', path_with_namespace: 'GCD-Group/brand-new' },
  { id: 30, name: 'Locked', path: 'locked', path_with_namespace: 'GCD-Group/locked' },
];

describe('the Mnemosyne Wiki link in every GitLab project', () => {
  let gl: Server;
  let url = '';
  let tmp = '';
  const wikis = new Map<number, string>();
  const badges = new Map<number, { id: number; name: string; kind: string; link_url: string; image_url: string }[]>();
  const writes: string[] = [];
  const tokens = new Set<string>();
  let nextId = 100;

  const read = (req: IncomingMessage) => new Promise<Record<string, string>>((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {})); });

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'mnem-links-'));
    for (const d of ['centest', 'bootstrap_access', 'lse', '_candidates']) await mkdir(join(tmp, d), { recursive: true });
    gl = createServer(async (req, res) => {
      tokens.add(String(req.headers['private-token']));
      const send = (code: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
      const u = new URL(req.url!, 'http://x');
      let m: RegExpExecArray | null;
      if (u.pathname === '/api/v4/projects') {
        const page = Number(u.searchParams.get('page') ?? 1);
        const per = 2; // small pages: the pagination is part of the test
        return send(200, projects.slice((page - 1) * per, page * per), { 'X-Next-Page': page * per < projects.length ? String(page + 1) : '' });
      }
      if ((m = /^\/api\/v4\/projects\/(\d+)\/integrations\/external-wiki$/.exec(u.pathname))) {
        const id = Number(m[1]);
        if (req.method === 'GET') return wikis.has(id) ? send(200, { active: true, properties: { external_wiki_url: wikis.get(id) } }) : send(404, { message: '404 Integration Not Found' });
        if (id === 30) return send(403, { message: '403 Forbidden' });
        const b = await read(req);
        wikis.set(id, b.external_wiki_url!);
        writes.push(`PUT wiki ${id}`);
        return send(200, { active: true });
      }
      if ((m = /^\/api\/v4\/projects\/(\d+)\/badges(?:\/(\d+))?$/.exec(u.pathname))) {
        const id = Number(m[1]);
        if (req.method === 'GET') return send(200, badges.get(id) ?? []);
        if (id === 30) return send(403, { message: '403 Forbidden' });
        const b = await read(req);
        const list = badges.get(id) ?? [];
        if (req.method === 'POST') list.push({ id: nextId++, name: b.name!, kind: 'project', link_url: b.link_url!, image_url: b.image_url! });
        else Object.assign(list.find((x) => x.id === Number(m![2]))!, b);
        badges.set(id, list);
        writes.push(`${req.method} badge ${id}`);
        return send(201, {});
      }
      send(404, {});
    });
    await new Promise<void>((r) => gl.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(gl.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    gl?.close();
    await rm(tmp, { recursive: true, force: true });
  });

  const run = (extra: Partial<Parameters<typeof syncGitLabLinks>[0]> = {}) =>
    syncGitLabLinks({ gitlabUrl: url, token: 'secret-token-123', portalUrl: PORTAL, notesProjects: ['centest', 'bootstrap_access', 'lse'], apply: true, concurrency: 2, ...extra });

  it('keys a project like the portal does: the matching notes project, else the slug of the GitLab path; notes folders are the notes projects', async () => {
    expect(linkKey({ name: 'CenTest', path: 'CenTest' }, ['centest', 'lse'])).toBe('centest');
    expect(linkKey({ name: 'bootstrap_access', path: 'bootstrap_access' }, ['bootstrap_access'])).toBe('bootstrap_access'); // underscore kept: it is the notes name
    expect(linkKey({ name: 'Brand New', path: 'brand-new' }, ['centest'])).toBe('brand-new'); // no notes yet: the page is still blank-but-there
    expect(linkKey({ name: 'Odd Name', path: 'Odd_Path.git' }, [])).toBe('odd-path-git');
    expect(wikiUrl(`${PORTAL}/`, 'a b')).toBe(`${PORTAL}/p/a%20b`);
    expect(badgeImageUrl(PORTAL)).toBe(`${PORTAL}/assets/wiki-badge.svg`);
    expect((await notesProjectNames(tmp)).sort()).toEqual(['bootstrap_access', 'centest', 'lse']); // _candidates is not a project
  });

  it('a dry run changes nothing and says what it would do', async () => {
    const lines: string[] = [];
    const r = await run({ apply: false, log: (l) => lines.push(l) });
    expect(writes).toEqual([]);
    expect(r.projects).toBe(4); // read over two pages
    expect(r.wiki).toEqual({ create: 4, update: 0, ok: 0 });
    expect(r.badge).toEqual({ create: 4, update: 0, ok: 0 });
    expect(lines.some((l) => l.includes('would create wiki   infrastructure/bootstrap_access'))).toBe(true);
  });

  it('applies to every project, reports the one it may not change, and carries on with the rest', async () => {
    const r = await run();
    expect(wikis.get(1)).toBe(`${PORTAL}/p/centest`);
    expect(wikis.get(12)).toBe(`${PORTAL}/p/bootstrap_access`);
    expect(wikis.get(20)).toBe(`${PORTAL}/p/brand-new`);
    expect(badges.get(12)![0]).toMatchObject({ name: BADGE_NAME, link_url: `${PORTAL}/p/bootstrap_access`, image_url: `${PORTAL}/assets/wiki-badge.svg` });
    expect(wikis.has(30)).toBe(false);
    expect(r.failed.map((f) => `${f.project}:${f.step}`).sort()).toEqual(['GCD-Group/locked:badge', 'GCD-Group/locked:wiki link']);
    expect(r.failed[0]!.error).toContain('403');
    expect(r.wiki.create).toBe(3);
    expect(r.badge.create).toBe(3);
  });

  it('is idempotent: a second run changes nothing; a wrong address is corrected; --only limits it to the named project', async () => {
    writes.length = 0;
    const again = await run();
    expect(writes).toEqual([]);
    expect(again.wiki).toMatchObject({ create: 0, update: 0, ok: 3 });
    expect(again.badge).toMatchObject({ create: 0, update: 0, ok: 3 });

    wikis.set(12, 'https://old.example/p/bootstrap_access');
    badges.get(20)![0]!.link_url = 'https://old.example/x';
    const fixed = await run({ only: ['infrastructure/bootstrap_access', 'GCD-Group/brand-new'] });
    expect(fixed.projects).toBe(2);
    expect(fixed.wiki.update).toBe(1);
    expect(fixed.badge.update).toBe(1);
    expect(wikis.get(12)).toBe(`${PORTAL}/p/bootstrap_access`);
    expect(badges.get(20)![0]!.link_url).toBe(`${PORTAL}/p/brand-new`);
    expect(badges.get(20)!.length).toBe(1); // updated, not added a second time
  });

  it('can do only one of the two links, and refuses a token without the api scope', async () => {
    const before = writes.length;
    wikis.delete(1);
    const r = await run({ badge: false, only: ['GCD-Group/CenTest'] });
    expect(r.badge).toEqual({ create: 0, update: 0, ok: 0 });
    expect(r.wiki.create).toBe(1);
    expect(writes.length).toBe(before + 1);
    const refusing = createServer((_q, s) => { s.writeHead(403); s.end('{}'); });
    await new Promise<void>((r2) => refusing.listen(0, '127.0.0.1', r2));
    await expect(run({ gitlabUrl: `http://127.0.0.1:${(refusing.address() as AddressInfo).port}` })).rejects.toThrow(/api scope/);
    refusing.close();
  });

  it('sends the token only in the PRIVATE-TOKEN header and never writes it into the report', async () => {
    const lines: string[] = [];
    const r = await run({ log: (l) => lines.push(l) });
    expect([...tokens]).toEqual(['secret-token-123']);
    expect(JSON.stringify([lines, r])).not.toContain('secret-token-123');
  });
});
