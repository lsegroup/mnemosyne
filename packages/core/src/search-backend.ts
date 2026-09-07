import type { MemoryNode } from './schema.js';

export type SearchMode = 'hybrid' | 'text' | 'semantic';

export interface SearchQuery {
  query: string;
  mode?: SearchMode;
  project?: string;
  type?: string;
  status?: string;
  limit?: number;
}

export interface SearchHit {
  node: MemoryNode;
  /** Fused score; higher is better. Not comparable across queries. */
  score: number;
  /** Which signals contributed, for debugging / UI. */
  matched: { text?: number; semantic?: number };
}

/**
 * Pluggable storage + retrieval. The default implementation is SqliteBackend
 * (FTS5 + sqlite-vec, in-process). A MeilisearchBackend can be dropped in for
 * RAM-rich hosts without touching callers.
 */
export interface SearchBackend {
  /** Insert or replace a node (and its embedding). */
  upsert(node: MemoryNode, embedding: Float32Array): Promise<void>;
  /** Remove a node by id. */
  remove(id: string): Promise<void>;
  /** Fetch one node by id, or null. */
  get(id: string): Promise<MemoryNode | null>;
  /** All node ids currently indexed. */
  ids(): Promise<string[]>;
  /** Ranked search. `queryEmbedding` is required for hybrid/semantic modes. */
  search(q: SearchQuery, queryEmbedding?: Float32Array): Promise<SearchHit[]>;
  /** Drop everything (used before a full reindex). */
  clear(): Promise<void>;
  close(): Promise<void>;
}
