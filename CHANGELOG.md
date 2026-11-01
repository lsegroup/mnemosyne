# Changelog

## Unreleased

- The admin (sign-in, LLM, SSO, Audit, Auto, License) is no longer part of this server: it is a separate program that runs in front of it and
  starts it. This server has no `/admin` any more (it answers 404) and no Auto scheduler of its own; it still reads the settings the admin saves.

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
- The diagrams are drawn by Mnemosyne itself from a plan the text model writes (an overview plus detail pictures), so every label is spelled exactly; the PDF uses the same vector drawing.
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
