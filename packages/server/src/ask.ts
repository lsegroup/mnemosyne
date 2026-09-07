import type { LLM } from '@mnemosyne/core';
import type { MnemosyneService } from './service.js';

export interface AskResult {
  answer: string;
  sources: { id: string; title: string }[];
}

/**
 * Retrieve-and-answer for non-agent callers. Agents should call `search_memory`
 * themselves; this is the convenience path for a plain HTTP client.
 */
export async function answer(
  svc: MnemosyneService,
  llm: LLM,
  question: string,
  project?: string,
): Promise<AskResult> {
  if (!question.trim()) throw new Error('question is required');
  const hits = await svc.search({ query: question, project, limit: 8, mode: 'hybrid' });

  const context = hits
    .map((h, i) => `[${i + 1}] (${h.node.id}) ${h.node.title}\n${h.node.body}`)
    .join('\n\n---\n\n');

  const content = await llm.complete(
    [
      {
        role: 'system',
        content:
          'You answer questions about an engineering team\'s infrastructure and codebase using only the memory notes provided. Cite note numbers like [2]. If the notes do not cover it, say so plainly.',
      },
      { role: 'user', content: `Notes:\n\n${context || '(no matching notes)'}\n\nQuestion: ${question}` },
    ],
    { temperature: 0.1 },
  );

  return {
    answer: content,
    sources: hits.map((h) => ({ id: h.node.id, title: h.node.title })),
  };
}
