import { z, type ZodRawShape } from 'zod';
import { LINK_RELS, NODE_STATUSES, NODE_TYPES } from '@mnemosyne/core';
import type { MnemosyneService } from './service.js';

export interface ToolDef {
  name: string;
  description: string;
  /** raw shape for MCP `registerTool` */
  shape: ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const codeRefShape = {
  repo: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  symbol_id: z.string().optional(),
};

const nodeWriteShape = {
  title: z.string().min(1),
  type: z.enum(NODE_TYPES),
  project: z.string().min(1),
  status: z.enum(NODE_STATUSES).optional(),
  body: z.string().min(1),
  components: z.array(z.string()).optional(),
  code_refs: z.array(z.object(codeRefShape)).optional(),
  links: z.array(z.object({ rel: z.enum(LINK_RELS), target: z.string() })).optional(),
  authors: z.array(z.string()).optional(),
  observed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  supersedes: z.string().nullable().optional(),
};

/** The nine tools, shared verbatim by the MCP server and the REST API. */
export function buildTools(svc: MnemosyneService): ToolDef[] {
  const parse = <T extends ZodRawShape>(shape: T, args: unknown) => z.object(shape).parse(args);

  return [
    {
      name: 'search_memory',
      description:
        'Search team memory. mode "hybrid" (default) fuses full-text and semantic search; "text" or "semantic" force one. Filter by project/type/status.',
      shape: {
        query: z.string().min(1),
        mode: z.enum(['hybrid', 'text', 'semantic']).optional(),
        project: z.string().optional(),
        type: z.enum(NODE_TYPES).optional(),
        status: z.enum(NODE_STATUSES).optional(),
        limit: z.number().int().positive().max(50).optional(),
      },
      handler: async (args) => {
        const q = parse(
          {
            query: z.string(),
            mode: z.enum(['hybrid', 'text', 'semantic']).optional(),
            project: z.string().optional(),
            type: z.string().optional(),
            status: z.string().optional(),
            limit: z.number().optional(),
          },
          args,
        );
        const hits = await svc.search(q);
        return hits.map((h) => ({
          id: h.node.id,
          title: h.node.title,
          type: h.node.type,
          status: h.node.status,
          project: h.node.project,
          score: Number(h.score.toFixed(4)),
          matched: h.matched,
          excerpt: h.node.body.slice(0, 280),
        }));
      },
    },
    {
      name: 'get_node',
      description: 'Fetch one memory node in full, including git-derived created/updated timestamps.',
      shape: { id: z.string() },
      handler: async (args) => {
        const { id } = parse({ id: z.string() }, args);
        const node = await svc.getNode(id);
        if (!node) throw new Error(`node ${id} not found`);
        return node;
      },
    },
    {
      name: 'get_node_history',
      description: 'Git commit history for a node (who changed it, when, and the commit message).',
      shape: { id: z.string(), limit: z.number().int().positive().max(200).optional() },
      handler: async (args) => {
        const { id, limit } = parse(
          { id: z.string(), limit: z.number().optional() },
          args,
        );
        return svc.getHistory(id, limit);
      },
    },
    {
      name: 'create_node',
      description:
        'Create a memory node: writes nodes/<project>/<id>.md, commits it, and indexes it. id is derived from project+title unless given.',
      shape: { id: z.string().optional(), ...nodeWriteShape },
      handler: async (args) => {
        const input = parse({ id: z.string().optional(), ...nodeWriteShape }, args);
        const { node, commit } = await svc.createNode(input);
        return { id: node.id, commit, path: `nodes/${node.project}/${node.id}.md` };
      },
    },
    {
      name: 'update_node',
      description: 'Merge changes into an existing node (any writable field), re-commit and re-index.',
      shape: {
        id: z.string(),
        ...Object.fromEntries(
          Object.entries(nodeWriteShape).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()]),
        ),
      },
      handler: async (args) => {
        const { id, ...patch } = parse(
          {
            id: z.string(),
            ...Object.fromEntries(
              Object.entries(nodeWriteShape).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()]),
            ),
          },
          args,
        ) as { id: string } & Record<string, unknown>;
        const { node, commit } = await svc.updateNode(id, patch);
        return { id: node.id, commit };
      },
    },
    {
      name: 'link_nodes',
      description: 'Add a typed relationship from one node to another.',
      shape: { from: z.string(), rel: z.enum(LINK_RELS), to: z.string() },
      handler: async (args) => {
        const { from, rel, to } = parse(
          { from: z.string(), rel: z.enum(LINK_RELS), to: z.string() },
          args,
        );
        const { commit } = await svc.linkNodes(from, rel, to);
        return { from, rel, to, commit };
      },
    },
    {
      name: 'link_node_to_code',
      description:
        'Attach a code reference (repo + path, optional line and CodeGraph symbol id) to a node.',
      shape: { id: z.string(), ...codeRefShape },
      handler: async (args) => {
        const { id, ...ref } = parse({ id: z.string(), ...codeRefShape }, args) as {
          id: string;
          repo: string;
          path: string;
          line?: number;
          symbol_id?: string;
        };
        const { commit } = await svc.linkNodeToCode(id, {
          repo: ref.repo,
          path: ref.path,
          line: ref.line ?? null,
          symbol_id: ref.symbol_id ?? null,
        });
        return { id, ref, commit };
      },
    },
    {
      name: 'neighbors',
      description:
        'Breadth-first walk of a node\'s links. depth defaults to 1; rel filters the relationship kinds; set bidirectional=false to only follow declared direction.',
      shape: {
        id: z.string(),
        rel: z.array(z.enum(LINK_RELS)).optional(),
        depth: z.number().int().positive().max(5).optional(),
        bidirectional: z.boolean().optional(),
      },
      handler: async (args) => {
        const { id, rel, depth, bidirectional } = parse(
          {
            id: z.string(),
            rel: z.array(z.enum(LINK_RELS)).optional(),
            depth: z.number().optional(),
            bidirectional: z.boolean().optional(),
          },
          args,
        );
        return svc.neighbors(id, { rel, depth, bidirectional });
      },
    },
    {
      name: 'reindex',
      description: 'Rebuild the search index from the markdown corpus. Run after bulk edits.',
      shape: {},
      handler: async () => svc.reindex(),
    },
  ];
}
