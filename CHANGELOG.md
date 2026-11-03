# Changelog

## Unreleased

### 30-day trial restored
- Company policy: everything runs for the first 30 days without any licence. At its first start the program asks the licence server for the trial (domain, a random installation id, version, seats in use and a nonce; never notes or project content). During the trial there is no seat limit, the Audit tab shows the whole history and GitLab sign-in for the admin area works. After the 30 days (or while the licence server cannot be reached) it reverts to the free edition and keeps running - 4 seats, the last 10 audit records, no admin GitLab sign-in; people who already hold a seat keep it and keep working, nobody new is admitted above the limit. The License tab shows the days left and warns while no built-in admin account is set up. This replaces the earlier entry below that said there is no trial.

### Users: tracking the seats
- New admin tab **Users**: who holds the seats, with GitLab name, role, when the seat was taken, when the person was last seen, the last GitLab sign-in, projects and active MCP tokens; the seats in use against the limit; the people refused because every seat was taken; and **Free this seat** for a person who left (audited as `seat_release`, the person is not blocked, tokens are not touched).
- The seat register now also remembers when a person was last seen (written at most once a minute); the first version of the file still loads.

### Licence history and the hackathon
- The licence changed twice during the hackathon, and this entry says so plainly: the repository started on 2026-09-07 under the **MIT** licence (commit `31cdd2d`); on 2026-10-31 it was replaced by a **proprietary** notice (`acced84`); on 2026-11-03 it became **Apache-2.0**, with the Go admin program published (`admin-go/`). Releases 0.6.0 and 0.6.1 were published while the notice was proprietary and delivered the admin only as a compiled binary.
- Hackathon scope (see the README): the Git tag `pre-hackathon` marks the last commit before the kickoff on 2026-10-26 12:00 PM ET; the compare link `pre-hackathon...main` shows everything since.
- Free up to **4** seats, a licence from 5 seats; the audit history beyond the last 10 records and GitLab sign-in for the admin area are licensed. The price is $8.25 per seat per month, billed annually as an annual contract of $99 per seat per year (on sale at lumanet.info/shop since 2026-11-03).

### Reliability of the automatic runs
- A provider that cannot be reached (DNS failures such as `EAI_AGAIN`, refused or reset connections) or answers HTTP 429 or 5xx is now asked again with exponential backoff: 1.5 s, 3 s and 6 s per call, and 1, 2, 4 and 8 minutes per project in an automatic run. A project that still cannot be reached is given up on and the run goes on with the next one; the run stops only after three projects in a row (before, it stopped after 15 minutes and abandoned everything that was left: on 2026-10-31 two runs lost 25 and 80 projects that way). Timeouts are not retried, because the request may have been billed.
- A fixed address (host to IP) is now a fallback: DNS is asked first, the pinned address is only used when the connection fails. The LLM tab shows when an address was last verified and when it last had to stand in for DNS.

### Documentation
- README, architecture, self-hosting, `.env.example` and the repo guide were rewritten for what exists now: the Go admin program, the free and licensed edition, LLM usage, LLM auto, the painted workflow diagram, the install zip, GitLab sign-in, reverse proxy, upgrade and backups.

### Release zip with an installer
- `release/mnemosyne_<version>.zip` (built by `deploy/make-release.sh`): the built server, the admin program for linux/amd64 and linux/arm64, `install.sh` for a Linux server with systemd, the docs and checksums. `install.sh` writes the settings file once, so an upgrade (unpack the new zip, run it again) keeps settings and data.

### Open source, free edition and licensed edition
- Mnemosyne is open source under the Apache License 2.0 (`LICENSE`, `NOTICE`), including the Go admin program: its source is in `admin-go/` (Go module `github.com/lsegroup/mnemosyne/admin-go`) and published with the rest of the repository.
- **Free edition** (no licence key): up to 4 people (5 or more seats need a licence) - the first to sign in to the documentation portal take the seats, the 5th is refused and signed out -, the Audit tab shows the last 10 records (no paging, no search), administrators sign in to the admin area with the built-in account (no GitLab sign-in for the admin area, no SSO set-up). After the 30-day trial (see above) it asks the licence server only when a key has been entered.
- **Licensed edition** (a key entered under License and confirmed by the licence server): as many people as the licence has seats, the whole Audit history with paging and search, GitLab sign-in for the admin area. A licence that runs out or cannot be confirmed falls back to the free edition; nothing locks any more.
- The License tab shows the edition, the people in use against the limit and what the edition includes.

### LLM usage: the cost center of the AI
- New admin tab **LLM usage**: the cost per month (jobs, calls, tokens, TEXT / IMAGES / PICTURES, total) and below it every AI job, ten to a page, newest first - who started it (the person who pressed the button, or the automatic schedule and who agreed to it), the project, what each model used (calls, tokens in and out, reasoning tokens, cost, AI time), the result and any warning.
- One file for everything (`usage.jsonl` next to the audit trail, `MNEMOSYNE_USAGE_FILE`): the server writes the jobs started on the project pages, the admin program the automatic ones. A job that failed after the text call was billed is in it with what was used. The automatic runs from before every job was logged are imported once, one line per run.
- The Auto tab no longer shows the run log (only the live progress and a line about the last run); it points to LLM usage.
- The cost is the tokens the provider reports times the list price of the model, and one price per picture: the providers answer with token counts, not with an amount of money.

### The image model paints the workflow diagram
- The image model chosen for the *Images* job in Admin -> LLM makes the workflow diagram again: after the text model has planned the system (an overview and, for a bigger system, detail pictures by topic), the image model paints **every picture of the plan**. The painted pictures are shown on the project page and each gets its own page in the PDF.
- A new run **replaces** everything the project had: all earlier diagrams, their detail pictures and the pictures of earlier builds are deleted (the agreement popup says so). Nothing is deleted until the overview is painted: if the image model refuses, the earlier diagrams stay and the page says why. A detail picture that cannot be painted is left out and reported.
- *Instruction for the picture* is a new editable prompt in the *Images* card (`{{title}}`, `{{plan}}`). It is given every box and arrow with its exact words, because an image model that has to invent words misspells them. The built-in text names no colours and no style and asks for straight horizontal and vertical lines only, never curved or diagonal.
- With no image model chosen, Mnemosyne still draws the exact diagrams itself from the plan (SVG, vectors in the PDF); they replace the earlier ones the same way.
- The agreement popup and Admin -> Auto show the image model and its price (about $0.01 per picture for `muse-image-1.0`, typically three pictures, at most five); Auto counts the pictures as their own *PICTURES* line, and choosing or changing the image model needs a new Auto agreement.

## 0.6.1 — 2026-11-01

The admin becomes a separate, compiled program; every person gets a profile with personal MCP tokens.

### The admin program
- The admin (sign-in, LLM, SSO, Audit, Auto, License) is no longer part of this server: it is a separate program written in Go that runs in front of it and
  starts it. This server has no `/admin` any more (it answers 404) and no Auto scheduler of its own; it still reads the settings the admin saves.
- The program is delivered compiled in `bin/` (Linux x86-64 and ARM64, checksums in `bin/SHA256SUMS`); `docs/self-hosting.md` shows how to run it in front of the
  server. Its source is not published.
- The admin has a License tab: the state of the licence, the seats in use (a seat is a person with a GitLab account who uses Mnemosyne, in any role), the
  last check and the licence key. The licensed domain is the host of `MNEMOSYNE_PUBLIC_URL`, or `MNEMOSYNE_LICENSE_DOMAIN`.
- The deploy script keeps the unit of the admin program, removes the old build before it unpacks the new one and waits for the health answer before the reindex.

### Profile and personal MCP tokens
- The signed-in person's name in the header is now a card with a link to their profile. The profile lists their account details and lets them issue their own MCP token.
- A token is valid for at most 90 days (1 to 90, default 90), is shown once, can be revoked at any time, and only a hash of it is stored. A person can hold five active tokens; they are still one person.
- MCP and REST accept `Authorization: Bearer <token>` with a personal token. A presented token is always checked, so an expired or revoked one is refused with the reason. `MNEMOSYNE_REQUIRE_TOKEN=1` refuses calls without a valid token; without it a call with no token is let through as before.
- Issuing and revoking a token is written to the audit trail (never the token itself).

## 0.6.0 — 2026-10-31

First release. Mnemosyne is a self-hosted AI team memory: a git-backed graph of memory notes that any MCP-capable AI can read and write, plus a web portal that turns the notes of a project into documentation.

### Memory server
- Notes are markdown files with YAML frontmatter in a git repository; `git log` is the audit trail.
- Hybrid search in one embedded SQLite file: full text (FTS5) and semantic (sqlite-vec), fused with reciprocal rank fusion. No search daemon.
- Nine tools served over MCP (stdio and HTTP) and REST: `search_memory`, `get_node`, `get_node_history`, `create_node`, `update_node`, `link_nodes`, `link_node_to_code`, `neighbors`, `reindex`.
- A VS Code extension to browse and capture notes.

### Web portal
- Sign in with GitLab; people see the documentation of the GitLab projects they belong to. A local admin account and GitLab SSO are set up from the admin page, and sessions survive restarts.
- Project pages with an AI-written article, a set of architecture diagrams and a PDF handbook.
- The text model writes a plan for the diagrams (an overview plus detail pictures) and every label is spelled exactly from that plan. In this first release Mnemosyne drew the plan itself as SVG (the PDF used the same vector drawing); since 2026-11-01 an image model paints it when one is chosen (see "The image model paints the workflow diagram" above), and the SVG drawing remains the fallback.
- A "Mnemosyne Wiki" link can be put into every GitLab project by CI.
- Every page ends with a line such as "2026 © LSE Group Corporation | Version 0.6".

### Admin
- **LLM:** connect OpenAI-compatible or Anthropic-format providers (keys are stored encrypted), fetch the models a key can use, choose a model per job, and edit limits, sampling, reasoning effort and the prompts. Fixed addresses pin a provider's host name to an IP address for networks with unreliable DNS.
- **Auto:** keep the documentation up to date on a schedule. Only projects whose notes changed are touched. A dollar limit per run, an agreement bound to the exact setup and a kill switch keep the spending bounded, and a run waits and retries when the provider cannot be reached. Every run lists its start, end and runtime, and the tokens, cost and time per model for text and for diagrams.
- **Audit:** every sign-in, change and AI run, without secrets.
- Nothing calls an AI model unless an administrator agrees to the estimated cost.

### Known limits
- The HTTP MCP and REST endpoints run without authentication unless `MNEMOSYNE_BEARER_TOKEN` is set. Run them on a private network or set the token.
- Cost figures use the list price in the price table, not what a provider bills (free credits, for example, charge nothing).
- A call that reaches the provider but returns an unusable diagram plan is billed, but its tokens are not counted in the run.
- Automatic runs make one AI call at a time. Reasoning models can spend most of their output on thinking, which makes each call slow.
- The License tab is a blank placeholder.
