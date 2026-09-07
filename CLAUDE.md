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

## Build / test

```
npm install
npm run build          # tsc -b across packages
npm test               # vitest: core unit + server integration
npm run serve          # http server (needs MNEMOSYNE_BEARER_TOKEN)
node packages/server/dist/bin/mnemosyne.js reindex
```
