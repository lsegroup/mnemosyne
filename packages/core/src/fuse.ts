/**
 * Reciprocal Rank Fusion: combine several ranked id lists into one, without
 * needing the underlying scores to be on the same scale. Used to merge FTS
 * (lexical) and vector (semantic) result lists.
 *
 * score(id) = sum over lists of 1 / (k + rank_in_list(id)), rank starting at 1.
 * k=60 is the value from the original Cormack et al. paper and works well here.
 */
export interface RankedList {
  /** ids in descending relevance order */
  ids: string[];
  /** optional per-list weight (default 1) */
  weight?: number;
}

export interface FusedResult {
  id: string;
  score: number;
  /** contribution per input list, keyed by list index */
  parts: Record<number, number>;
}

export function reciprocalRankFusion(lists: RankedList[], k = 60): FusedResult[] {
  const acc = new Map<string, FusedResult>();
  lists.forEach((list, listIndex) => {
    const weight = list.weight ?? 1;
    list.ids.forEach((id, i) => {
      const contribution = weight * (1 / (k + i + 1));
      const cur = acc.get(id) ?? { id, score: 0, parts: {} };
      cur.score += contribution;
      cur.parts[listIndex] = contribution;
      acc.set(id, cur);
    });
  });
  return [...acc.values()].sort((a, b) => b.score - a.score);
}
