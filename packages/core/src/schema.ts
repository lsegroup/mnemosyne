import matter from 'gray-matter';
import { z } from 'zod';

/** Kind of thing a memory node records. */
export const NODE_TYPES = ['decision', 'status', 'gotcha', 'howto', 'reference'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Current truth of the thing the node describes. */
export const NODE_STATUSES = ['working', 'broken', 'in-progress', 'resolved', 'n/a'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/** Relationship kinds between nodes. */
export const LINK_RELS = ['depends-on', 'supersedes', 'relates-to', 'caused-by'] as const;
export type LinkRel = (typeof LINK_RELS)[number];

export const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const CodeRef = z.object({
  repo: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive().nullable().default(null),
  /** Optional CodeGraph symbol id, when the ref points at a known symbol. */
  symbol_id: z.string().nullable().default(null),
});
export type CodeRef = z.infer<typeof CodeRef>;

export const NodeLink = z.object({
  rel: z.enum(LINK_RELS),
  target: z.string().regex(idPattern, 'target must be a node id slug'),
});
export type NodeLink = z.infer<typeof NodeLink>;

/** Everything that lives in a node's YAML frontmatter. */
export const Frontmatter = z.object({
  id: z.string().regex(idPattern, 'id must be a lowercase-kebab slug'),
  title: z.string().min(1),
  type: z.enum(NODE_TYPES),
  status: z.enum(NODE_STATUSES).default('n/a'),
  project: z.string().min(1),
  components: z.array(z.string().min(1)).default([]),
  code_refs: z.array(CodeRef).default([]),
  links: z.array(NodeLink).default([]),
  authors: z.array(z.string().min(1)).default([]),
  /** ISO date (YYYY-MM-DD) the fact was observed; distinct from git commit time. */
  observed_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'observed_at must be YYYY-MM-DD')
    .nullable()
    .default(null),
  supersedes: z.string().regex(idPattern).nullable().default(null),
});
export type Frontmatter = z.infer<typeof Frontmatter>;

/** Git-derived metadata — never written to markdown, filled in when a node is loaded. */
export interface GitMeta {
  created_at?: string;
  updated_at?: string;
  /** Commit sha of the markdown revision this node was loaded from. */
  source_commit?: string;
}

export interface MemoryNode extends Frontmatter, GitMeta {
  /** Free-text observation / reasoning — the markdown body. */
  body: string;
}

/** Frontmatter keys in the order they should be serialized, for stable diffs. */
const FRONTMATTER_ORDER: (keyof Frontmatter)[] = [
  'id',
  'title',
  'type',
  'status',
  'project',
  'components',
  'code_refs',
  'links',
  'authors',
  'observed_at',
  'supersedes',
];

/** YAML parsers turn `observed_at: 2026-08-20` into a Date; put it back to a string. */
function normalizeFrontmatter<T extends object>(data: T): T {
  const out = { ...data } as Record<string, unknown>;
  if (out.observed_at instanceof Date) {
    out.observed_at = out.observed_at.toISOString().slice(0, 10);
  }
  return out as T;
}

/** Parse a node markdown file. Throws a ZodError if the frontmatter is invalid. */
export function parseMarkdown(raw: string): MemoryNode {
  const { data, content } = matter(raw);
  const fm = Frontmatter.parse(normalizeFrontmatter(data));
  return { ...fm, body: content.trim() };
}

/** Serialize a node back to markdown with deterministic key ordering. */
export function toMarkdown(node: MemoryNode): string {
  const fm = Frontmatter.parse(normalizeFrontmatter({ ...node }));
  const ordered: Record<string, unknown> = {};
  for (const key of FRONTMATTER_ORDER) {
    ordered[key] = fm[key];
  }
  return matter.stringify(`\n${node.body.trim()}\n`, ordered).trimStart();
}

/** Build a node id slug from a project + title, keeping it short and collision-resistant. */
export function slugify(project: string, title: string): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const p = clean(project);
  const t = clean(title).split('-').slice(0, 8).join('-');
  return `${p}-${t}`.replace(/-+/g, '-').slice(0, 80).replace(/-+$/g, '');
}
