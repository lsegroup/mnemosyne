import {
  Frontmatter,
  indexableText,
  neighbors as bfsNeighbors,
  slugify,
  type CodeRef,
  type Embedder,
  type LinkRel,
  type MemoryNode,
  type NeighborOptions,
  type SearchHit,
  type SearchQuery,
} from '@mnemosyne/core';
import type { MnemosyneConfig } from './config.js';
import { GitOps, type HistoryEntry } from './git.js';
import { NodeRepo } from './repo.js';
import { SqliteBackend } from './sqlite-backend.js';
import { resolveEmbedder } from './embedding.js';

/** Loose code-ref accepted from callers; normalized to a full CodeRef on write. */
export interface CodeRefInput {
  repo: string;
  path: string;
  line?: number | null;
  symbol_id?: string | null;
}

function normalizeRef(r: CodeRefInput): CodeRef {
  return { repo: r.repo, path: r.path, line: r.line ?? null, symbol_id: r.symbol_id ?? null };
}

export interface CreateNodeInput {
  id?: string;
  title: string;
  type: MemoryNode['type'];
  project: string;
  status?: MemoryNode['status'];
  body: string;
  components?: string[];
  code_refs?: CodeRefInput[];
  links?: MemoryNode['links'];
  authors?: string[];
  observed_at?: string | null;
  supersedes?: string | null;
}

export type UpdateNodePatch = Partial<Omit<CreateNodeInput, 'id'>>;

export interface WriteResult {
  node: MemoryNode;
  commit: string | null;
}

/** Orchestrates repo (markdown) + backend (index) + embedder + git. */
export class MnemosyneService {
  private constructor(
    private readonly cfg: MnemosyneConfig,
    private readonly repo: NodeRepo,
    private readonly git: GitOps,
    private readonly backend: SqliteBackend,
    private readonly embedder: Embedder,
  ) {}

  static async open(cfg: MnemosyneConfig): Promise<MnemosyneService> {
    const embedder = await resolveEmbedder(cfg);
    const backend = new SqliteBackend(cfg.dbPath, embedder.dimensions);
    return new MnemosyneService(
      cfg,
      new NodeRepo(cfg.nodesDir),
      new GitOps(cfg),
      backend,
      embedder,
    );
  }

  async close(): Promise<void> {
    await this.backend.close();
  }

  get embedderId(): string {
    return this.embedder.id;
  }

  private async embedNode(node: MemoryNode): Promise<Float32Array> {
    const [v] = await this.embedder.embed([indexableText(node)]);
    if (!v) throw new Error('embedder returned no vector');
    return v;
  }

  // ---- reads -------------------------------------------------------------

  async search(q: SearchQuery): Promise<SearchHit[]> {
    const mode = q.mode ?? 'hybrid';
    let queryEmbedding: Float32Array | undefined;
    if (mode !== 'text') {
      [queryEmbedding] = await this.embedder.embed([q.query]);
    }
    return this.backend.search(q, queryEmbedding);
  }

  async getNode(id: string): Promise<MemoryNode | null> {
    const node = (await this.backend.get(id)) ?? (await this.repo.get(id));
    if (!node) return null;
    const hist = await this.getHistory(id, 100);
    if (hist.length > 0) {
      node.updated_at = hist[0]!.date;
      node.created_at = hist[hist.length - 1]!.date;
      node.source_commit = hist[0]!.commit;
    }
    return node;
  }

  async getHistory(id: string, limit = 50): Promise<HistoryEntry[]> {
    const node = (await this.backend.get(id)) ?? (await this.repo.get(id));
    if (!node) return [];
    return this.git.history(this.repo.relPath(node, this.cfg.repoDir), limit);
  }

  async neighbors(
    id: string,
    opts: NeighborOptions,
  ): Promise<{ origin: string; distance: Record<string, number>; nodes: MemoryNode[]; edges: unknown[] }> {
    const all = await this.repo.list();
    const map = new Map(all.map((n) => [n.id, n]));
    const res = bfsNeighbors(id, map, opts);
    return {
      origin: id,
      distance: res.distance,
      edges: res.edges,
      nodes: res.order.map((nid) => map.get(nid)).filter((n): n is MemoryNode => Boolean(n)),
    };
  }

  // ---- writes ----------------------------------------------------------

  private async persist(node: MemoryNode, message: string): Promise<WriteResult> {
    const validated = { ...Frontmatter.parse(node), body: node.body } as MemoryNode;
    const file = await this.repo.write(validated);
    const commit = await this.git.commitPaths([file], message);
    await this.backend.upsert(validated, await this.embedNode(validated));
    return { node: validated, commit };
  }

  async createNode(input: CreateNodeInput): Promise<WriteResult> {
    const id = input.id ?? slugify(input.project, input.title);
    if (await this.repo.get(id)) {
      throw new Error(`node ${id} already exists; use update_node`);
    }
    const node: MemoryNode = {
      id,
      title: input.title,
      type: input.type,
      status: input.status ?? 'n/a',
      project: input.project,
      components: input.components ?? [],
      code_refs: (input.code_refs ?? []).map(normalizeRef),
      links: input.links ?? [],
      authors: input.authors ?? [],
      observed_at: input.observed_at ?? null,
      supersedes: input.supersedes ?? null,
      body: input.body,
    };
    return this.persist(node, `memory: add ${id}`);
  }

  async updateNode(id: string, patch: UpdateNodePatch): Promise<WriteResult> {
    const existing = await this.repo.get(id);
    if (!existing) throw new Error(`node ${id} not found`);
    const merged: MemoryNode = {
      ...existing,
      ...patch,
      id,
      code_refs: patch.code_refs ? patch.code_refs.map(normalizeRef) : existing.code_refs,
      links: patch.links ?? existing.links,
    };
    return this.persist(merged, `memory: update ${id}`);
  }

  async linkNodes(from: string, rel: LinkRel, to: string): Promise<WriteResult> {
    const node = await this.repo.get(from);
    if (!node) throw new Error(`node ${from} not found`);
    if (!(await this.repo.get(to))) throw new Error(`link target ${to} not found`);
    if (node.links.some((l) => l.rel === rel && l.target === to)) return { node, commit: null };
    node.links = [...node.links, { rel, target: to }];
    return this.persist(node, `memory: link ${from} -${rel}-> ${to}`);
  }

  async linkNodeToCode(id: string, ref: CodeRefInput): Promise<WriteResult> {
    const node = await this.repo.get(id);
    if (!node) throw new Error(`node ${id} not found`);
    const full = normalizeRef(ref);
    if (node.code_refs.some((r) => r.repo === full.repo && r.path === full.path && r.line === full.line)) {
      return { node, commit: null };
    }
    node.code_refs = [...node.code_refs, full];
    return this.persist(node, `memory: link ${id} -> ${full.repo}/${full.path}`);
  }

  async reindex(): Promise<{ count: number; embedder: string }> {
    const all = await this.repo.list();
    await this.backend.clear();
    const head = await this.git.headSha();
    const BATCH = 64;
    for (let i = 0; i < all.length; i += BATCH) {
      const slice = all.slice(i, i + BATCH);
      const vectors = await this.embedder.embed(slice.map((n) => indexableText(n)));
      for (let j = 0; j < slice.length; j++) {
        const node = { ...slice[j]!, source_commit: head };
        await this.backend.upsert(node, vectors[j]!);
      }
    }
    return { count: all.length, embedder: this.embedder.id };
  }
}
