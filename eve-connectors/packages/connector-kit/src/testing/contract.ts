import { describe, expect, it } from "vitest";
import type { ConnectorManifest } from "../manifest.js";

/** What a connector provides so the launch gate can drive its inbound route like the provider would. */
export interface ConnectorHarness {
  manifest: ConnectorManifest;
  /** Build a provider-shaped request. `duplicate` reuses the previous provider message id. */
  request(kind: "valid" | "bad-signature" | "stale" | "other-sender" | "duplicate" | "malformed"): Request;
  /** Invoke the connector's inbound route and wait for background work (waitUntil) to settle. */
  invoke(req: Request): Promise<{ status: number; ackMs: number }>;
  /** Turns started via from(token).send(...) since the harness was created. */
  turns(): Array<{ token: string; text: string; auth: unknown }>;
  /** Simulate the agent's completed reply for the last turn; returns what was sent to the provider. */
  completeLastTurn(reply: string): Promise<{ to: string[]; headers?: Record<string, string>; idempotencyKey?: string }>;
  /** Make the provider fail the next `n` calls with `status` (e.g. 503, 429, 401). */
  failProvider(status: number, n: number): void;
  alerts(): number;
}

/** The launch gate. A connector moves past `source` only when this passes (plus live proof for `live-verified`). */
export function runConnectorContract(name: string, make: () => ConnectorHarness | Promise<ConnectorHarness>) {
  describe(`launch gate: ${name}`, () => {
    it("valid inbound -> exactly one turn, acked within the latency budget", async () => {
      const h = await make();
      const r = await h.invoke(h.request("valid"));
      expect(r.status).toBe(200);
      expect(r.ackMs).toBeLessThan(h.manifest.latencyBudgetMs);
      expect(h.turns()).toHaveLength(1);
    });
    it("rejects a bad signature with 401 and no turn", async () => {
      const h = await make();
      expect((await h.invoke(h.request("bad-signature"))).status).toBe(401);
      expect(h.turns()).toHaveLength(0);
    });
    it("rejects a stale (replayed) signature", async () => {
      const h = await make();
      expect((await h.invoke(h.request("stale"))).status).toBe(401);
      expect(h.turns()).toHaveLength(0);
    });
    it("drops non-allowlisted senders (2xx so the provider stops retrying, no turn)", async () => {
      const h = await make();
      const r = await h.invoke(h.request("other-sender"));
      expect(r.status).toBeLessThan(300);
      expect(h.turns()).toHaveLength(0);
    });
    it("dedupes provider retries of the same message", async () => {
      const h = await make();
      await h.invoke(h.request("valid"));
      await h.invoke(h.request("duplicate"));
      expect(h.turns()).toHaveLength(1);
    });
    it("rejects malformed payloads without a turn", async () => {
      const h = await make();
      expect((await h.invoke(h.request("malformed"))).status).toBeGreaterThanOrEqual(400);
      expect(h.turns()).toHaveLength(0);
    });
    it("retries provider 5xx/429 and still starts the turn", async () => {
      const h = await make();
      h.failProvider(503, 1);
      h.failProvider(429, 1);
      await h.invoke(h.request("valid"));
      expect(h.turns()).toHaveLength(1);
    });
    it("recovers from a 401 by refreshing the credential once", async () => {
      const h = await make();
      h.failProvider(401, 1);
      await h.invoke(h.request("valid"));
      expect(h.turns()).toHaveLength(1);
    });
    it("alerts after repeated provider failures", async () => {
      const h = await make();
      h.failProvider(503, 100);
      for (const _ of [1, 2, 3]) await h.invoke(new Request(h.request("valid")));
      expect(h.alerts()).toBe(1);
    });
    it("replies on the same channel/thread with a stable idempotency key", async () => {
      const h = await make();
      await h.invoke(h.request("valid"));
      const a = await h.completeLastTurn("hello from TARX");
      const b = await h.completeLastTurn("hello from TARX");
      expect(a.to).toHaveLength(1);
      expect(a.idempotencyKey).toBe(b.idempotencyKey);
    });
  });
}
