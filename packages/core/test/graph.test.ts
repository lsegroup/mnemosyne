import { describe, expect, it } from 'vitest';
import { neighbors } from '../src/graph.js';
import { parseMarkdown, type MemoryNode } from '../src/schema.js';

function node(id: string, links: { rel: string; target: string }[] = []): MemoryNode {
  return parseMarkdown(
    `---\nid: ${id}\ntitle: ${id}\ntype: status\nproject: p\nlinks: ${JSON.stringify(links)}\n---\nbody\n`,
  );
}

const graph = new Map<string, MemoryNode>(
  [
    node('a', [{ rel: 'depends-on', target: 'b' }]),
    node('b', [{ rel: 'depends-on', target: 'c' }]),
    node('c', []),
    node('d', [{ rel: 'relates-to', target: 'a' }]),
  ].map((n) => [n.id, n]),
);

describe('neighbors', () => {
  it('depth 1 finds direct links in both directions', () => {
    const r = neighbors('a', graph, { depth: 1 });
    expect(new Set(r.order)).toEqual(new Set(['b', 'd']));
    expect(r.distance.b).toBe(1);
  });

  it('depth 2 reaches two hops out', () => {
    const r = neighbors('a', graph, { depth: 2 });
    expect(r.distance.c).toBe(2);
  });

  it('rel filter restricts traversal', () => {
    const r = neighbors('a', graph, { depth: 2, rel: ['depends-on'] });
    expect(r.order).not.toContain('d');
    expect(r.order).toContain('c');
  });

  it('bidirectional=false only follows declared direction', () => {
    const r = neighbors('c', graph, { depth: 1, bidirectional: false });
    expect(r.order).toEqual([]);
  });
});
