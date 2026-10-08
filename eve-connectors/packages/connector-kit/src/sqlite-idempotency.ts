import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { IdempotencyStore } from "./idempotency.js";

/** Minimal shape of Node's built-in `node:sqlite` we use (Node >= 22.13 / 24). */
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...a: unknown[]): { changes: number | bigint } };
  close(): void;
}

/** Loads node:sqlite synchronously, or returns undefined on runtimes without it. */
export function loadNodeSqlite(): { DatabaseSync: new (path: string) => SqliteDb } | undefined {
  try {
    return (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.("node:sqlite") as never;
  } catch {
    return undefined;
  }
}

/**
 * Durable dedupe for single-host (Mode B) deployments. Survives restarts, so a provider retry that lands
 * after a crash/restart is still dropped. One atomic upsert per claim; safe across processes on one host (WAL).
 */
export class SqliteIdempotencyStore implements IdempotencyStore {
  private db: SqliteDb;
  private claimStmt;
  private pruneStmt;
  private claims = 0;
  constructor(path: string, private defaultTtlMs = 24 * 60 * 60 * 1000, private now: () => number = Date.now) {
    const sqlite = loadNodeSqlite();
    if (!sqlite) throw new Error("SqliteIdempotencyStore needs Node 24 (node:sqlite).");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new sqlite.DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY, exp INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_seen_exp ON seen(exp);");
    // Insert, or take over an expired row. `changes` is 1 only for the winner.
    this.claimStmt = this.db.prepare("INSERT INTO seen (key, exp) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET exp = excluded.exp WHERE seen.exp <= ?");
    this.pruneStmt = this.db.prepare("DELETE FROM seen WHERE exp <= ?");
  }
  async claim(key: string, ttlMs = this.defaultTtlMs): Promise<boolean> {
    const t = this.now();
    if (++this.claims % 500 === 0) this.pruneStmt.run(t);
    return Number(this.claimStmt.run(key, t + ttlMs, t).changes) === 1;
  }
  close(): void {
    this.db.close();
  }
}
