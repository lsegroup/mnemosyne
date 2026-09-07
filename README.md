# mnemosyne

Self-hosted **AI team memory**. A git-backed graph of memory *nodes* — what is where, what
state it's in, when it was done, how — that any MCP-capable AI reads and writes, with a thin
VSCode client for humans.

- **Source of truth:** markdown files with YAML frontmatter in a git repo. `git log` is the
  audit trail.
- **Search:** embedded SQLite — FTS5 (lexical) + `sqlite-vec` (semantic), fused with RRF.
  No search daemon, ~tens of MB resident.
- **Interfaces:** one core behind three façades — MCP over stdio, MCP over Streamable-HTTP
  (bearer), and plain REST.
- **Model-agnostic:** mnemosyne never calls an LLM to serve a read or write. Embeddings and
  the optional `extract` / `/ask` features target any OpenAI-compatible gateway; with none
  configured it runs fully offline.
- **No private infrastructure dependencies.** Git is the only hard requirement.

## Quick start

```bash
npm install
npm run build

# one-time: build the index from the corpus
node packages/server/dist/bin/mnemosyne.js reindex --repo .

# shared HTTP server (MCP at /mcp, REST at /)
MNEMOSYNE_BEARER_TOKEN=secret npm run serve

# or per-user, editor-spawned:
node packages/server/dist/bin/mnemosyne.js serve --stdio --repo .
```

## Connect an AI

MCP-capable client (Claude Code, Continue, Cline, ...):

```jsonc
// HTTP (shared)
{ "mcpServers": { "mnemosyne": { "url": "http://host:7077/mcp",
                                 "headers": { "Authorization": "Bearer secret" } } } }
// stdio (local)
{ "mcpServers": { "mnemosyne": { "command": "mnemosyne", "args": ["serve", "--stdio"] } } }
```

Non-MCP client: `POST /search` to pull nodes into the prompt, `POST /nodes` to write back.

## Tools

`search_memory` · `get_node` · `get_node_history` · `create_node` · `update_node` ·
`link_nodes` · `link_node_to_code` · `neighbors` · `reindex`

See [docs/architecture.md](docs/architecture.md) and [docs/self-hosting.md](docs/self-hosting.md).

## License

MIT © GCD Group
