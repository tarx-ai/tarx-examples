import { defineChannel, POST } from "eve/channels";
import { listFromEnv, type ConnectorRuntime } from "../../packages/connector-kit/src/runtime.js";
import { verifySvix } from "../../packages/connector-kit/src/verify.js";
import { addressOf, addressedTo, checkSender, replyHeaders, stripQuotedReply, threadInfo, bodyText } from "./handlers.js";
import type { ResendClient } from "./resend-client.js";
import { RESEND_FROM_VARS, resendFrom } from "./env.js";

export const EMAIL_INBOUND_ROUTE = "/connectors/email-resend/inbound";

export interface EmailResendOptions {
  runtime: ConnectorRuntime;
  client: ResendClient;
  /** Resend webhook signing secret (whsec_...). Default env RESEND_WEBHOOK_SECRET. */
  webhookSecret?: string;
  /** Sender on a Resend-verified domain, e.g. "TARX <tarx@example.com>". Default: TARX_EMAIL_FROM, then RESEND_FROM_ADDRESS. */
  from?: string;
  /** Exact addresses allowed to email TARX. Default env TARX_EMAIL_ALLOW_FROM. */
  allowFrom?: string[];
  /** Reply-To on TARX's emails. Default env TARX_EMAIL_REPLY_TO, else the address the user wrote to (the Resend inbound address). */
  replyTo?: string;
  /** Only accept mail addressed to this receiving domain (e.g. "in.example.com"). Default env TARX_EMAIL_INBOUND_DOMAIN. */
  inboundDomain?: string;
}

export function emailResendChannel(o: EmailResendOptions) {
  const secret = o.webhookSecret ?? process.env.RESEND_WEBHOOK_SECRET ?? "";
  const from = o.from ?? resendFrom() ?? "";
  const allow = o.allowFrom ?? listFromEnv(process.env.TARX_EMAIL_ALLOW_FROM);
  if (!secret || !from || allow.length === 0) throw new Error(`email-resend: set RESEND_WEBHOOK_SECRET, one of ${RESEND_FROM_VARS.join("/")}, and TARX_EMAIL_ALLOW_FROM.`);
  const inboundDomain = o.inboundDomain ?? process.env.TARX_EMAIL_INBOUND_DOMAIN;
  const { runtime: rt, client } = o;

  return defineChannel({
    turnPolicy: "queue", // an email is a complete message; don't interrupt the current reply
    routes: [
      POST(EMAIL_INBOUND_ROUTE, async (request, { from: source, waitUntil }) => {
        const t0 = rt.now();
        const body = await request.text();
        const ok = verifySvix(secret, { id: request.headers.get("svix-id"), timestamp: request.headers.get("svix-timestamp"), signature: request.headers.get("svix-signature") }, body, rt.now() / 1000);
        if (!ok) { rt.telemetry.onRejected("email-resend", "signature"); return new Response("unauthorized", { status: 401 }); }
        let event: { type?: string; data?: { email_id?: string } };
        try { event = JSON.parse(body); } catch { rt.telemetry.onRejected("email-resend", "malformed"); return new Response("bad request", { status: 400 }); }
        if (event.type !== "email.received" || !event.data?.email_id) return new Response("ignored");
        const emailId = event.data.email_id;
        if (!(await rt.idempotency.claim(`email-resend:${emailId}`))) { rt.telemetry.onRejected("email-resend", "duplicate"); return new Response("duplicate"); }

        // Ack immediately (Resend retries non-2xx); do the fetch + turn after the response.
        waitUntil(
          (async () => {
            try {
              const email = await client.getReceivedEmail(emailId);
              if (!addressedTo(email, inboundDomain)) { rt.telemetry.onRejected("email-resend", "allowlist"); return; }
              const sender = checkSender(email, allow);
              if (!sender.ok) { rt.telemetry.onRejected("email-resend", sender.reason); return; }
              const text = bodyText(email);
              if (!text) return;
              const t = threadInfo(email);
              await source(t.token).send(email.subject ? `Subject: ${email.subject}\n\n${text}` : text, {
                auth: {
                  principalId: sender.sender,
                  principalType: "user",
                  authenticator: "resend-email",
                  attributes: { replyTo: sender.sender, tarxAddress: addressOf(email.to?.[0] ?? ""), subject: t.replySubject, messageId: t.messageId, references: t.references, receivedAt: String(t0) },
                },
              });
              rt.alerts.success("email-resend");
            } catch (err) {
              rt.telemetry.onProviderError("email-resend", err, { stage: "inbound" });
              await rt.alerts.failure("email-resend", err);
            }
          })(),
        );
        rt.telemetry.onAck("email-resend", rt.now() - t0);
        return new Response("ok");
      }),
    ],
    events: { "message.completed": makeEmailReplyHandler({ runtime: rt, client, from, replyTo: o.replyTo ?? process.env.TARX_EMAIL_REPLY_TO }) },
  });
}

type CompletedData = { finishReason: string; message: string; sequence: number; stepIndex?: number; turnId: string };
type AuthCtx = { attributes: Readonly<Record<string, string | readonly string[]>> } | null;

/** Sends the agent's reply as a threaded email. Exported so the launch gate can drive it directly. */
export function makeEmailReplyHandler(d: { runtime: ConnectorRuntime; client: ResendClient; from: string; replyTo?: string }) {
  const { runtime: rt, client, from } = d;
  return async (data: CompletedData, _channel: unknown, ctx: { session: { auth: { current: AuthCtx; initiator: AuthCtx } } }) => {
    if (data.finishReason === "tool-calls" || !data.message.trim()) return;
    const a = ctx.session.auth.current?.attributes ?? ctx.session.auth.initiator?.attributes;
    const replyTo = typeof a?.replyTo === "string" ? a.replyTo : undefined;
    if (!replyTo) return; // not an email-originated turn
    const messageId = typeof a?.messageId === "string" ? a.messageId : "";
    const refs = Array.isArray(a?.references) ? (a.references as string[]) : [];
    const replyToAddr = d.replyTo || (typeof a?.tarxAddress === "string" && a.tarxAddress ? a.tarxAddress : undefined);
    try {
      await client.sendEmail({
        from,
        to: [replyTo],
        subject: typeof a?.subject === "string" ? a.subject : "Re: TARX",
        text: data.message,
        headers: messageId ? replyHeaders(messageId, refs) : {},
        ...(replyToAddr ? { replyTo: replyToAddr } : {}),
        idempotencyKey: `tarx-${data.turnId}-${data.sequence}`, // stable across eve step retries
      });
      rt.alerts.success("email-resend");
      const receivedAt = Number(a?.receivedAt);
      if (Number.isFinite(receivedAt)) rt.telemetry.onTurnLatency("email-resend", rt.now() - receivedAt);
    } catch (err) {
      rt.telemetry.onProviderError("email-resend", err, { stage: "reply" });
      await rt.alerts.failure("email-resend", err);
      throw err; // let eve's durable step retry; the Idempotency-Key prevents duplicate sends
    }
  };
}
