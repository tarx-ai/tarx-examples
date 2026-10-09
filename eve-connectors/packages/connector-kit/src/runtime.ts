import { FailureAlerter } from "./alert.js";
import { MemoryIdempotencyStore, type IdempotencyStore } from "./idempotency.js";
import { noopTelemetry, type ConnectorTelemetry } from "./telemetry.js";

/** Shared, process-wide dependencies every connector receives. Override in agent/connector-runtime.ts. */
export interface ConnectorRuntime {
  idempotency: IdempotencyStore;
  telemetry: ConnectorTelemetry;
  alerts: FailureAlerter;
  now: () => number;
}

export function createConnectorRuntime(o: Partial<ConnectorRuntime> & { onAlert?: (c: string, n: number, e: unknown) => void } = {}): ConnectorRuntime {
  return {
    idempotency: o.idempotency ?? new MemoryIdempotencyStore(),
    telemetry: o.telemetry ?? noopTelemetry,
    alerts: o.alerts ?? new FailureAlerter(3, o.onAlert ?? ((c, n) => console.error(`[connector-alert] ${c}: ${n} consecutive failures`))),
    now: o.now ?? Date.now,
  };
}

/** Parse "a, b ,c" allowlists from env. */
export function listFromEnv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
