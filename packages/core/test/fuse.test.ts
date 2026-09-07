import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from '../src/fuse.js';

describe('reciprocalRankFusion', () => {
  it('ranks an id appearing high in both lists first', () => {
    const fused = reciprocalRankFusion([
      { ids: ['a', 'b', 'c'] },
      { ids: ['b', 'a', 'd'] },
    ]);
    expect(fused[0]?.id).toBe('a');
    expect(fused.map((r) => r.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a single strong list still contributes', () => {
    const fused = reciprocalRankFusion([
      { ids: ['x', 'y'] },
      { ids: [] },
    ]);
    expect(fused[0]?.id).toBe('x');
  });

  it('honours per-list weight', () => {
    const unweighted = reciprocalRankFusion([
      { ids: ['a', 'b'] },
      { ids: ['b', 'a'] },
    ]);
    // symmetric -> a and b tie, a wins on insertion order
    expect(unweighted[0]?.score).toBeCloseTo(unweighted[1]!.score);

    const weighted = reciprocalRankFusion([
      { ids: ['a', 'b'], weight: 3 },
      { ids: ['b', 'a'], weight: 1 },
    ]);
    expect(weighted[0]?.id).toBe('a');
    expect(weighted[0]!.score).toBeGreaterThan(weighted[1]!.score);
  });
});
