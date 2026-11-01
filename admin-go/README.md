# mnemosyne-admin (Go)

PRIVATE. This is proprietary source code. It must never be published, and never be pushed to GitHub
(see LICENSE). The public Mnemosyne repository (TypeScript) does not contain it and its GitHub mirror
refuses to publish any Go file.

The Go admin of Mnemosyne: everything behind `/mnemosyne/admin`, and later the licence check and the
personal-token / Seat check in front of MCP and REST. It reads and writes the same files and cookies the
Node server uses today, so it can take over without anybody losing a setting or a session.

## What it is today

`/mnemosyne/admin` (sign-in with the built-in account and GitLab SSO, the LLM, SSO and Audit tabs, the Auto scheduler and the AI
generation it runs) is converted and verified against the real Node implementation. The Go program is the front door: it serves the admin
and passes everything else to the Node server (`internal/web`), which it can start and keep running itself (`internal/supervisor`).
See `docs/cutover.md` for the deployment and for what is still missing (licence module, Seats and tokens in Go).

## Layout

- `internal/secrets` - keys derived from the operator secret, sealed files, signed cookies, scrypt hash.
  Byte-compatible with `packages/server/src/secrets.ts` of the Node repository; the tests prove it in both
  directions against the real Node code.
- `internal/config`, `internal/audit` - the same environment, files and audit lines as the Node server.
- `internal/store`, `internal/jobs` - the sealed providers and settings files, the AI jobs (definitions rendered from the Node code).
- `internal/engine` - notes, prompts, the one AI call, the diagrams (layout and SVG identical to the Node drawing), the document store.
- `internal/auto` - the scheduler: schedule maths, agreement fingerprints, cost summary, the runner.
- `internal/web` - sign-in, the admin page and API, the reverse proxy. `internal/supervisor` - runs the Node server as a child.
- `internal/assets` - the admin page and the sign-in page (this program's own files), and the job definitions, version line and font metrics that `make assets` takes from the Node build.
- `testdata/gen/*.mjs` - run the REAL Node code to produce what the Go tests compare with.

## Test and build

    make test      # gofmt, vet, every test
    make build     # one static binary in bin/

The tests that compare with the Node code need `node` and a build of the Node repository next to this one
(`../packages/server/dist`, or set `MNEMOSYNE_NODE_DIST`, and `../nodes` for the corpus); they skip themselves
otherwise. They prove: sealed files and cookies are readable by both sides, the 600+ notes give the same fingerprints, masking and prompts,
the diagrams are drawn to the same bytes, the schedule and the agreement fingerprints are the same, a scripted admin story gives the same
answers, and the real Node server works behind this program.

## Where this lives

This directory is part of the `GCD-Group/mnemosyne` repository on GitLab (`admin-go/`). The GitHub mirror drops it (and refuses to push when any
Go file is left); the compiled program is published in `bin/` of the repository. The Node build is the parent directory: the tests that compare with
the Node implementation look for it at `../packages/server/dist`.
