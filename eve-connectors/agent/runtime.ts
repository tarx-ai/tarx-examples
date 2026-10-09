import { createConnectorRuntime, listFromEnv } from "../packages/connector-kit/src/runtime.js";
import { FailureAlerter } from "../packages/connector-kit/src/alert.js";
import { MemoryIdempotencyStore, type IdempotencyStore } from "../packages/connector-kit/src/idempotency.js";
import { loadNodeSqlite, SqliteIdempotencyStore } from "../packages/connector-kit/src/sqlite-idempotency.js";
import { noopTelemetry } from "../packages/connector-kit/src/telemetry.js";

/**
 * Dedupe store. Mode B (single host): durable SQLite file, default `.data/tarx-dedupe.sqlite`.
 * Set TARX_DEDUPE_DB=memory to opt out (tests / throwaway runs).
 */
function dedupeStore(): IdempotencyStore {
  const path = process.env.TARX_DEDUPE_DB ?? ".data/tarx-dedupe.sqlite";
  if (path === "memory") return new MemoryIdempotencyStore();
  if (!loadNodeSqlite()) {
    console.warn("[tarx-connectors] node:sqlite unavailable (need Node 24); falling back to in-memory dedupe.");
    return new MemoryIdempotencyStore();
  }
  return new SqliteIdempotencyStore(path);
}

/** One runtime shared by all channels in this process. Failure alerts are logged (target: Slack DM, see SPEC). */
export const runtime = createConnectorRuntime({
  idempotency: dedupeStore(),
  telemetry: noopTelemetry,
  alerts: new FailureAlerter(Number(process.env.TARX_ALERT_THRESHOLD ?? 3), (connector, failures, lastError) => {
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    console.error(`[tarx-connectors] ${connector}: ${failures} consecutive failures; last: ${msg}`);
  }),
});

export { listFromEnv };
