export type RejectReason = "signature" | "allowlist" | "allowlist-hitl" | "duplicate" | "auth" | "malformed" | "compliance-keyword";
export interface ConnectorTelemetry {
  /** Inbound webhook received -> acknowledged (ms). */
  onAck(connector: string, ms: number): void;
  /** Inbound message -> reply delivered on the provider (ms). The headline conversational metric. */
  onTurnLatency(connector: string, ms: number, tags?: Record<string, string>): void;
  onProviderError(connector: string, err: unknown, tags?: Record<string, string>): void;
  onRejected(connector: string, reason: RejectReason): void;
}

export const noopTelemetry: ConnectorTelemetry = { onAck() {}, onTurnLatency() {}, onProviderError() {}, onRejected() {} };

/**
 * Datadog adapter (stub). VERIFY: endpoint/payload against Datadog's metrics intake docs before enabling.
 * Never sends message bodies or identifiers - only connector name, metric, and coarse tags.
 */
export function datadogTelemetry(opts: { apiKey: () => Promise<string>; site?: string; fetchImpl?: typeof fetch }): ConnectorTelemetry {
  const f = opts.fetchImpl ?? fetch;
  const send = (metric: string, value: number, tags: string[]) =>
    void opts.apiKey().then((key) =>
      f(`https://api.${opts.site ?? "datadoghq.com"}/api/v2/series`, {
        method: "POST",
        headers: { "DD-API-KEY": key, "content-type": "application/json" },
        body: JSON.stringify({ series: [{ metric, type: 3, points: [{ timestamp: Math.floor(Date.now() / 1000), value }], tags }] }),
      }).catch(() => undefined),
    );
  return {
    onAck: (c, ms) => send("tarx.connector.ack_ms", ms, [`connector:${c}`]),
    onTurnLatency: (c, ms) => send("tarx.connector.turn_ms", ms, [`connector:${c}`]),
    onProviderError: (c) => send("tarx.connector.provider_error", 1, [`connector:${c}`]),
    onRejected: (c, reason) => send("tarx.connector.rejected", 1, [`connector:${c}`, `reason:${reason}`]),
  };
}
