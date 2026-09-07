import type { LinkRel, MemoryNode } from './schema.js';

export interface GraphEdge {
  from: string;
  to: string;
  rel: LinkRel;
  /** true when this edge was walked against its declared direction */
  reversed: boolean;
}

export interface NeighborResult {
  /** node id -> shortest hop distance from the origin (origin itself is 0) */
  distance: Record<string, number>;
  /** every edge traversed while exploring */
  edges: GraphEdge[];
  /** ids in breadth-first discovery order, excluding the origin */
  order: string[];
}

export interface NeighborOptions {
  /** restrict traversal to these relationship kinds */
  rel?: LinkRel[];
  /** max hop distance (default 1) */
  depth?: number;
  /** follow links backwards too (default true) */
  bidirectional?: boolean;
}

/**
 * Breadth-first walk over node `links`. This is the whole "graph database":
 * at team-memory scale (thousands of nodes) an in-memory BFS is faster and far
 * simpler to operate than Neo4j / AGE.
 */
export function neighbors(
  originId: string,
  nodes: Map<string, MemoryNode>,
  options: NeighborOptions = {},
): NeighborResult {
  const depth = options.depth ?? 1;
  const bidirectional = options.bidirectional ?? true;
  const relFilter = options.rel ? new Set<LinkRel>(options.rel) : null;

  // adjacency: id -> [{ to, rel, reversed }]
  const adj = new Map<string, { to: string; rel: LinkRel; reversed: boolean }[]>();
  const addEdge = (from: string, to: string, rel: LinkRel, reversed: boolean) => {
    if (relFilter && !relFilter.has(rel)) return;
    const list = adj.get(from) ?? [];
    list.push({ to, rel, reversed });
    adj.set(from, list);
  };
  for (const node of nodes.values()) {
    for (const link of node.links) {
      addEdge(node.id, link.target, link.rel, false);
      if (bidirectional) addEdge(link.target, node.id, link.rel, true);
    }
  }

  const distance: Record<string, number> = { [originId]: 0 };
  const edges: GraphEdge[] = [];
  const order: string[] = [];
  let frontier = [originId];

  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const edge of adj.get(cur) ?? []) {
        edges.push({ from: cur, to: edge.to, rel: edge.rel, reversed: edge.reversed });
        if (distance[edge.to] === undefined) {
          distance[edge.to] = d;
          order.push(edge.to);
          next.push(edge.to);
        }
      }
    }
    frontier = next;
  }

  return { distance, edges, order };
}
