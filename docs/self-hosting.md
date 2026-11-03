# Self-hosting mnemosyne

## Requirements

- Linux with systemd (amd64 or arm64) for the release zip; the server alone also runs anywhere Node runs.
- Node.js ≥ 20, npm, git and curl.
- A git repository to hold the corpus (`nodes/`): the installer creates one in `/var/lib/mnemosyne`; with a source install it can be this repo or a separate
  data-only repo — set `MNEMOSYNE_REPO` to its path.
- Nothing else. Embeddings and chat are optional; AI documentation needs an AI provider (Admin → LLM).

## Install from the release zip (Linux server, recommended)

`release/mnemosyne_<version>.zip` holds everything: the built server, the admin program for linux/amd64 and linux/arm64, `install.sh`, the
docs and `bin/SHA256SUMS`. On a server with Node.js 20+, npm, git and curl:

```bash
unzip mnemosyne_0.6.1.zip && cd mnemosyne_0.6.1
sudo ./install.sh --public-url https://mnemosyne.example.com --listen 127.0.0.1:40001     # ./install.sh --help lists every option
```

It checks the binaries against the checksums, installs the server in `/opt/mnemosyne` and the admin program in `/usr/local/bin`, creates the
notes repository in `/var/lib/mnemosyne`, writes `/etc/mnemosyne.env` once (random secret, built-in admin account; the password is printed at the end),
installs and starts the systemd unit and waits for the health answer. To upgrade, unpack the newer release and run `install.sh` again: the settings file
and the data are never touched. `deploy/make-release.sh` builds the zip from a checkout.

## Install from source

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

### Personal MCP tokens

Every person who signs in to the portal with GitLab can issue their own MCP token: open the card at the
top right (their name), choose **Profile**, and create a token under **MCP access**. The token is shown
once. It is valid for at most 90 days (1 to 90, default 90), so it is rotated like a password, and it can
be revoked in the same place. A person can hold five active tokens; they count as one person.

An MCP client presents it as a header: `Authorization: Bearer mnm_...`. For Claude Code:
`claude mcp add --transport http mnemosyne https://host:40000/mnemosyne/mcp --header "Authorization: Bearer mnm_..."`.

| var | default | effect |
|---|---|---|
| `MNEMOSYNE_BEARER_TOKEN` | unset | one shared token that is always accepted (identifies nobody) |
| `MNEMOSYNE_REQUIRE_TOKEN` | `false` | refuse MCP and REST calls without a valid shared or personal token. Off: a call with no token is let through when no shared token is set; a personal token that IS presented is always checked |
| `MNEMOSYNE_TOKENS_FILE` | next to the index | sealed file holding the hashes of the tokens (never the tokens) |

Tokens need the web portal (`MNEMOSYNE_SECRET`, `MNEMOSYNE_PUBLIC_URL`). Send them over https: a token on
plain http can be read on the network, and the profile page says so when the address is http.

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

## Run — the admin program in front of the server

The admin (`/mnemosyne/admin`) is the Go program in `admin-go/`: take the compiled one in `bin/` (checksums in `bin/SHA256SUMS`) or build it yourself with `cd admin-go && make build` (Go 1.27). It is free for up to 4 people (5 or more seats need a licence); without a licence key the Audit tab shows the last 10 records and administrators sign in with the built-in account (`MNEMOSYNE_LOCAL_ADMIN_USER` and `MNEMOSYNE_LOCAL_ADMIN_PASSWORD`, or `..._PASSWORD_HASH`). A licence key (Admin -> License) lifts the limits. The licence server is asked for the 30-day trial and, once a key has been entered, for the licence. It becomes the front door:
it listens where the server listened (`127.0.0.1:40001`), serves `/mnemosyne/admin` itself, starts the server on `127.0.0.1:40002` and passes
everything else on to it. A reverse proxy in front keeps sending `/mnemosyne/` to `127.0.0.1:40001`, so nothing changes for people or MCP clients.
It reads the same environment file as the server. Install it and swap the unit:

```bash
sudo install -m 0755 bin/mnemosyne-admin-linux-amd64 /usr/local/bin/mnemosyne-admin     # linux-arm64 on ARM
```

```ini
# /etc/systemd/system/mnemosyne.service  (replace the ExecStart of the plain server unit)
[Unit]
Description=mnemosyne - self-hosted AI team memory (admin and front door)
After=network.target

[Service]
Type=simple
EnvironmentFile=/etc/mnemosyne.env
Environment=MNEMOSYNE_ADMIN_LISTEN=127.0.0.1:40001
Environment=MNEMOSYNE_UPSTREAM=http://127.0.0.1:40002
Environment=MNEMOSYNE_NODE_DIR=/opt/mnemosyne
Environment="MNEMOSYNE_NODE_CMD=/usr/bin/node /opt/mnemosyne/packages/server/dist/bin/mnemosyne.js serve --http"
WorkingDirectory=/opt/mnemosyne
ExecStart=/usr/local/bin/mnemosyne-admin
Restart=on-failure
RestartSec=5
User=mnemosyne
NoNewPrivileges=true
KillMode=control-group

[Install]
WantedBy=multi-user.target
```

`sudo systemctl daemon-reload && sudo systemctl restart mnemosyne`, then open `/mnemosyne/admin/`. The admin needs `MNEMOSYNE_SECRET` and
`MNEMOSYNE_PUBLIC_URL` in the environment file. `MNEMOSYNE_HTTP_PORT` in that file is overridden for the server it starts.
(The release zip's `install.sh` does all of this for you.)

### Settings of the admin program

It reads the same environment file as the server. The ones that matter:

| var | default | effect |
|---|---|---|
| `MNEMOSYNE_SECRET` | none (required) | at least 16 characters; signs cookies and seals the stored API keys, tokens and licence. **Back it up and never change it** |
| `MNEMOSYNE_PUBLIC_URL` | none (required) | the address people type, no path (`https://mnemosyne.example.com[:port]`); cookies and the GitLab redirect use it |
| `MNEMOSYNE_ADMIN_LISTEN` | `127.0.0.1:40001` | where the front door listens |
| `MNEMOSYNE_UPSTREAM` / `MNEMOSYNE_NODE_CMD` / `MNEMOSYNE_NODE_DIR` | `http://127.0.0.1:40002` / none / none | the server it starts as its child, and where |
| `MNEMOSYNE_LOCAL_ADMIN_USER` / `_PASSWORD` or `_PASSWORD_HASH` | `admin` / none | the built-in admin account (there is no default password); the free edition's only admin sign-in |
| `MNEMOSYNE_GITLAB_URL`, `_CLIENT_ID`, `_CLIENT_SECRET` | none | the GitLab application, see below |
| `MNEMOSYNE_LICENSE_KEY` | none | a licence key, taken up once when none is stored (or enter it under Admin → License) |
| `MNEMOSYNE_USAGE_FILE`, `MNEMOSYNE_SEATS_FILE`, `MNEMOSYNE_AUTO_FILE`, `MNEMOSYNE_AUDIT_FILE` | `.mnemosyne/usage.jsonl`, `seats.enc`, `auto.json`, `audit.jsonl` | where the cost center, the seat register, the Auto setup and the audit trail live (in the notes repository's `.mnemosyne/`, never committed) |
| `MNEMOSYNE_LICENSE_DOMAIN` | the host of the public URL | the domain a licence is bound to |

## GitLab sign-in for the documentation portal

People sign in to the portal with GitLab; the first 4 take the seats of the free edition. Create a GitLab application (Admin → Applications) with scope `read_user`,
tick *Trusted*, and register **both** redirect URIs: `<PUBLIC_URL>/mnemosyne/auth/callback` (the portal) and `<PUBLIC_URL>/mnemosyne/admin/auth/callback` (the admin, licensed
edition). Put the URL, application id and secret in the environment file (`MNEMOSYNE_GITLAB_*`) and restart; with a licence they can also be entered under Admin → SSO.
A person then sees the documentation of the GitLab projects they belong to (GitLab administrators see all). The notes projects are matched to GitLab projects by name.

## Reverse proxy with TLS

Let your web server send `/mnemosyne/` to the admin program (`127.0.0.1:40001`), for example with nginx:

```nginx
location /mnemosyne/ {
  proxy_pass http://127.0.0.1:40001/mnemosyne/;
  proxy_http_version 1.1;                 # Streamable HTTP needs keep-alive
  proxy_set_header Connection "";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_buffering off;                    # don't buffer the MCP event stream
}
```

Use https: personal MCP tokens and the sign-in cookie must not travel over plain http.

## Free and licensed

Free: up to 4 people (5 or more seats need a licence), the Audit tab shows the last 10 records, administrators sign in with the built-in account. A licence key (Admin → License) lifts the limits (see the
README). The first 30 days of a new installation are a trial with everything unlocked and no seat limit: at its first start the program asks the licence server for it (it sends only the domain, a random installation id, the version, the number of seats in use and a nonce), and after 30 days it reverts to the free edition and keeps running (people who already hold a seat keep it; set the built-in admin account before then, because GitLab sign-in for the admin area is licensed). Without a key the licence server is asked only for the trial. If a licence cannot be confirmed (for example the licence server is unreachable for longer than the last confirmation
lasts) the installation works as the free edition until it can; nothing locks.

## Upgrade and uninstall

Upgrade with the release zip: unpack the newer one and run `sudo ./install.sh` again; `/etc/mnemosyne.env` and the data are never touched, the previous unit is kept next to the new
one as `mnemosyne.service.before-<version>`. Roll the admin program back by copying the previous binary into `/usr/local/bin` and restarting. Uninstall: see `README.txt` in the zip.

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

- The notes git repository (`MNEMOSYNE_REPO`): the source of truth. Push it to a remote, or copy it.
- `MNEMOSYNE_SECRET` (in `/etc/mnemosyne.env`) and the sealed files in `<repo>/.mnemosyne/` — `providers.enc` (AI providers and keys), `settings.enc`, `members.enc`, `tokens.enc`,
  `license.enc`, `seats.enc` — plus `docs/` (generated articles, diagrams, PDFs), `audit.jsonl`, `usage.jsonl` and `auto.json`. The sealed files cannot be read without the secret.
- The SQLite file (`index.db`) needs no backup — `reindex` regenerates it.
