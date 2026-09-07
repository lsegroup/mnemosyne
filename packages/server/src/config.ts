import { resolve } from 'node:path';

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
    /** shared bearer token; when unset, HTTP mode refuses to start */
    bearerToken?: string;
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
      port: int(env.MNEMOSYNE_HTTP_PORT, 7077),
      bearerToken: env.MNEMOSYNE_BEARER_TOKEN,
    },
  };
}
