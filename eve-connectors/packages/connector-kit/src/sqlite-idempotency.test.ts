import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadNodeSqlite, SqliteIdempotencyStore } from "./sqlite-idempotency.js";

const dir = mkdtempSync(join(tmpdir(), "tarx-dedupe-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!loadNodeSqlite())("SqliteIdempotencyStore (Node 24)", () => {
  it("dedupes, expires, and survives a restart", async () => {
    let t = 0;
    const path = join(dir, "d.sqlite");
    const a = new SqliteIdempotencyStore(path, 1000, () => t);
    expect(await a.claim("k")).toBe(true);
    expect(await a.claim("k")).toBe(false);
    a.close();
    const b = new SqliteIdempotencyStore(path, 1000, () => t); // "restart"
    expect(await b.claim("k")).toBe(false);
    t = 1001;
    expect(await b.claim("k")).toBe(true);
    b.close();
  });
  it("two handles on one file: exactly one winner", async () => {
    const path = join(dir, "e.sqlite");
    const a = new SqliteIdempotencyStore(path), b = new SqliteIdempotencyStore(path);
    const r = await Promise.all([a.claim("x"), b.claim("x")]);
    expect(r.filter(Boolean)).toHaveLength(1);
    a.close(); b.close();
  });
});
