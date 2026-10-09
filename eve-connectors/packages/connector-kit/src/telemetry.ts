import { createSocket } from "node:dgram";

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

/**
 * DogStatsD / UDP adapter — the production path for turn-quality metrics.
 *
 * Metrics go to a LOCAL Datadog agent over UDP (default 127.0.0.1:8125); the
 * agent forwards to the Datadog site (us5) with the org API key the agent
 * already holds. The connector process therefore holds NO Datadog key and
 * makes NO outbound HTTP on the reply hot path (unlike datadogTelemetry).
 *
 * Only connector name + coarse tags cross the boundary. Never a message body,
 * sender, address, phone number, or token. Fire-and-forget: a UDP send never
 * blocks or throws into a turn.
 *
 *   DogStatsD line format:
 *     <metric>:<value>|<type>|#tag1,tag2       (ms -> |ms gauge-ish timer; counts -> |c)
 */
export function datadogUdpTelemetry(opts: {
  host?: string;
  port?: number;
  /** Fixed low-cardinality tags added to every metric, e.g. ["env:prod","dd_site:us5"]. */
  globalTags?: string[];
  /** Injected socket factory for tests. Defaults to node:dgram. */
  socketFactory?: () => { send: (buf: Uint8Array, port: number, host: string) => void; close: () => void };
} = {}): ConnectorTelemetry {
  const host = opts.host ?? process.env.TARX_DD_AGENT_HOST ?? process.env.DD_AGENT_HOST ?? "127.0.0.1";
  const port = opts.port ?? Number(process.env.TARX_DD_DOGSTATSD_PORT ?? process.env.DD_DOGSTATSD_PORT ?? 8125);
  const base = opts.globalTags ?? ["dd_site:us5"];

  let sock: { send: (b: Uint8Array, p: number, h: string) => void; close: () => void } | null = null;
  const socket = () => {
    if (sock) return sock;
    if (opts.socketFactory) { sock = opts.socketFactory(); return sock; }
    try {
      const s = createSocket("udp4");
      s.unref?.();
      sock = { send: (b, p, h) => s.send(b as Buffer, p, h, () => {}), close: () => s.close() };
    } catch {
      sock = { send: () => {}, close: () => {} }; // no-op if dgram unavailable
    }
    return sock;
  };

  const safe = /^[a-z0-9_.-]{1,40}$/i;
  const mkTags = (extra?: Record<string, string>): string[] => {
    const t = [...base];
    if (extra) for (const [k, v] of Object.entries(extra)) if (safe.test(k) && safe.test(v)) t.push(`${k}:${v}`);
    return t;
  };
  const emit = (metric: string, value: number, type: "ms" | "c", tags: string[]) => {
    try {
      const line = `${metric}:${value}|${type}${tags.length ? "|#" + tags.join(",") : ""}`;
      socket().send(Buffer.from(line, "utf8"), port, host);
    } catch { /* telemetry must never break a turn */ }
  };

  return {
    onAck: (c, ms) => emit("tarx.connector.ack_ms", ms, "ms", mkTags({ connector: c })),
    onTurnLatency: (c, ms, t) => emit("tarx.connector.turn_ms", ms, "ms", mkTags({ connector: c, ...pickSafe(t) })),
    onProviderError: (c, _e, t) => emit("tarx.connector.provider_error", 1, "c", mkTags({ connector: c, ...pickSafe(t) })),
    onRejected: (c, reason) => emit("tarx.connector.rejected", 1, "c", mkTags({ connector: c, reason })),
  };
}

/** Drop any tag whose value is free-text/PII-shaped (keeps short tokens only). */
function pickSafe(t?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!t) return out;
  const safe = /^[a-z0-9_.-]{1,40}$/i;
  for (const [k, v] of Object.entries(t)) if (safe.test(k) && safe.test(v)) out[k] = v;
  return out;
}
