import { NodeRepo } from './repo.js';
import type { MemoryNode } from '@mnemosyne/core';

/** A GitLab project the signed-in user belongs to (from GitLab itself, never from a list kept here). */
export interface GitLabProject {
  id: number;
  name: string;
  /** Last path segment, e.g. `centest`. */
  path: string;
  fullPath: string;
  webUrl: string;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Which GitLab project a notes project belongs to: its slug equals the GitLab project's path or
 * name slug (`centest` -> `GCD-Group/centest`). No match (e.g. the catch-all `lse`) = no project,
 * so only GitLab administrators see it.
 */
export function matchProject(notesProject: string, projects: GitLabProject[]): GitLabProject | null {
  const key = slug(notesProject);
  return projects.find((p) => slug(p.path) === key || slug(p.name) === key) ?? null;
}

/** The projects this GitLab user belongs to, read with their own access token (scope `read_api`). */
export async function fetchMemberships(gitlabUrl: string, token: string): Promise<GitLabProject[] | null> {
  const out: GitLabProject[] = [];
  for (let page = 1; page <= 10; page++) {
    let res: Response;
    try {
      res = await fetch(`${gitlabUrl}/api/v4/projects?membership=true&simple=true&per_page=100&page=${page}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return null;
    }
    // 401/403 = the GitLab application lacks the read_api scope: fail closed (show nothing).
    if (!res.ok) return page === 1 ? null : out;
    const rows = (await res.json()) as { id: number; name: string; path: string; path_with_namespace: string; web_url: string }[];
    for (const r of rows) out.push({ id: r.id, name: r.name, path: r.path, fullPath: r.path_with_namespace, webUrl: r.web_url });
    if (rows.length < 100) break;
  }
  return out;
}

/** Mask anything that looks like a credential before a note is shown in a browser. */
export function redact(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/\b(glpat-|ghp_|github_pat_|hvs\.|xox[bp]-|sk-)[A-Za-z0-9_-]{16,}/g, '[redacted token]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted key]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/g, '$1 [redacted]')
    .replace(
      /\b((?:pass(?:word|wd)?|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret)\s*[:=]\s*)(["'`]?)(?!\[redacted)[^\s"'`,;)]{6,}\2/gi,
      '$1[redacted]',
    );
}

export interface ProjectSummary {
  project: string;
  count: number;
  updated: string | null;
}

/** The notes on disk, re-read at most every 30 s (661 small files; reading them per request would be wasteful). */
export class NodeIndex {
  private cache: { at: number; nodes: MemoryNode[] } | null = null;
  private readonly repo: NodeRepo;

  constructor(nodesDir: string) {
    this.repo = new NodeRepo(nodesDir);
  }

  async all(): Promise<MemoryNode[]> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.nodes;
    let nodes: MemoryNode[] = [];
    try {
      nodes = await this.repo.list();
    } catch (err) {
      console.error('docs: could not read notes:', (err as Error).message);
      if (this.cache) return this.cache.nodes;
    }
    this.cache = { at: Date.now(), nodes };
    return nodes;
  }

  async projects(): Promise<ProjectSummary[]> {
    const by = new Map<string, ProjectSummary>();
    for (const n of await this.all()) {
      const s = by.get(n.project) ?? { project: n.project, count: 0, updated: null };
      s.count++;
      if (n.observed_at && (!s.updated || n.observed_at > s.updated)) s.updated = n.observed_at;
      by.set(n.project, s);
    }
    return [...by.values()].sort((a, b) => a.project.localeCompare(b.project));
  }

  async inProject(project: string): Promise<MemoryNode[]> {
    return (await this.all()).filter((n) => n.project === project);
  }

  async get(project: string, id: string): Promise<MemoryNode | null> {
    return (await this.all()).find((n) => n.project === project && n.id === id) ?? null;
  }
}
