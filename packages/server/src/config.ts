import { dirname, resolve } from 'node:path';

export interface MnemosyneConfig {
  /** Directory containing the `nodes/` corpus and the git repo. */
  repoDir: string;
  /** Subdirectory under repoDir holding node markdown. */
  nodesDir: string;
  /** SQLite index cache file. */
  dbPath: string;

  /** git write behaviour for create/update. */
  git: {
    enabled: boolean;
    autoCommit: boolean;
    push: boolean;
    remote: string;
    branch: string;
    authorName: string;
    authorEmail: string;
  };

  /** Embeddings. If `embedBaseUrl` is set, the OpenAI-compatible embedder is used. */
  embed: {
    baseUrl?: string;
    apiKey?: string;
    model: string;
    /** dimensions of the configured model; must match what the endpoint returns */
    dimensions: number;
  };

  /** Optional chat model for `extract` / dedupe / `/ask`. */
  llm: {
    baseUrl?: string;
    apiKey?: string;
    model: string;
  };

  http: {
    host: string;
    port: number;
    /**
     * Path prefix every route mounts under (MCP at `<basePath>/mcp`, REST at
     * `<basePath>/search` etc). Lets one `:40000` endpoint carry several MCP
     * services side by side — `/codegraph`, `/mnemosyne`, ... — routed by path
     * instead of one port per service.
     */
    basePath: string;
    /** optional shared bearer token; when unset, HTTP mode runs unauthenticated */
    bearerToken?: string;
  };

  /**
   * Web portal (`<basePath>/` login screen, `<basePath>/admin/`). Independent of
   * the MCP/REST auth above: MCP and REST keep working exactly as configured.
   * The portal is enabled when `secret` and `publicUrl` are set. Sign-in is the local
   * admin account and/or GitLab SSO (env or admin UI); with neither it says so.
   */
  web: {
    /** Operator secret (>= 16 chars); derives the cookie-signing and at-rest encryption keys. */
    secret?: string;
    /** Externally visible origin, e.g. `https://host:40000`; builds the OAuth redirect URI. */
    publicUrl?: string;
    gitlab: { url?: string; clientId?: string; clientSecret?: string };
    /** Sealed file holding the LLM providers configured in the admin UI. */
    providersFile: string;
    /** Sealed file holding portal settings edited in the admin UI (override the env values). */
    settingsFile: string;
    /** Sealed file remembering signed-in users' GitLab memberships and refresh tokens across restarts. */
    membersFile: string;
    /** Append-only audit trail (JSON lines) of sign-ins and admin changes. */
    auditFile: string;
    /** Generated project documentation (articles, diagrams, PDFs), kept with their date stamps. */
    docsDir: string;
    /** Spending guard: most AI generation runs allowed per UTC day, across all projects. */
    aiDailyLimit: number;
    /**
     * Built-in admin account so the portal can be configured before (or without) GitLab SSO.
     * Give either a `passwordHash` (`hashPassword()` output) or a plain `password`.
     */
    localAdmin: { user?: string; passwordHash?: string; password?: string };
  };
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  return /^(1|true|yes|on)$/i.test(v);
}

function int(v: string | undefined, dflt: number): number {
  const n = v === undefined ? NaN : Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

/** '' or '/' -> ''; otherwise ensure exactly one leading slash and no trailing slash. */
function normalizeBasePath(v: string): string {
  const trimmed = v.trim().replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** Build config from environment, with a repo dir override (CLI --repo). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, repoOverride?: string): MnemosyneConfig {
  const repoDir = resolve(repoOverride ?? env.MNEMOSYNE_REPO ?? process.cwd());
  const nodesDir = resolve(repoDir, env.MNEMOSYNE_NODES_DIR ?? 'nodes');
  const dbPath = resolve(env.MNEMOSYNE_DB ?? `${repoDir}/.mnemosyne/index.db`);

  return {
    repoDir,
    nodesDir,
    dbPath,
    git: {
      enabled: bool(env.MNEMOSYNE_GIT, true),
      autoCommit: bool(env.MNEMOSYNE_GIT_AUTOCOMMIT, true),
      push: bool(env.MNEMOSYNE_GIT_PUSH, false),
      remote: env.MNEMOSYNE_GIT_REMOTE ?? 'origin',
      branch: env.MNEMOSYNE_GIT_BRANCH ?? 'main',
      authorName: env.MNEMOSYNE_GIT_AUTHOR_NAME ?? 'mnemosyne',
      authorEmail: env.MNEMOSYNE_GIT_AUTHOR_EMAIL ?? 'mnemosyne@localhost',
    },
    embed: {
      baseUrl: env.MNEMOSYNE_EMBED_BASE_URL,
      apiKey: env.MNEMOSYNE_EMBED_API_KEY,
      model: env.MNEMOSYNE_EMBED_MODEL ?? 'text-embedding-3-small',
      dimensions: int(env.MNEMOSYNE_EMBED_DIM, env.MNEMOSYNE_EMBED_BASE_URL ? 1536 : 256),
    },
    llm: {
      baseUrl: env.MNEMOSYNE_LLM_BASE_URL,
      apiKey: env.MNEMOSYNE_LLM_API_KEY,
      model: env.MNEMOSYNE_LLM_MODEL ?? 'gpt-4o-mini',
    },
    http: {
      host: env.MNEMOSYNE_HTTP_HOST ?? '127.0.0.1',
      port: int(env.MNEMOSYNE_HTTP_PORT, 40000),
      basePath: normalizeBasePath(env.MNEMOSYNE_BASE_PATH ?? '/mnemosyne'),
      bearerToken: env.MNEMOSYNE_BEARER_TOKEN,
    },
    web: {
      secret: env.MNEMOSYNE_SECRET,
      publicUrl: env.MNEMOSYNE_PUBLIC_URL?.replace(/\/+$/, ''),
      gitlab: {
        url: env.MNEMOSYNE_GITLAB_URL?.replace(/\/+$/, ''),
        clientId: env.MNEMOSYNE_GITLAB_CLIENT_ID,
        clientSecret: env.MNEMOSYNE_GITLAB_CLIENT_SECRET,
      },
      providersFile: resolve(env.MNEMOSYNE_PROVIDERS_FILE ?? `${dirname(dbPath)}/providers.enc`),
      settingsFile: resolve(env.MNEMOSYNE_SETTINGS_FILE ?? `${dirname(dbPath)}/settings.enc`),
      membersFile: resolve(env.MNEMOSYNE_MEMBERS_FILE ?? `${dirname(dbPath)}/members.enc`),
      auditFile: resolve(env.MNEMOSYNE_AUDIT_FILE ?? `${dirname(dbPath)}/audit.jsonl`),
      docsDir: resolve(env.MNEMOSYNE_DOCS_DIR ?? `${dirname(dbPath)}/docs`),
      aiDailyLimit: int(env.MNEMOSYNE_AI_DAILY_LIMIT, 20),
      localAdmin: {
        user: env.MNEMOSYNE_LOCAL_ADMIN_USER,
        passwordHash: env.MNEMOSYNE_LOCAL_ADMIN_PASSWORD_HASH,
        password: env.MNEMOSYNE_LOCAL_ADMIN_PASSWORD,
      },
    },
  };
}
