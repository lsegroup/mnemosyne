import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {
  reciprocalRankFusion,
  type MemoryNode,
  type SearchBackend,
  type SearchHit,
  type SearchQuery,
} from '@mnemosyne/core';

const FTS_LIMIT = 80;
const VEC_LIMIT = 80;

/** Turn a free-text query into a safe FTS5 MATCH expression. */
function ftsExpr(query: string): string | null {
  const terms = query.toLowerCase().match(/[a-z0-9]{2,}/g);
  if (!terms || terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(' OR ');
}

function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/**
 * Embedded search backend: SQLite with an FTS5 table for lexical search and a
 * sqlite-vec `vec0` table for KNN. Hybrid results are fused with RRF in-process.
 * Runs inside the server process — no daemon, ~tens of MB resident.
 */
export class SqliteBackend implements SearchBackend {
  private readonly db: Database.Database;

  constructor(
    dbPath: string,
    private readonly dimensions: number,
  ) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    sqliteVec.load(this.db);
    this.migrate();
    this.prepareStatements();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        project TEXT, type TEXT, status TEXT,
        updated_at TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
        id UNINDEXED, title, body, components,
        tokenize = 'porter unicode61'
      );
    `);

    const storedDim = (
      this.db.prepare(`SELECT value FROM meta WHERE key = 'vec_dim'`).get() as { value: string } | undefined
    )?.value;
    if (storedDim !== undefined && Number(storedDim) !== this.dimensions) {
      // embedder / model changed shape -> drop vectors, force a reindex
      this.db.exec(`DROP TABLE IF EXISTS nodes_vec;`);
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS nodes_vec USING vec0(
         id TEXT PRIMARY KEY,
         embedding float[${this.dimensions}]
       );`,
    );
    this.db
      .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('vec_dim', ?)`)
      .run(String(this.dimensions));
  }

  // Prepared once (in prepareStatements(), called from the constructor after
  // migrate()) and reused: re-preparing a Statement on every call (as this
  // used to do, once per node on every reindex) creates enough short-lived
  // native Statement/transaction objects to trip a GC-timing race between
  // better-sqlite3 and the sqlite-vec native extension on process exit
  // (SIGABRT, assertion in node::RemoveEnvironmentCleanupHook).
  private upsertNodeStmt!: Database.Statement;
  private deleteFtsStmt!: Database.Statement;
  private insertFtsStmt!: Database.Statement;
  private deleteVecStmt!: Database.Statement;
  private insertVecStmt!: Database.Statement;
  private deleteNodeStmt!: Database.Statement;
  private upsertTx!: Database.Transaction<(node: MemoryNode, embedding: Float32Array) => void>;
  private removeTx!: Database.Transaction<(nodeId: string) => void>;
  private getNodeStmt!: Database.Statement;
  private idsStmt!: Database.Statement;
  private ftsSearchStmt!: Database.Statement;
  private vecSearchStmt!: Database.Statement;

  private prepareStatements(): void {
    this.upsertNodeStmt = this.db.prepare(
      `INSERT OR REPLACE INTO nodes (id, json, project, type, status, updated_at)
       VALUES (@id, @json, @project, @type, @status, @updated_at)`,
    );
    this.deleteFtsStmt = this.db.prepare(`DELETE FROM nodes_fts WHERE id = ?`);
    this.insertFtsStmt = this.db.prepare(
      `INSERT INTO nodes_fts (id, title, body, components) VALUES (?, ?, ?, ?)`,
    );
    this.deleteVecStmt = this.db.prepare(`DELETE FROM nodes_vec WHERE id = ?`);
    this.insertVecStmt = this.db.prepare(`INSERT INTO nodes_vec (id, embedding) VALUES (?, ?)`);
    this.deleteNodeStmt = this.db.prepare(`DELETE FROM nodes WHERE id = ?`);

    this.upsertTx = this.db.transaction((node: MemoryNode, embedding: Float32Array) => {
      this.upsertNodeStmt.run({
        id: node.id,
        json: JSON.stringify(node),
        project: node.project,
        type: node.type,
        status: node.status,
        updated_at: node.updated_at ?? null,
      });
      this.deleteFtsStmt.run(node.id);
      this.insertFtsStmt.run(node.id, node.title, node.body, node.components.join(' '));
      this.deleteVecStmt.run(node.id);
      this.insertVecStmt.run(node.id, toBlob(embedding));
    });

    this.removeTx = this.db.transaction((nodeId: string) => {
      this.deleteNodeStmt.run(nodeId);
      this.deleteFtsStmt.run(nodeId);
      this.deleteVecStmt.run(nodeId);
    });

    this.getNodeStmt = this.db.prepare(`SELECT json FROM nodes WHERE id = ?`);
    this.idsStmt = this.db.prepare(`SELECT id FROM nodes`);
    this.ftsSearchStmt = this.db.prepare(
      `SELECT id FROM nodes_fts WHERE nodes_fts MATCH ? ORDER BY bm25(nodes_fts) LIMIT ?`,
    );
    this.vecSearchStmt = this.db.prepare(
      `SELECT id, distance FROM nodes_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance`,
    );
  }

  async upsert(node: MemoryNode, embedding: Float32Array): Promise<void> {
    if (embedding.length !== this.dimensions) {
      throw new Error(`embedding length ${embedding.length} != index dim ${this.dimensions}`);
    }
    this.upsertTx(node, embedding);
  }

  async remove(id: string): Promise<void> {
    this.removeTx(id);
  }

  async get(id: string): Promise<MemoryNode | null> {
    const row = this.getNodeStmt.get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as MemoryNode) : null;
  }

  async ids(): Promise<string[]> {
    return (this.idsStmt.all() as { id: string }[]).map((r) => r.id);
  }

  async clear(): Promise<void> {
    this.db.exec(`DELETE FROM nodes; DELETE FROM nodes_fts; DELETE FROM nodes_vec;`);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async search(q: SearchQuery, queryEmbedding?: Float32Array): Promise<SearchHit[]> {
    const mode = q.mode ?? 'hybrid';
    const limit = q.limit ?? 10;

    const passesFilter = (n: MemoryNode) =>
      (!q.project || n.project === q.project) &&
      (!q.type || n.type === q.type) &&
      (!q.status || n.status === q.status);

    const textIds: string[] = [];
    if (mode !== 'semantic') {
      const expr = ftsExpr(q.query);
      if (expr) {
        const rows = this.ftsSearchStmt.all(expr, FTS_LIMIT) as { id: string }[];
        textIds.push(...rows.map((r) => r.id));
      }
    }

    const semanticIds: string[] = [];
    const semScore = new Map<string, number>();
    if (mode !== 'text' && queryEmbedding) {
      const rows = this.vecSearchStmt.all(toBlob(queryEmbedding), VEC_LIMIT) as {
        id: string;
        distance: number;
      }[];
      for (const r of rows) {
        semanticIds.push(r.id);
        semScore.set(r.id, 1 / (1 + r.distance));
      }
    }

    let ordered: { id: string; score: number }[];
    if (mode === 'text') {
      ordered = textIds.map((id, i) => ({ id, score: 1 / (i + 1) }));
    } else if (mode === 'semantic') {
      ordered = semanticIds.map((id) => ({ id, score: semScore.get(id) ?? 0 }));
    } else {
      ordered = reciprocalRankFusion([
        { ids: textIds, weight: 1 },
        { ids: semanticIds, weight: 1 },
      ]).map((r) => ({ id: r.id, score: r.score }));
    }

    const textRank = new Map(textIds.map((id, i) => [id, i + 1]));
    const hits: SearchHit[] = [];
    for (const { id, score } of ordered) {
      const node = await this.get(id);
      if (!node || !passesFilter(node)) continue;
      hits.push({
        node,
        score,
        matched: {
          text: textRank.has(id) ? textRank.get(id) : undefined,
          semantic: semScore.has(id) ? semScore.get(id) : undefined,
        },
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }
}
