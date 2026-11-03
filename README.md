<p align="center">
  <img src="docs/images/mnemosyne-logo.png" alt="Mnemosyne logo: a brain made of connected nodes inside a laurel wreath" width="190">
</p>

# Mnemosyne

Self-hosted **AI team memory** and **corporate wiki**. A git-backed graph of memory *nodes* — what is where, what state it is in, when
it was done, how — that any MCP-capable AI reads and writes, and that Mnemosyne turns into documentation for every project of your GitLab
server: a Wikipedia-style article, a workflow diagram and a PDF handbook, kept up to date automatically with Meta's Muse models.

Open source under the [Apache License 2.0](LICENSE). Free for up to 5 people; a licence lifts the limit (see [Editions](#editions)).

## What it does

- **Memory:** markdown files with YAML frontmatter in a git repo are the source of truth; `git log` is the audit trail. Embedded SQLite
  search — FTS5 (lexical) + `sqlite-vec` (semantic), fused with RRF — no search daemon, tens of MB resident.
- **Interfaces:** one core behind MCP over stdio, MCP over Streamable HTTP, and plain REST. Nine tools: `search_memory` · `get_node` ·
  `get_node_history` · `create_node` · `update_node` · `link_nodes` · `link_node_to_code` · `neighbors` · `reindex`.
- **Corporate wiki:** people sign in with GitLab and see the documentation of the projects they belong to. An administrator generates (or
  schedules) the article for a project from all of its notes, the workflow diagram, and a PDF handbook with cover, index and the diagram pages.
- **AI jobs with Meta Muse models:** the text model (for example `muse-spark-1.3-contributor`) writes the article and plans the diagram; the
  image model (`muse-image-1.0`) paints every picture of the plan from the exact words of its boxes and arrows. Any OpenAI-compatible provider
  works; the model per job, limits, sampling and prompts are set in the admin.
- **Spending under control:** nothing calls a model unless an administrator agrees to the estimated cost in a popup (one-time, signed token), or has
  agreed to an automatic schedule with a dollar limit per run. **LLM usage** is the cost center: every AI job, who started it, what each model used,
  what it cost, per month.
- **Personal MCP tokens:** every person can issue their own token (1 to 90 days, shown once, revocable) from their profile.
- **Model-agnostic and private:** reading and writing memory never calls a model; embeddings and the optional `extract` / `/ask` features
  target any OpenAI-compatible gateway, and with none configured it runs fully offline. Git is the only hard requirement.

## Editions

One code base, two editions. The limits are enforced by the admin program (`admin-go/`); a licence key (Admin → License) lifts them.

| | Free (no key) | Licensed |
|---|---|---|
| People | up to **5** — the first to sign in take the seats, the 6th is refused | the seats of the licence |
| Audit tab | the **last 10 records** (no paging, no search) | the whole history, paging and search |
| Admin sign-in | the built-in admin account | the built-in account **and GitLab sign-in** (SSO set-up in the admin) |
| Everything else (memory, MCP/REST, documentation, diagrams, PDF, Auto, LLM usage) | included | included |

A licence that runs out or cannot be confirmed falls back to the free edition; nothing ever locks. Without a key the licence server is never
contacted. Licences and support: <https://lumanet.info/mnemosyne>.

## Install on a Linux server

Download `release/mnemosyne_<version>.zip` (one zip per release, checksums in `release/SHA256SUMS`), unpack it and run the installer:

```bash
unzip mnemosyne_0.6.1.zip && cd mnemosyne_0.6.1
sudo ./install.sh --public-url https://mnemosyne.example.com --listen 127.0.0.1:40001
```

It needs Node.js 20+, git and curl on a Linux server with systemd (amd64 or arm64). It installs the server in `/opt/mnemosyne`, the admin
program in `/usr/local/bin`, creates the notes repository in `/var/lib/mnemosyne`, writes `/etc/mnemosyne.env` once (random secret, built-in admin
account, password printed at the end), starts a systemd service and waits for it to answer. Run it again with a newer zip to upgrade: settings and
data are kept. Details, reverse proxy and GitLab sign-in: [docs/self-hosting.md](docs/self-hosting.md).

From source: `npm install && npm run build`, then `cd admin-go && make build` for the admin program (Go 1.27).

## Screenshots

### 1. Sign in with GitLab

![Mnemosyne sign-in page](docs/images/screenshot-1-sign-in.png)

The public entry page. Everyone signs in with their own GitLab account; Mnemosyne never keeps a separate password list. After signing in, a person
only sees the documentation of the GitLab projects they belong to (GitLab administrators see every project). MCP clients connect to
`/mnemosyne/mcp`.

### 2. Your projects

![Mnemosyne project overview](docs/images/screenshot-2-your-projects.png)

The home page after sign-in: one card for every GitLab project the person belongs to. The turquoise ring in the corner is the project's GitLab ID
(a dash means no GitLab project matches the notes; those cards are visible to administrators only). Each card shows the GitLab path, the number of
notes and the date of the last update. A project page shows the generated documentation — product description, features, specifications, hardware
and software requirements, disaster recovery and the change history of the latest notes — with the painted workflow diagram in the card at the top
right, and a button for the PDF handbook.

### 3. Admin: connect an AI provider and choose a model per job

![Mnemosyne admin, LLM tab](docs/images/screenshot-3-admin-llm.png)

Administrators connect an AI provider: (1) enter the provider and its API key (stored encrypted, never shown again), (2) fetch the models that key
can really use (this only reads the model list and costs nothing), (3) choose one model each for text, images and the PDF job, and set limits,
sampling, reasoning effort and the prompts of every job. The **workflow diagram** is made in two steps: the text model writes a plan of the system
(an overview and, for a bigger system, detail pictures: boxes, arrows, ports); the image model then paints every picture of the plan from the exact
words of the plan, with an editable *Instruction for the picture* (the built-in text names no colours and asks for straight horizontal and vertical
lines). The painted pictures are on the project page and in the PDF, and a new run **replaces** all earlier diagrams of the project. With no image
model chosen, Mnemosyne draws the plan itself as exact SVG.

### 4. Admin: audit trail

![Mnemosyne admin, audit tab](docs/images/screenshot-4-admin-audit.png)

Every sign-in, failed sign-in and change in the admin area, and every AI agreement and run, is written to an audit log (date, event, entity, name,
description; user and IP address are blacked out in this picture on purpose). Secrets are never written to the log. The licensed edition pages and
searches the whole history; the free edition shows the last 10 records.

## The admin area

`/mnemosyne/admin` is served by the admin program in front of the server. Its tabs:

| tab | what it does |
|---|---|
| **LLM** | providers and API keys, fixed addresses for providers behind unstable DNS, one model per job (text, images, PDF) with limits, sampling, reasoning effort and prompts |
| **LLM usage** | the cost center: cost per month (TEXT / IMAGES / PICTURES) and every AI job, ten to a page — who started it, project, what each model used, cost |
| **LLM auto** | keep the documentation up to date by itself: projects, what to create, schedule, a dollar limit per run, and the agreement that is required before anything runs |
| **SSO** | the GitLab application for sign-in (licensed edition) |
| **Audit** | every sign-in and change (free edition: the last 10 records) |
| **License** | the edition, the people against the limit, the licence key |

## Connect an AI

MCP-capable client (Claude Code, Continue, Cline, ...). People create their own token under *Profile → MCP access*:

```jsonc
// HTTP (shared)
{ "mcpServers": { "mnemosyne": { "url": "https://host/mnemosyne/mcp",
                                 "headers": { "Authorization": "Bearer mnm_..." } } } }
// stdio (local)
{ "mcpServers": { "mnemosyne": { "command": "mnemosyne", "args": ["serve", "--stdio"] } } }
```

Claude Code: `claude mcp add --transport http mnemosyne https://host/mnemosyne/mcp --header "Authorization: Bearer mnm_..."`.
Non-MCP client: `POST /mnemosyne/search` to pull nodes into the prompt, `POST /mnemosyne/nodes` to write back.

## Repository layout

| path | what |
|---|---|
| `packages/core` | `@mnemosyne/core`: node schema (zod), markdown ⇄ node, search interfaces, graph, RRF fusion. No I/O |
| `packages/server` | the server: SQLite backend, git ops, the nine tools (MCP + REST), the web portal (GitLab sign-in, project pages, documentation, PDF) |
| `admin-go` | the admin program in Go: the front door (starts the server, serves the admin, passes everything else on), LLM / Auto / usage / SSO / audit / licence, the AI engine of the automatic runs |
| `packages/vscode-extension` | thin human UI for VS Code (tree view, capture, CodeLens) |
| `bin` | compiled admin program (linux amd64 + arm64, `SHA256SUMS`) |
| `release` | one zip per release with `install.sh` |
| `deploy` | scripts: building the release zip, deployment helpers |
| `docs` | [architecture](docs/architecture.md), [self-hosting](docs/self-hosting.md) |

Tests: `npm test` (server and core, vitest) and `cd admin-go && make test` (Go; the tests that compare with the Node code skip themselves when
the Node build is not next to it). History of changes: [CHANGELOG.md](CHANGELOG.md).

## License

Open source under the [Apache License 2.0](LICENSE) — see also [NOTICE](NOTICE). © 2026 GCD Investment Group, sold under the LSE Group Corporation
brand. Free for up to 5 people; a licence (<https://lumanet.info/mnemosyne>) lifts the limit and adds the full Audit history and GitLab sign-in
for the admin area.
