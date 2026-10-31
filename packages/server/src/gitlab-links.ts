import { readdir } from 'node:fs/promises';
import { slug } from './slug.js';

/**
 * Puts a "Mnemosyne Wiki" link into EVERY GitLab project, so people reach the project's Mnemosyne page from GitLab:
 *  - the project's "External wiki" integration (GitLab shows it in the project menu in place of its own, empty wiki), and
 *  - a badge named "Mnemosyne Wiki" on the project page (a badge is the only place where GitLab lets the link carry our own name).
 * Both are idempotent: a second run changes nothing, a changed address is corrected, a missing link is created. Run by the CI/CD
 * pipeline after every deploy and daily (so new projects get it too), see `bin/gitlab-links.ts`. No dependencies: plain Node.
 */

export interface GlProject {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
}

export const BADGE_NAME = 'Mnemosyne Wiki';

/** Where a project's page lives in the portal: the notes project that matches the GitLab project, else the slug of its path (as the home page does). */
export function linkKey(gl: Pick<GlProject, 'name' | 'path'>, notesProjects: string[]): string {
  const hit = [...notesProjects].sort().find((p) => slug(p) === slug(gl.path) || slug(p) === slug(gl.name));
  return hit ?? slug(gl.path);
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');
export const wikiUrl = (portalUrl: string, key: string) => `${trimSlash(portalUrl)}/p/${encodeURIComponent(key)}`;
export const badgeImageUrl = (portalUrl: string) => `${trimSlash(portalUrl)}/assets/wiki-badge.svg`;

/** The notes projects are the directories of the notes folder. */
export async function notesProjectNames(nodesDir: string): Promise<string[]> {
  try {
    return (await readdir(nodesDir, { withFileTypes: true })).filter((d) => d.isDirectory() && !/^[._]/.test(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
}

export interface Counts {
  create: number;
  update: number;
  ok: number;
}
export interface SyncResult {
  projects: number;
  wiki: Counts;
  badge: Counts;
  failed: { project: string; step: string; error: string }[];
}
export interface SyncOptions {
  gitlabUrl: string;
  /** A GitLab token with the api scope and Maintainer rights on the projects. Never logged. */
  token: string;
  /** The portal address including the base path, e.g. https://host:40000/mnemosyne */
  portalUrl: string;
  notesProjects: string[];
  /** False = only report what would change. */
  apply: boolean;
  wikiLink?: boolean;
  badge?: boolean;
  /** Only these projects (full path, e.g. infrastructure/bootstrap_access). */
  only?: string[];
  concurrency?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

interface Reply {
  status: number;
  json: unknown;
  nextPage: string;
}

export async function syncGitLabLinks(opt: SyncOptions): Promise<SyncResult> {
  const doFetch = opt.fetch ?? fetch;
  const base = `${trimSlash(opt.gitlabUrl)}/api/v4`;
  const log = opt.log ?? (() => undefined);
  const wantWiki = opt.wikiLink !== false;
  const wantBadge = opt.badge !== false;

  /** One GitLab call; network errors, 429 and 5xx are retried with a pause. */
  const call = async (method: string, path: string, body?: Record<string, string>): Promise<Reply> => {
    let last = 'no answer';
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await doFetch(`${base}${path}`, {
          method,
          headers: { 'PRIVATE-TOKEN': opt.token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 429 || res.status >= 500) {
          last = `HTTP ${res.status}`;
        } else {
          const text = await res.text();
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* not json */
          }
          return { status: res.status, json, nextPage: res.headers.get('x-next-page') ?? '' };
        }
      } catch (err) {
        last = (err as Error).message;
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    throw new Error(last);
  };

  const projects: GlProject[] = [];
  for (let page = 1; page > 0; ) {
    const r = await call('GET', `/projects?per_page=100&page=${page}&archived=false&simple=true&order_by=id`);
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`GitLab refused the project list (HTTP ${r.status}): the token needs the api scope`);
    projects.push(...(r.json as GlProject[]));
    page = r.nextPage ? Number(r.nextPage) : 0;
  }
  const todo = projects.filter((p) => !opt.only?.length || opt.only.includes(p.path_with_namespace));

  const result: SyncResult = { projects: todo.length, wiki: { create: 0, update: 0, ok: 0 }, badge: { create: 0, update: 0, ok: 0 }, failed: [] };
  const fail = (p: GlProject, step: string, error: string) => {
    result.failed.push({ project: p.path_with_namespace, step, error });
    log(`FAIL   ${p.path_with_namespace} (${step}): ${error}`);
  };
  const verb = (v: 'create' | 'update' | 'ok') => (opt.apply ? { create: 'created', update: 'updated', ok: 'ok     ' }[v] : { create: 'would create', update: 'would update', ok: 'ok' }[v]);

  const one = async (p: GlProject) => {
    const url = wikiUrl(opt.portalUrl, linkKey(p, opt.notesProjects));
    if (wantWiki) {
      try {
        const cur = await call('GET', `/projects/${p.id}/integrations/external-wiki`);
        const props = ((cur.json as { properties?: { external_wiki_url?: string } } | null)?.properties ?? {}) as { external_wiki_url?: string };
        const active = (cur.json as { active?: boolean } | null)?.active !== false;
        const exists = cur.status === 200;
        if (cur.status !== 200 && cur.status !== 404) throw new Error(`HTTP ${cur.status}`);
        if (exists && active && props.external_wiki_url === url) {
          result.wiki.ok++;
          log(`${verb('ok')} wiki   ${p.path_with_namespace} -> ${url}`);
        } else {
          if (opt.apply) {
            const put = await call('PUT', `/projects/${p.id}/integrations/external-wiki`, { external_wiki_url: url });
            if (put.status !== 200 && put.status !== 201) throw new Error(`HTTP ${put.status} ${JSON.stringify(put.json).slice(0, 120)}`);
          }
          result.wiki[exists ? 'update' : 'create']++;
          log(`${verb(exists ? 'update' : 'create')} wiki   ${p.path_with_namespace} -> ${url}`);
        }
      } catch (err) {
        fail(p, 'wiki link', (err as Error).message);
      }
    }
    if (wantBadge) {
      try {
        const image = badgeImageUrl(opt.portalUrl);
        const list = await call('GET', `/projects/${p.id}/badges`);
        if (list.status !== 200 || !Array.isArray(list.json)) throw new Error(`HTTP ${list.status}`);
        const mine = (list.json as { id: number; name?: string; kind?: string; link_url?: string; image_url?: string }[]).find((b) => b.name === BADGE_NAME && b.kind !== 'group');
        if (mine && mine.link_url === url && mine.image_url === image) {
          result.badge.ok++;
          log(`${verb('ok')} badge  ${p.path_with_namespace}`);
        } else {
          if (opt.apply) {
            const w = mine
              ? await call('PUT', `/projects/${p.id}/badges/${mine.id}`, { link_url: url, image_url: image, name: BADGE_NAME })
              : await call('POST', `/projects/${p.id}/badges`, { link_url: url, image_url: image, name: BADGE_NAME });
            if (w.status !== 200 && w.status !== 201) throw new Error(`HTTP ${w.status} ${JSON.stringify(w.json).slice(0, 120)}`);
          }
          result.badge[mine ? 'update' : 'create']++;
          log(`${verb(mine ? 'update' : 'create')} badge  ${p.path_with_namespace}`);
        }
      } catch (err) {
        fail(p, 'badge', (err as Error).message);
      }
    }
  };

  // a few projects at a time: GitLab is not hammered, and one slow project does not hold up the rest
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: Math.max(1, opt.concurrency ?? 4) }, async () => {
      for (let p = queue.shift(); p; p = queue.shift()) await one(p);
    }),
  );
  return result;
}
