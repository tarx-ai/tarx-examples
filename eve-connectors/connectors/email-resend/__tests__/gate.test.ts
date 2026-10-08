import { expect } from "vitest";
import { createConnectorRuntime } from "../../../packages/connector-kit/src/runtime.js";
import { FailureAlerter } from "../../../packages/connector-kit/src/alert.js";
import { ProviderHttpError } from "../../../packages/connector-kit/src/retry.js";
import { runConnectorContract, type ConnectorHarness } from "../../../packages/connector-kit/src/testing/contract.js";
import { svixSign } from "../../../packages/connector-kit/src/verify.js";
import { EMAIL_INBOUND_ROUTE, emailResendChannel, makeEmailReplyHandler } from "../channel.js";
import { manifest } from "../manifest.js";
import type { ReceivedEmail, ResendClient, SendEmailInput } from "../resend-client.js";

const SECRET = "whsec_" + Buffer.from("gate-secret-0123456789").toString("base64");
const OWNER = "owner@example.com";

function harness(): ConnectorHarness {
  let alerts = 0, seq = 0, lastId = "";
  const failures: number[] = [];
  const turns: Array<{ token: string; text: string; auth: any }> = [];
  const sent: SendEmailInput[] = [];
  const rt = createConnectorRuntime({ alerts: new FailureAlerter(3, () => { alerts++; }) });
  // Provider fake with the same retry/401 semantics as createResendClient (withRetry is unit-tested separately).
  const providerCall = async <T>(fn: () => T): Promise<T> => {
    for (let attempt = 0, refreshed = false; ; attempt++) {
      const status = failures.shift();
      if (status === undefined) return fn();
      if (status === 401 && !refreshed) { refreshed = true; continue; }
      if (attempt >= 3) throw new ProviderHttpError(status);
    }
  };
  const emails = new Map<string, ReceivedEmail>();
  const client: ResendClient = {
    getReceivedEmail: (id) => providerCall(() => emails.get(id)!),
    sendEmail: async (input) => { sent.push(input); return { id: `sent_${sent.length}` }; },
  };
  const channel = emailResendChannel({ runtime: rt, client, webhookSecret: SECRET, from: "TARX <tarx@example.com>", allowFrom: [OWNER] });
  const route = channel.routes.find((r: any) => r.path === EMAIL_INBOUND_ROUTE) as any;
  let pending: Promise<unknown>[] = [];

  const build = (id: string, from: string, opts: { sig?: "bad" | "stale"; body?: string } = {}) => {
    emails.set(id, { id, from, to: ["tarx@example.com"], subject: "Plan", text: "What's on today?", html: null, message_id: `<${id}@example.com>`, headers: {}, authentication: { spf: "pass", dkim: "pass", dmarc: "pass" } });
    const body = opts.body ?? JSON.stringify({ type: "email.received", data: { email_id: id } });
    const ts = String(Math.floor(Date.now() / 1000) - (opts.sig === "stale" ? 600 : 0));
    const sig = opts.sig === "bad" ? "v1,AAAA" : `v1,${svixSign(SECRET, `msg_${id}`, ts, body)}`;
    return new Request(`https://example.ngrok.app${EMAIL_INBOUND_ROUTE}`, { method: "POST", body, headers: { "svix-id": `msg_${id}`, "svix-timestamp": ts, "svix-signature": sig } });
  };

  return {
    manifest,
    request(kind) {
      if (kind === "duplicate") return build(lastId, OWNER);
      const id = (lastId = `em_${++seq}`);
      if (kind === "bad-signature") return build(id, OWNER, { sig: "bad" });
      if (kind === "stale") return build(id, OWNER, { sig: "stale" });
      if (kind === "other-sender") return build(id, "stranger@example.net");
      if (kind === "malformed") return build(id, OWNER, { body: "{not json" });
      return build(id, OWNER);
    },
    async invoke(req) {
      const t0 = performance.now();
      const res: Response = await route.handler(req, {
        from: (token: string) => ({ send: async (text: string, o: any) => { turns.push({ token, text, auth: o.auth }); return { id: `ses_${turns.length}` }; } }),
        waitUntil: (p: Promise<unknown>) => { pending.push(p); },
        params: {}, requestIp: null,
      });
      const ackMs = performance.now() - t0;
      await Promise.all(pending); pending = [];
      return { status: res.status, ackMs };
    },
    turns: () => turns,
    async completeLastTurn(reply) {
      const t = turns.at(-1)!;
      const before = sent.length;
      await makeEmailReplyHandler({ runtime: rt, client, from: "TARX <tarx@example.com>" })(
        { finishReason: "stop", message: reply, sequence: 1, stepIndex: 0, turnId: "turn_1" }, {}, { session: { auth: { current: t.auth, initiator: t.auth } } },
      );
      const s = sent[before]!;
      expect(s.replyTo).toBe("tarx@example.com"); // replies route back to the Resend inbound address
      return { to: s.to, headers: s.headers, idempotencyKey: s.idempotencyKey };
    },
    failProvider(status, n) { for (let i = 0; i < n; i++) failures.push(status); },
    alerts: () => alerts,
  };
}

runConnectorContract("email-resend", harness);
