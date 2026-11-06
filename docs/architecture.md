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
| `components` | free tags (`waf`, `lb-01`, ...) — indexed for search |
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

The portal (`packages/server/src/web.ts`) turns a project's notes into a documentation page, a diagram and a PDF. Nothing calls a model unless a person who is allowed to presses a button and agrees to the cost (`ai-jobs.ts` holds every editable value: limits, sampling, prompts). Who is allowed is set in the admin area under **Access**: one switch per level - GitLab administrators, and the access level of the person on the GitLab project of the notes (owner, maintainer, developer, reporter, guest; the higher of project and group access, read from GitLab at sign-in and every 12 hours). With nothing saved, administrators and owners may. The switches live in the sealed settings file (`generate`) that both programs read; the Node server checks them on every estimate and every start (`gate(..., 'generate')` in `web.ts`), so a hidden button is not the protection. Reading the source notes, the admin area and the scheduler stay with GitLab administrators.

- **Article** - the *Text* job: one chat call writes the page from all notes of the project (`docgen.ts`).
- **Diagrams** - the *Images* job. Step 1: one text call reads the article and answers with a **plan** (JSON: columns of boxes in the order a request travels, closest to the user first; a `control` lane for things that are managed from elsewhere; arrows with protocol / port labels). `diagram.ts` validates the plan (limits, unknown arrows dropped, credentials masked). Step 2: the **image model** chosen for the *Images* job paints every picture of the plan (`llm-call-image.ts`; the prompt is the editable *Instruction for the picture*, `{{plan}}` = every box and arrow with the exact words, built by `planWords` in `docgen.ts`; no colours are named and only straight horizontal and vertical lines are asked for). The painted overview is stored as `diagram-<stamp>.png|jpg|webp`, each detail picture as `diagram-<stamp>-<n>.<ext>`, the plan and the models in `diagram-<stamp>.json`. **A new set replaces everything the project had**: once the overview is painted every other `diagram-*` and `picture-*` file of the project is deleted (`DocStore.pruneDiagrams`); if the overview cannot be painted nothing is touched. With no image model chosen `diagram.ts` lays the plan out deterministically and draws it as SVG (every word exactly as planned; the PDF paints the same plan as vectors) - the same replace rule applies.
- **PDF** - built from the article and the diagram pictures (the overview first, then every detail picture, each on a page of its own; a wide picture is turned a quarter turn so it fills the page) without any AI call.

A picture holds at most 10 boxes and 14 arrows (more cannot be read: the arrow labels have no room left), so the plan is a **set**: an overview plus detail pictures by topic (request path, data and storage, sign-in and security, ...), at most 5 pictures. The overview is the stored file; the detail pictures are served at `/p/<project>/diagram/<id>/<n>` (the painted file, or - with no image model - drawn on request from the plan stored in the metadata); the project page shows the overview in the card with the details as thumbnails below it, and the PDF gives every picture a page of its own after the index.

Diagrams made before 2026-10-30 by an image model alone (png/jpg/webp, no plan) are still shown and embedded.

## LLM usage (Admin -> LLM usage)

Every AI job is one line in `usage.jsonl` (next to the audit trail; both the server and the admin program append to it): `time`, `end`, `trigger` (`person` or `auto`), `by`, `project`, `kind` (`wiki`, `diagram`, `auto-run` for the history imported from before), `status`, and `lines` - one per model and part (`TEXT`, `IMAGES` = the text call that plans the diagram, `PICTURES` = the image model, with calls, tokens in / out, reasoning tokens, cost, time). The tab sums the cost per month (UTC, the month the job started in) and lists the jobs ten to a page. The cost is tokens x the list price of the model (one price per picture; `muse-image-1.0` about $0.01); providers report tokens, not money, so the provider's billing page stays the truth. The automatic runs before every job was logged were imported once, one line per run (`usage.jsonl.imported` is the marker).

## The admin program (Go)

`admin-go/` is a separate static Go program that runs **in front of** the server (`cmd/mnemosyne-admin`). It listens on `MNEMOSYNE_ADMIN_LISTEN`
(default `127.0.0.1:40001`), starts the Node server as its child on `MNEMOSYNE_UPSTREAM` (default `127.0.0.1:40002`, `internal/supervisor`,
command from `MNEMOSYNE_NODE_CMD`), serves everything under `<base>/admin` itself and passes every other request on (a reverse proxy, `internal/web`).
The server has no admin of its own (it answers 404 there) and no scheduler. The two programs share the same sealed files (AES-256-GCM, key derived from
`MNEMOSYNE_SECRET`: providers, settings, members, tokens), the same signed cookies, the audit trail and the usage log, so nothing has to be migrated and
a person who is signed in stays signed in.

| package | what |
|---|---|
| `internal/secrets`, `internal/store`, `internal/config`, `internal/audit` | the shared formats: sealed files, cookies, scrypt hash, environment, audit lines |
| `internal/jobs` | the AI jobs (text, images, PDF): definitions with their built-in prompts (rendered from `packages/server/src/ai-jobs.ts` by `make assets`), validation of the admin form |
| `internal/engine` | the AI engine of the automatic runs: notes, prompts, the chat call, the image call, the diagram plan and its SVG drawing, the document store |
| `internal/auto` | the scheduler: schedule maths, agreement fingerprint, cost summary, the runner |
| `internal/usage` | the cost center (`usage.jsonl`) |
| `internal/license` | the licence client; `internal/web` applies the edition |
| `internal/web` | sign-in (built-in account, GitLab SSO), the admin page and API, the front door |

The jobs a person starts with a button on a project page run in the **server** (`packages/server/src/web.ts`, `docgen.ts`, `diagram.ts`); the automatic
runs run in the **admin program** (`internal/engine`). The two engines are ports of one another and are kept identical by tests: shared fixtures
(for example `packages/server/test/fixtures/picture-prompt.json` and `admin-go/testdata/golden/picture-prompt.json` hold the same prompt), and
`admin-go/testdata/gen/*.mjs` run the real Node code to produce what the Go tests compare with.

## Editions (Free and Licensed)

The code is Apache-2.0; the limits are applied by the admin program (`internal/web/license.go`).

- **Trial** (the first 30 days of an installation, granted by the licence server at the first contact): everything of the licensed edition with no seat limit. The licence server answers `trial` (with the end of the 30 days) or `trial-expired`; the trial is counted from the first time the server saw the installation's address or domain, so local files cannot restart it. At the end the installation **reverts to the free edition** and keeps running: people who already hold a seat keep it and keep working, nobody new is admitted above the limit, the Audit API shows the last 10 records, GitLab sign-in for the admin area stops (the built-in account stays). The install id and the last signed answer are kept in `license.enc`; the License tab shows the days left.
- **Free** (no licence key, or a key that cannot be confirmed, after the trial or while the licence server cannot be reached): `FreeSeats = 4` people (5 or more seats need a licence), the Audit API returns the last `FreeAuditRecords = 10` records whatever
  is asked, the admin area signs in with the built-in account only (GitLab sign-in for the admin area and the SSO set-up are refused), and the licence server is only asked for the trial.
- **Licensed** (a key confirmed by the licence server, or within its renewal period): as many people as the licence has seats, the whole audit history, GitLab
  sign-in and SSO set-up. The key is entered under Admin → License (or `MNEMOSYNE_LICENSE_KEY` once) and bound to the installation id and the domain.

**Seats.** A sealed register (`MNEMOSYNE_SEATS_FILE`, default `.mnemosyne/seats.enc`; per person the time the seat was taken and the time the person was last seen, the
latter written at most once a minute; the first version of the file, user -> time, still loads) holds the people who use the installation. The front door looks at the portal's
session cookie (`mnemosyne_session`, verified with the shared signing key): the first people seen take the seats up to the limit; a person without a seat gets HTTP 402 (a page, or
JSON `seats_exhausted`) and the cookie is cleared; one audit entry per person per hour. Anonymous requests and `/health` are never touched. **Admin -> Users** (`GET /admin/api/users`,
`DELETE /admin/api/users/<name>`) shows the register joined with what the server knows (`members.enc`: GitLab administrator or member, last GitLab confirmation, number of projects;
`tokens.enc`: active personal MCP tokens) and the people refused since the program started; *Free this seat* removes a person from the register (audit event `seat_release`) without
blocking them or touching their tokens. There are no local user accounts: the portal signs people in with GitLab only.

**The licence protocol.** A licence server answers `/validate` and `/heartbeat` with an **Ed25519-signed attestation** (product, domain, installation id, a
nonce, state, seats, licence end, expiry). The program verifies it with a public key compiled in (`internal/license/pubkey.go`, replaceable at build time),
keeps the last good answer for at most 7 days, refuses answers for another installation or nonce, notices a clock set back, and asks again every 12 hours.
A signed refusal, an expired licence or no answer for longer than the last attestation lasts means the free edition; there is no lock-out.

## Automatic updates (Admin -> LLM auto)

`admin-go/internal/auto` keeps the documentation of a company up to date by itself, for example every Saturday and Sunday at 02:00 when nobody works. An
administrator ticks the projects, ticks **TEXT** (the article) and/or **AI flow charts** (the workflow diagram), sets the days or a one-time date, the time
and time zone, and a **dollar limit per run**. The admin menu is LLM, LLM usage, LLM auto, SSO, Audit, License.

What keeps the spending bounded, in order of importance:

1. **No agreement, no call.** *Save schedule...* shows the agreement popup (schedule, models, projects, what is created, estimated and worst-case cost, the highest
   amount a month can cost). The setup is only saved together with the one-time token of exactly that setup. The agreement is a fingerprint (`AgreementKey`) of the
   projects, what is created, the dollar limit, the schedule, the text model, **the image model**, and the token limits and prompts of both jobs; when anything it
   covers changes the schedule **pauses** (and says so at the top of the tab) until it is agreed again. (Editing only the *Instruction for the picture* changes no cost
   and needs no new agreement.)
2. **A dollar limit per run.** Before every call the worst case of that call (the whole token limit used, plus up to five pictures for a diagram) is added to what the
   run has already cost; when the sum would pass the limit the run stops and lists the projects it did not reach. A model without a list price cannot be agreed,
   because its limit could not be enforced.
3. **Only what changed.** Every article stores a fingerprint of each note it was written from (`noteHashes`). A project is due when a note was added, changed or
   removed since; charts are due when the newest diagram was not made from the newest article. New projects are listed but not included until ticked.
4. **One AI job at a time** (`ai-busy.json`, shared with the server), and a person's button is refused while a run is going. The kill switch and the pause are looked
   at before every single call. A run missed by more than 12 hours is skipped.

**When the provider cannot be reached** (its name does not resolve, the connection is refused or reset; `UnreachableError`) every call is first sent again up to three more times with exponential
backoff (1.5 s, 3 s, 6 s; the same for an answer 429, 500, 502, 503 or 504, which is not billed). If it still fails, the run waits and sends the same call again after growing pauses of 1, 2, 4 and
8 minutes (`OutageSteps`, 15 minutes in all). A project that still cannot be reached is **given up on and the run goes on with the next project**; the given-up project is listed as failed and
stays due for the next run. After `MaxGiveUps = 3` projects in a row the provider is taken to be down: the run stops and lists the rest as *not reached*. An answer that arrived but is bad, a refusal
(400, 401, 403) and a timeout are never retried (a timed-out request may have been billed). A diagram job whose text call was billed but whose overview picture cannot be painted is a plain failure
(never retried: that would bill the plan call again) and the earlier diagrams of the project are kept.

Every automatic job is written to the cost center (`usage.jsonl`, see below) and to the audit trail (`auto_start` / `ai_done` / `auto_agree` ...). The schedule, the
agreement, the live run and the last 30 runs live in `MNEMOSYNE_AUTO_FILE` (default `.mnemosyne/auto.json`); the Auto tab shows the live progress and the last run, the
details are in LLM usage. A run is persisted after every call, so a restart ends only the call that was running.

## Fixed addresses (Admin -> LLM, step 2)

When the DNS in front of an AI provider is unstable (a real run lost 25 projects to `EAI_AGAIN` on 2026-10-31), an administrator can pin a host name to an IP address. The pin is a **fallback, not a
replacement**: Mnemosyne asks DNS first (the lookup gets 5 seconds, the addresses it returns 10 seconds); only when the lookup fails or none of the addresses can be connected to does the connection go to the
pinned address (`internal/llm`, `dial`; `packages/server/src/host-pins.ts` does the same for the server). A host that resolves is never redirected, so a pin that has gone stale cannot break a working provider.
The certificate is still checked against the host name; nothing else changes (not `/etc/hosts`, not other connections of the portal). The list is kept in the sealed `providers.enc` (`hosts`) and is in force at
once when saved (audit: `llm_hosts`). The LLM tab shows for every pin when it was last **verified** (*Check* opens a TLS connection to `ip:443` as that host name and reports whether the certificate is
valid for it; it sends no request and costs nothing) and when it last **had to stand in** because DNS failed (since the program started). Rules: host names only, IPv4 or IPv6, one address per host, at
most 20.

## Reasoning effort (Admin -> LLM, step 4)

Models of the Muse Spark kind think before they answer, and the thinking is written as output tokens: it is waited for and paid for. Each text job (Text, Images) has an
optional **Reasoning effort** (`minimal`, `low`, `medium`, `high`). Unset means the provider decides: nothing is sent, like temperature and top-p. It is sent as the
top-level field `reasoning_effort` of the chat-completions request, to OpenAI-compatible providers only; a model that does not accept the field answers HTTP 400 and the
error says which effort the job sends and how to take it back. The effort is part of the agreement fingerprint of Auto and of the confirmation token of the page buttons.
What the provider reports as thinking (`usage.completion_tokens_details.reasoning_tokens`) is read from every answer, written to the audit line of the call and shown per
model in LLM usage.

## A Mnemosyne Wiki link in every GitLab project

`packages/server/src/gitlab-links.ts` (command `packages/server/src/bin/gitlab-links.ts`, plain Node, no dependencies) puts two links into every GitLab project so people reach the project's Mnemosyne page from GitLab: the project's **External wiki** integration (GitLab shows it in the project menu in place of its own wiki; the label "External wiki" is GitLab's) and a **badge named "Mnemosyne Wiki"** on the project page (the badge image is served publicly by the portal at `/assets/wiki-badge.svg`). The target is `/p/<slug of the GitLab path>`; the portal resolves that key to the project's real notes project by slug (case, dash and underscore do not matter) and redirects there. Both links are idempotent (a second run changes nothing, a wrong address is corrected).

```bash
# dry run (default): prints what would be done, changes nothing
GITLAB_TOKEN=<token with the api scope, Maintainer on the projects> node packages/server/dist/bin/gitlab-links.js \
  --gitlab-url https://gitlab.example.com --portal-url https://host:40000/mnemosyne
# ... --apply   to do it;   --only group/project   to limit it;   --no-badge / --no-wiki   for one of the two links
```

In this deployment the CI/CD job `gitlab_wiki_links` runs it with the Vault-held GitLab token after every deploy and once a day from a pipeline schedule, so new projects get the links too.
