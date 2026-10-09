import { createConnectorRuntime, listFromEnv } from "../packages/connector-kit/src/runtime.js";
import { FailureAlerter } from "../packages/connector-kit/src/alert.js";
import { MemoryIdempotencyStore, type IdempotencyStore } from "../packages/connector-kit/src/idempotency.js";
import { loadNodeSqlite, SqliteIdempotencyStore } from "../packages/connector-kit/src/sqlite-idempotency.js";
import { datadogUdpTelemetry, noopTelemetry, type ConnectorTelemetry } from "../packages/connector-kit/src/telemetry.js";

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

/**
 * Telemetry sink. Turn-quality metrics (ack_ms, turn_ms, rejected, provider_error)
 * flow through the connector-kit hooks the channels already call. In production
 * they go to a LOCAL Datadog agent over DogStatsD/UDP (which forwards to us5 with
 * the key the agent holds) — the connector process holds no DD key and makes no
 * outbound HTTP on the reply path. Enable by setting TARX_DD_AGENT_HOST (or
 * DD_AGENT_HOST). Unset -> noop (dev/CI). The HTTP intake stub is never used here.
 */
function telemetrySink(): ConnectorTelemetry {
  if (process.env.EVE_TELEMETRY_DISABLED === "1") return noopTelemetry;
  const agent = process.env.TARX_DD_AGENT_HOST ?? process.env.DD_AGENT_HOST;
  if (!agent) return noopTelemetry;
  return datadogUdpTelemetry({
    host: agent,
    globalTags: [`dd_site:us5`, `env:${process.env.TARX_ENV ?? "dev"}`],
  });
}

/** One runtime shared by all channels in this process. Failure alerts are logged (target: Slack DM, see SPEC). */
export const runtime = createConnectorRuntime({
  idempotency: dedupeStore(),
  telemetry: telemetrySink(),
  alerts: new FailureAlerter(Number(process.env.TARX_ALERT_THRESHOLD ?? 3), (connector, failures, lastError) => {
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    console.error(`[tarx-connectors] ${connector}: ${failures} consecutive failures; last: ${msg}`);
  }),
});

export { listFromEnv };
