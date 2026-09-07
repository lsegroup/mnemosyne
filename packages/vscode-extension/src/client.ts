import type { MemoryNode } from '@mnemosyne/core';

export interface SearchResultRow {
  id: string;
  title: string;
  type: string;
  status: string;
  project: string;
  excerpt: string;
}

/** Minimal REST client for the mnemosyne server. */
export class MnemosyneClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    };
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  search(query: string, project?: string): Promise<SearchResultRow[]> {
    return this.req('/search', {
      method: 'POST',
      body: JSON.stringify({ query, project, limit: 50, mode: 'hybrid' }),
    });
  }

  getNode(id: string): Promise<MemoryNode> {
    return this.req(`/nodes/${encodeURIComponent(id)}`);
  }

  createNode(input: Record<string, unknown>): Promise<{ id: string; commit: string | null }> {
    return this.req('/nodes', { method: 'POST', body: JSON.stringify(input) });
  }

  health(): Promise<{ ok: boolean; embedder: string }> {
    return this.req('/health');
  }
}
