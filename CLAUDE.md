# mnemosyne — repo guide for AI assistants

Self-hosted AI team-memory: a git-backed graph of memory **nodes**, served over **MCP**
(stdio + Streamable-HTTP) and **REST**. External product — **no dependency on any private
infrastructure** (no Vault/OpenBao, no LDAP, no company-specific services). Git is the only
hard dependency.

## Layout

- `packages/core` — `@mnemosyne/core`: node schema (zod), markdown⇄node, `SearchBackend` /
  `Embedder` / `LLM` interfaces, graph BFS, RRF fusion. No I/O, no heavy deps.
- `packages/server` — `mnemosyne` CLI + library: `SqliteBackend` (FTS5 + `sqlite-vec`),
  git ops, OpenAI-compatible adapters, the 9 tools, MCP + HTTP wiring.
- `packages/vscode-extension` — thin human UI (tree view, "Capture memory", CodeLens).
  The AI path is MCP, not this extension.
- `admin-go` — the admin program in Go (open source, same repo): the front door that starts the server as its child, serves `/mnemosyne/admin`
  (LLM, LLM usage, LLM auto, SSO, Users, Audit, License), runs the automatic documentation updates, applies the free/licensed edition (4 free seats, last 10 audit
  records, no admin GitLab sign-in without a licence). Module `github.com/lsegroup/mnemosyne/admin-go`; `make test`, `make build`.
- `bin/` compiled admin program, `release/` one zip per release with `install.sh`, `deploy/make-release.sh` builds it.
- `nodes/` — the markdown corpus (source of truth). `docs/` — architecture & self-hosting.

## Rules

- **Source of truth is `nodes/*.md`.** SQLite (`.mnemosyne/index.db`) is a rebuildable
  cache — never treat it as authoritative, never commit it.
- **The 9 tools in `packages/server/src/tools.ts` are the one API.** MCP and REST both wrap
  that array; add capability there, not in one surface only.
- Keep `core` free of Node-only and native deps so the extension can bundle it.
- Embeddings and chat are pluggable and **optional**: default is offline (`HashEmbedder` /
  no LLM). Anything that requires a model must degrade gracefully when none is configured.
- `better-sqlite3` and `sqlite-vec` are the only native deps; `fastembed` is optional.
- Conventional-ish commits; node-writing commits are prefixed `memory:` by the server.
- The project is **Apache-2.0 and open source**. Never put internal host names, addresses or credentials into the repo: the GitHub mirror refuses to publish them.
- Two engines write AI documents: the server (jobs started by a button) and `admin-go/internal/engine` (automatic runs). They are ports of each other; a change to
  prompts, diagrams or document formats goes into both, with a shared fixture or a Node-generated golden file in the tests.
- The licence limits (4 free seats, 10 audit records, admin SSO) live in `admin-go/internal/web/license.go`; keep the License/Audit/SSO tabs and `docs/` in step with them.

## Build / test

```
npm install
npm run build          # tsc -b across packages
npm test               # vitest: core unit + server integration
npm run serve          # http server
node packages/server/dist/bin/mnemosyne.js reindex
(cd admin-go && make test)        # Go: gofmt, vet, all tests
deploy/make-release.sh            # release/mnemosyne_<version>.zip
```
