# Self-hosting mnemosyne

## Requirements

- Node.js ≥ 20.
- A git repository to hold the corpus (`nodes/`). It can be this repo, or a separate
  data-only repo — set `MNEMOSYNE_REPO` to its path.
- Nothing else. Embeddings and chat are optional.

## Install

```bash
git clone <your mnemosyne fork>
cd mnemosyne
npm install
npm run build
```

Or consume the packages: `npm i mnemosyne` (server + CLI) / `@mnemosyne/core` (library).

## First index

```bash
node packages/server/dist/bin/mnemosyne.js reindex --repo /path/to/corpus
```

Writes `<corpus>/.mnemosyne/index.db`. Safe to delete and rebuild at any time.

## Run — shared HTTP (recommended)

One instance that every editor and the central AI point at:

```bash
export MNEMOSYNE_REPO=/srv/mnemosyne
export MNEMOSYNE_BEARER_TOKEN="$(openssl rand -hex 32)"
export MNEMOSYNE_HTTP_HOST=127.0.0.1     # bind localhost; front it with the box's proxy
export MNEMOSYNE_HTTP_PORT=40000
export MNEMOSYNE_BASE_PATH=/mnemosyne
node packages/server/dist/bin/mnemosyne.js serve --http
```

Serves `http://127.0.0.1:40000/mnemosyne`:

- MCP (Streamable HTTP) at `POST/GET/DELETE /mnemosyne/mcp`
- REST under `/mnemosyne/` — `search`, `nodes`, `nodes/:id`, `nodes/:id/history`, `link`,
  `link-code`, `neighbors`, `reindex`, `ask`
- `/mnemosyne/health` is the only unauthenticated route

### One endpoint, many services

`MNEMOSYNE_BASE_PATH` exists so a single `:40000` MCP endpoint carries several services
routed by path rather than one port per service. Put each behind the box's existing proxy:

```nginx
# one listener; each MCP service keeps its own clean prefix
location /codegraph/ { proxy_pass http://127.0.0.1:41000/codegraph/; }
location /mnemosyne/ { proxy_pass http://127.0.0.1:40000/mnemosyne/; }
proxy_http_version 1.1;                 # Streamable HTTP needs keep-alive
proxy_set_header Connection "";
proxy_buffering off;                    # don't buffer the MCP event stream
```

The firewall then exposes one port, not one per tool. If two services must share the exact
same local port, move one to its own local port (as above) and let the proxy present them
under the same host.

### systemd unit

```ini
[Unit]
Description=mnemosyne
After=network.target

[Service]
Environment=MNEMOSYNE_REPO=/srv/mnemosyne
Environment=MNEMOSYNE_BEARER_TOKEN=...
Environment=MNEMOSYNE_HTTP_PORT=40000
Environment=MNEMOSYNE_BASE_PATH=/mnemosyne
ExecStart=/usr/bin/node /opt/mnemosyne/packages/server/dist/bin/mnemosyne.js serve --http
Restart=on-failure
DynamicUser=yes
StateDirectory=mnemosyne

[Install]
WantedBy=multi-user.target
```

If it shares a host with a firewall that reverts unknown rules, keep it on localhost and
proxy through the existing web server rather than opening a port.

## Run — per user (stdio)

```jsonc
// editor MCP config
{ "mcpServers": { "mnemosyne": {
    "command": "node",
    "args": ["/opt/mnemosyne/packages/server/dist/bin/mnemosyne.js", "serve", "--stdio"],
    "env": { "MNEMOSYNE_REPO": "/home/me/src/mnemosyne-corpus" }
} } }
```

Each user commits to the corpus repo; memory is shared by pulling/pushing that repo.

## Connect the self-hosted AI

Point embeddings (and optionally chat) at your OpenAI-compatible gateway:

```bash
export MNEMOSYNE_EMBED_BASE_URL=http://ai-gw.internal:8000/v1
export MNEMOSYNE_EMBED_MODEL=bge-small-en-v1.5
export MNEMOSYNE_EMBED_DIM=384
export MNEMOSYNE_LLM_BASE_URL=http://ai-gw.internal:8000/v1
export MNEMOSYNE_LLM_MODEL=your-chat-model
```

Changing the embedding model changes vector width — run `reindex` afterwards (the backend
drops and rebuilds the vector table automatically).

## Git write behaviour

| var | default | effect |
|---|---|---|
| `MNEMOSYNE_GIT` | `true` | master switch for commits |
| `MNEMOSYNE_GIT_AUTOCOMMIT` | `true` | commit on every create/update/link |
| `MNEMOSYNE_GIT_PUSH` | `false` | also `git push` after each commit |
| `MNEMOSYNE_GIT_REMOTE` / `_BRANCH` | `origin` / `main` | push target |

With push off, review and push commits yourself (or open a merge request from them).

## Backups

Back up the git repo. The SQLite file needs no backup — `reindex` regenerates it.
