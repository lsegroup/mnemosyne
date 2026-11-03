# mnemosyne-admin (Go)

The admin program of Mnemosyne, open source under the Apache License 2.0 (see `LICENSE`). It is the front door of a Mnemosyne installation:
it serves everything behind `/mnemosyne/admin` (sign-in with a built-in account or GitLab SSO, the LLM, LLM usage, LLM auto, SSO, Audit and
License tabs), runs the automatic documentation updates, and passes every other request to the Node server, which it starts and keeps running
itself. It reads and writes the same files and cookies as the Node server, so nothing has to be migrated.

Two editions, one code base (Apache-2.0):

- **free** - up to 4 people (the first to sign in take the seats; the 5th is refused), the Audit tab shows the last 10 records (no paging, no search),
  administrators sign in with the built-in account (no GitLab sign-in for the admin area, no SSO set-up). It never contacts a licence server.
- **licensed** - a licence key (Admin -> License) confirmed by the licence server: as many people as the licence has seats, the whole Audit history
  with paging and search, GitLab sign-in for the admin area. A licence that runs out falls back to the free edition; nothing ever locks.

## Layout

- `internal/secrets` - keys derived from the operator secret, sealed files, signed cookies, scrypt hash. Byte-compatible with
  `packages/server/src/secrets.ts`; the tests prove it in both directions against the real Node code.
- `internal/config`, `internal/audit` - the same environment, files and audit lines as the Node server.
- `internal/store`, `internal/jobs` - the sealed providers and settings files, the AI jobs (definitions rendered from the Node code).
- `internal/engine` - notes, prompts, the AI calls (text and images), the diagrams, the document store.
- `internal/auto` - the scheduler: schedule maths, agreement fingerprints, cost summary, the runner.
- `internal/usage` - the cost center: one line per AI job.
- `internal/license` - the licence client (Ed25519-signed answers of a licence server); used only when the check is switched on.
- `internal/web` - sign-in, the admin page and API, the reverse proxy. `internal/supervisor` - runs the Node server as a child.
- `internal/assets` - the admin page and the sign-in page, and the job definitions, version line and font metrics that `make assets` takes from the Node build.
- `testdata/gen/*.mjs` - run the REAL Node code to produce what the Go tests compare with.

## Test and build

    make test      # gofmt, vet, every test
    make build     # one static binary in bin/

The tests that compare with the Node code need `node` and a build of the Node packages next to this directory (`../packages/server/dist`,
or set `MNEMOSYNE_NODE_DIST`, and `../nodes` for a notes corpus); they skip themselves otherwise.

## Where this lives

This directory is part of the Mnemosyne repository (`admin-go/`). Compiled binaries of releases are in `bin/` of the repository.
