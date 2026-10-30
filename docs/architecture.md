# Architecture

## One core, three façades

```
                 ┌─────────────────────────────────────────┐
   Claude Code   │  packages/core   (@mnemosyne/core)       │
   Claude Desktop│   • MemoryNode schema (zod)              │
      stdio  ───▶│   • markdown ⇄ node (gray-matter)        │
                 │   • SearchBackend / Embedder / LLM ifaces│
   self-hosted   │   • graph BFS, RRF fusion                │
   AI runtime    └───────────────┬─────────────────────────┘
   MCP-capable                   │
   editors  ─── MCP/HTTP ───▶ packages/server (mnemosyne)
                                 │   • SqliteBackend: FTS5 + sqlite-vec
   non-MCP    ─── REST ──────▶   │   • GitOps: commit = audit trail
   clients                       │   • OpenAI-compatible embedder / LLM
                                 │   • the 9 tools  → MCP + REST
                                 ▼
                       nodes/<project>/<id>.md   ← source of truth (git)
                       .mnemosyne/index.db       ← rebuildable cache
```

- **Model-agnostic.** The server never calls an LLM to serve a read or write. The
  orchestrator driving the model (editor agent loop, or a gateway with an MCP client)
  calls mnemosyne's tools.
- **The nine tools in `packages/server/src/tools.ts` are the single API.** `mcp.ts` and
  `http.ts` both wrap that array. Add capability there.

## Data model

A memory node is a markdown file with YAML frontmatter (`packages/core/src/schema.ts`):

| field | notes |
|---|---|
| `id` | lowercase-kebab slug, unique; derived from `project` + `title` if omitted |
| `title` | one line |
| `type` | `decision` \| `status` \| `gotcha` \| `howto` \| `reference` |
| `status` | `working` \| `broken` \| `in-progress` \| `resolved` \| `n/a` |
| `project` | groups nodes; also the directory under `nodes/` |
| `components` | free tags (`waf`, `atl-lb-05`, ...) — indexed for search |
| `code_refs` | `[{ repo, path, line?, symbol_id? }]`; `symbol_id` lines up with CodeGraph |
| `links` | `[{ rel, target }]`, `rel` ∈ `depends-on` \| `supersedes` \| `relates-to` \| `caused-by` |
| `authors`, `observed_at`, `supersedes` | provenance |
| body | free-text observation / reasoning |

`created_at` / `updated_at` / `source_commit` are **not** stored — they come from
`git log --follow` of the file when a node is loaded.

## Search

`SqliteBackend` (`packages/server/src/sqlite-backend.ts`):

- **Lexical** — an FTS5 table (`porter unicode61`) over title + body + components, ranked
  by `bm25()`.
- **Semantic** — a `sqlite-vec` `vec0` table, KNN by L2 distance.
- **Hybrid** (default) — Reciprocal Rank Fusion of the two id lists
  (`packages/core/src/fuse.ts`, k=60). Filters (`project` / `type` / `status`) are applied
  after retrieval; the corpus is small enough that over-fetch + post-filter is cheap.

If the embedder's dimensionality changes, the `vec0` table is dropped on next open and a
`reindex` repopulates it.

## Graph

`neighbors()` (`packages/core/src/graph.ts`) is a breadth-first walk over `links`,
bidirectional by default, with an optional `rel` filter and `depth`. That is the entire
"graph database" — at team-memory scale (thousands of nodes) an in-memory BFS beats
operating Neo4j / AGE.

## Embeddings & LLM

Both are pluggable and optional (`packages/server/src/embedding.ts`):

- Embedder: `MNEMOSYNE_EMBED_BASE_URL` → OpenAI-compatible endpoint; else `fastembed`
  (local ONNX) if installed; else `HashEmbedder` (offline, deterministic, modest quality).
  Force the last with `MNEMOSYNE_EMBED_BACKEND=hash`.
- LLM: only constructed if `MNEMOSYNE_LLM_BASE_URL` is set. Powers `mnemosyne extract`
  (git history → candidate nodes under `nodes/_candidates/`) and REST `POST /ask` (RAG).

## Why not a resident search daemon

The reference deployment co-locates with GitLab on a host with ~125 MB free RAM, already
into swap. A JVM (OpenSearch) or in-RAM index (Typesense) does not fit; Meilisearch would
push GitLab further into swap. Embedded SQLite rides inside the server process at ~tens of
MB. A `MeilisearchBackend` remains possible behind `SearchBackend` for RAM-rich hosts.

## Generated documentation and the architecture diagram

The portal (`packages/server/src/web.ts`) turns a project's notes into a documentation page, a diagram and a PDF. Nothing calls a model unless an administrator presses a button and agrees to the cost (`ai-jobs.ts` holds every editable value: limits, sampling, prompts).

- **Article** - the *Text* job: one chat call writes the page from all notes of the project (`docgen.ts`).
- **Diagram** - the *Images* job, but no image model is involved. One text call reads the article and answers with a **plan** (JSON: columns of boxes in the order a request travels, closest to the user first; a `control` lane for things that are managed from elsewhere; arrows with protocol / port labels). `diagram.ts` validates the plan (limits, unknown arrows dropped, credentials masked), lays it out deterministically and draws it as SVG. Every word is spelled as the plan says and the picture is the same every time. The plan is stored in the diagram's metadata, so a PDF can paint the same drawing as vectors (landscape page when wide) and the picture can be redrawn without another AI call.
- **PDF** - built from the article and the diagram without any AI call.

Diagrams made earlier by an image model (png/jpg/webp) are still shown and embedded; new ones are svg.
