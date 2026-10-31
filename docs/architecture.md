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
- **Diagrams** - the *Images* job, but no image model is involved. One text call reads the article and answers with a **plan** (JSON: columns of boxes in the order a request travels, closest to the user first; a `control` lane for things that are managed from elsewhere; arrows with protocol / port labels). `diagram.ts` validates the plan (limits, unknown arrows dropped, credentials masked), lays it out deterministically and draws it as SVG. Every word is spelled as the plan says and the picture is the same every time. The plan is stored in the diagram's metadata, so a PDF can paint the same drawing as vectors (landscape page when wide) and the picture can be redrawn without another AI call.
- **PDF** - built from the article and the diagram without any AI call.

A picture holds at most 10 boxes and 14 arrows (more cannot be read: the arrow labels have no room left), so the plan is a **set**: an overview plus detail pictures by topic (request path, data and storage, sign-in and security, ...), at most 5 pictures. The overview is the stored SVG; the detail plans are stored in the metadata and drawn on request at `/p/<project>/diagram/<id>/<n>`; the project page shows the overview in the card with the details as thumbnails below it, and the PDF gives every picture a page of its own after the index (a wide one turned a quarter turn).

Diagrams made earlier by an image model (png/jpg/webp) are still shown and embedded; new ones are svg.

## Automatic updates (Admin -> Auto)

`packages/server/src/auto.ts` lets a company have the documentation kept up to date by itself, for example every Saturday and Sunday at 02:00 when nobody works. An administrator ticks the projects (a scroll box with *Select all* and *Only projects with changes*), ticks **TEXT** (the article) and/or **AI flow charts** (the diagrams), sets the days or a one-time date, the time and time zone, and a **dollar limit per run**. The Admin menu is LLM, Auto, SSO, Audit, License (License is a blank page for now).

What keeps the spending bounded, in order of importance:

1. **No agreement, no call.** *Save schedule...* shows the agreement popup (schedule, model, projects, what is created, estimated and worst-case cost, the highest amount a month can cost). The server only saves the setup together with the one-time token of exactly that setup. The agreement is a fingerprint (`agreementKey`) of the projects, what is created, the dollar limit, the schedule, the model and the token limits and prompts of both jobs; when anything it covers changes the schedule **pauses** (and says so at the top of the tab) until it is agreed again.
2. **A dollar limit per run.** Before every call the worst case of that call (the whole token limit used) is added to what the run has already cost; when the sum would pass the limit the run stops and lists the projects it did not reach. Cost is counted from the tokens the provider reports times the price list in `docgen.ts`; a model without a list price cannot be agreed, because its limit could not be enforced.
3. **Only what changed.** Every article stores a fingerprint of each note it was written from (`DocMeta.noteHashes`). A project is due when a note was added, changed or removed since; charts are due when the newest diagram was not made from the newest article. (An article made before this feature has no fingerprints and counts as changed when a note is dated after it or the number of notes differs.) New projects are listed but not included until ticked.
4. **One AI job at a time**, and a person's button is refused while a run is going. The kill switch (and the pause) are looked at before every single call. A run missed by more than 12 hours (server down) is skipped.

**When the provider cannot be reached** (its name does not resolve, the connection is refused or reset; `ProviderUnreachableError`) the run does not give up on the project: it waits one minute and sends the same call again, for at most 15 minutes in total, and then stops with the rest listed as *not reached* (they stay due for the next run). A minute, because resolvers keep a failed lookup for about that long, so retrying faster only reads the same cached failure. Such a call never arrived and is not billed; the dollar limit, the switch and the agreement are still checked while waiting. An answer that arrived but is bad, a timeout (the request may have been billed) and a refusal are never retried.

**What a run used, and how long it took.** Every run keeps its start and end (the *Runtime* column is the difference) and, per model and per kind, the number of calls, the tokens in and out, the cost and the time the calls took (`AutoRun.usage`; TEXT is the article, IMAGES is the AI flow charts: no image model is involved, the AI writes the plan as text and Mnemosyne draws it, so the IMAGES tokens are text tokens). The Runs list shows the split under every run and the sum of all listed runs above it; the audit line `Run completed: ...` carries the same split and the runtime. The time of a call is only the time the successful try took: a try that failed and the minutes of waiting for the provider are not in it. The cost is the reported tokens times the price list in `docgen.ts`, not what the provider charges (free credits, for example, charge nothing).

Runs made before the split was recorded are filled in once at start-up from the audit trail (`backfillUsage`, `usageFromAudit`): one `auto_start` and one `ai_done` per successful call give the model, the tokens and the time. It is only accepted when the calls found add up to exactly the tokens the run recorded, so a trail that was rotated away or cut can never produce a wrong picture; such a run says that its split is not available. A split that exists is never replaced. Not counted anywhere: a call that reached the provider but returned an unusable answer (its tokens are billed but the run does not see them) and a call cut off by a restart.

A timer inside the portal looks at the clock every 30 seconds (`AutoRunner`); the schedule, the agreement and the last 30 runs live in one JSON file (`MNEMOSYNE_AUTO_FILE`, default `.mnemosyne/auto.json`). A run is persisted after every call, so a deploy that restarts the service ends the call that was running (its result is lost) and the run goes on with the projects not yet done; a project cut off twice is given up on. Automatic calls are audited as `auto_start` / `auto_run` / `auto_agree` events, separate from the `ai_start` events that `MNEMOSYNE_AI_DAILY_LIMIT` counts for people, so a run of many projects is not stopped by the daily number meant for people (its own limit is the dollar limit).

## Fixed addresses (Admin -> LLM, step 2)

When the DNS in front of an AI provider is unstable (a real run lost 25 projects to `EAI_AGAIN` on 2026-10-31), an administrator can pin a host name to an IP address (`packages/server/src/host-pins.ts`). Every connection Mnemosyne itself makes to the provider, the AI calls and the model list, then uses that address and does not ask DNS at all. Only the *lookup* is replaced (the `lookup` option of the connection); the TLS certificate is still checked against the host name, so a wrong address cannot be used to listen in. Nothing else changes: not `/etc/hosts`, not the system resolver, not other connections of the portal (GitLab sign-in and so on). Every AI call opens its own connection, so a pin that was changed or removed applies to the very next call.

The list is kept in the sealed `providers.enc` (`hosts`), loaded at start-up and in force at once when saved (audit: `llm_hosts`, with a diff). *Check* opens a TLS connection to `ip:443` as that host name and reports whether the certificate is valid for it; it sends no request and costs nothing. Rules: host names only (no `http://`, port or path), IPv4 or IPv6, one address per host, at most 20. A pinned address that the provider later gives up makes its calls fail (the Auto run then waits and retries for 15 minutes, as for any unreachable provider) until the entry is changed.

## Reasoning effort (Admin -> LLM, step 4)

Models of the Muse Spark kind think before they answer, and the thinking is written as output tokens: it is waited for and paid for. In the real runs of 2026-10-31 an article call produced about 9,300 output tokens of which only about 4,000 are in the saved article, and a diagram-plan call about 14,000 of which about 1,700 are in the plan, at about 150 tokens a second (59 s and 96 s a call). Each job (Text, Images) therefore has an optional **Reasoning effort** (`minimal`, `low`, `medium`, `high`; `JobSettings.reasoningEffort`). Unset is the default and means the provider decides: nothing is sent, like temperature and top-p, so a provider that does not know the field is never given it by surprise.

It is sent as the top-level field `reasoning_effort` of the chat-completions request, to OpenAI-compatible providers only (the Anthropic format thinks in its own way and never gets it). The field name and place come from third-party documentation (LiteLLM, Vercel, OpenClaw); Meta's own reference was not found and the live effect has not been measured yet. A model that does not accept the field answers HTTP 400; the error then says which effort the job sends and how to take it back. The effort is part of the agreement fingerprint of Auto and of the confirmation token of the page buttons, so changing it asks for a new agreement.

What the provider reports as thinking (`usage.completion_tokens_details.reasoning_tokens`, or `output_tokens_details`) is read from every answer, written to the audit line of the call (`..., N of it reasoning`) and shown per model and kind in the Runs list of Auto (*of it reasoning*; a dash where the provider does not report it). That turns "the model probably thinks a lot" into a measurement per run, and shows what a lower effort saves.

## A Mnemosyne Wiki link in every GitLab project

`packages/server/src/gitlab-links.ts` (command `packages/server/src/bin/gitlab-links.ts`, plain Node, no dependencies) puts two links into every GitLab project so people reach the project's Mnemosyne page from GitLab: the project's **External wiki** integration (GitLab shows it in the project menu in place of its own wiki; the label "External wiki" is GitLab's) and a **badge named "Mnemosyne Wiki"** on the project page (the badge image is served publicly by the portal at `/assets/wiki-badge.svg`). The target is `/p/<slug of the GitLab path>`; the portal resolves that key to the project's real notes project by slug (case, dash and underscore do not matter) and redirects there. Both links are idempotent (a second run changes nothing, a wrong address is corrected).

```bash
# dry run (default): prints what would be done, changes nothing
GITLAB_TOKEN=<token with the api scope, Maintainer on the projects> node packages/server/dist/bin/gitlab-links.js \
  --gitlab-url https://gitlab.example.com --portal-url https://host:40000/mnemosyne
# ... --apply   to do it;   --only group/project   to limit it;   --no-badge / --no-wiki   for one of the two links
```

In this deployment the CI/CD job `gitlab_wiki_links` runs it with the Vault-held GitLab token after every deploy and once a day from a pipeline schedule, so new projects get the links too.
