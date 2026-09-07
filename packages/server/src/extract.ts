import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { toMarkdown, type LLM, type MemoryNode } from '@mnemosyne/core';
import type { MnemosyneConfig } from './config.js';

/**
 * Draft candidate memory nodes from recent git history. Output goes to
 * `nodes/_candidates/` for a human to review, edit and move into the corpus
 * (or a follow-up can open a merge request). Off unless an LLM is configured.
 */
export async function extractFromHistory(
  cfg: MnemosyneConfig,
  llm: LLM,
  since: string,
): Promise<{ written: string[] }> {
  const git = simpleGit(cfg.repoDir);
  const log = await git.log({ from: since, to: 'HEAD' });
  if (log.all.length === 0) return { written: [] };

  const summary = log.all
    .map((c) => `- ${c.hash.slice(0, 8)} ${c.date} ${c.author_name}: ${c.message}`)
    .join('\n');

  const raw = await llm.complete(
    [
      {
        role: 'system',
        content:
          'Extract durable engineering knowledge from commit messages into memory notes. Return JSON {"nodes": [{ "title", "type", "status", "project", "components", "body" }]}. type in [decision,status,gotcha,howto,reference]. status in [working,broken,in-progress,resolved,n/a]. Only include notes that will still matter in six months. If nothing qualifies, return {"nodes": []}.',
      },
      { role: 'user', content: `Commits since ${since}:\n\n${summary}` },
    ],
    { json: true, temperature: 0.1 },
  );

  let parsed: { nodes?: Partial<MemoryNode>[] };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`model did not return JSON: ${raw.slice(0, 200)}`);
  }

  const dir = join(cfg.nodesDir, '_candidates');
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const [i, n] of (parsed.nodes ?? []).entries()) {
    const id = `candidate-${Date.now()}-${i}`;
    const node: MemoryNode = {
      id,
      title: n.title ?? 'untitled candidate',
      type: (n.type as MemoryNode['type']) ?? 'reference',
      status: (n.status as MemoryNode['status']) ?? 'n/a',
      project: n.project ?? 'unknown',
      components: n.components ?? [],
      code_refs: [],
      links: [],
      authors: [],
      observed_at: new Date().toISOString().slice(0, 10),
      supersedes: null,
      body: n.body ?? '',
    };
    const file = join(dir, `${id}.md`);
    await writeFile(file, toMarkdown(node), 'utf8');
    written.push(file);
  }
  return { written };
}
