import { describe, expect, it } from "vitest";
import { resendApiKey, resendFrom } from "../env.js";
import { svixSign, verifySvix } from "../../../packages/connector-kit/src/verify.js";
import { addressOf, addressedTo, bodyText, checkSender, replyHeaders, stripQuotedReply, threadInfo, threadToken } from "../handlers.js";

const SECRET = "whsec_" + Buffer.from("test-secret-key-0123456789").toString("base64");

describe("email-resend helpers", () => {
  it("inbound domain guard", () => {
    expect(addressedTo({ to: ["TARX <agent@in.example.com>"] }, "in.example.com")).toBe(true);
    expect(addressedTo({ to: ["agent@example.com"] }, "in.example.com")).toBe(false);
    expect(addressedTo({ to: ["x@evil-in.example.com"] }, "in.example.com")).toBe(false);
    expect(addressedTo({ to: ["a@b.c"] }, undefined)).toBe(true);
  });
  it("svix: valid, rotated multi-signature header, tampered, stale, missing", () => {
    const now = 1_800_000_000, ts = String(now), body = '{"type":"email.received"}';
    const sig = svixSign(SECRET, "msg_1", ts, body);
    expect(verifySvix(SECRET, { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, body, now)).toBe(true);
    expect(verifySvix(SECRET, { id: "msg_1", timestamp: ts, signature: `v1,AAAA v1,${sig}` }, body, now)).toBe(true);
    expect(verifySvix(SECRET, { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, body + " ", now)).toBe(false);
    expect(verifySvix(SECRET, { id: "msg_1", timestamp: ts, signature: `v1,${sig}` }, body, now + 301)).toBe(false);
    expect(verifySvix(SECRET, { id: null, timestamp: ts, signature: `v1,${sig}` }, body, now)).toBe(false);
  });

  it("sender check needs allowlist AND DMARC pass with SPF or DKIM", () => {
    const pass = { spf: "pass", dkim: "pass", dmarc: "pass" };
    expect(addressOf("Owner <Owner@Example.com>")).toBe("owner@example.com");
    expect(checkSender({ from: "Owner <owner@example.com>", authentication: pass }, ["owner@example.com"])).toEqual({ ok: true, sender: "owner@example.com" });
    expect(checkSender({ from: "x@evil.example", authentication: pass }, ["owner@example.com"])).toEqual({ ok: false, reason: "allowlist" });
    expect(checkSender({ from: "owner@example.com", authentication: { ...pass, dmarc: "fail" } }, ["owner@example.com"])).toEqual({ ok: false, reason: "auth" });
    expect(checkSender({ from: "owner@example.com", authentication: null }, ["owner@example.com"])).toEqual({ ok: false, reason: "auth" });
    expect(checkSender({ from: "owner@example.com", authentication: { spf: "fail", dkim: "fail", dmarc: "pass" } }, ["owner@example.com"])).toEqual({ ok: false, reason: "auth" });
    expect(checkSender({ from: "owner@example.com", authentication: { spf: "gray", dkim: "pass", dmarc: "gray" } }, ["owner@example.com"])).toEqual({ ok: false, reason: "auth" });
  });

  it("missing Message-ID: deterministic token, nothing fabricated", () => {
    const a = threadInfo({ id: "em_9", message_id: null, headers: {}, subject: null });
    const b = threadInfo({ id: "em_9", message_id: null, headers: {}, subject: null });
    expect(a.token).toBe(b.token);
    expect(a.messageId).toBe("");
    expect(a.references).toEqual([]);
  });

  it("reply References keep the thread root when truncated", () => {
    const refs = Array.from({ length: 30 }, (_, i) => `<${i}@x>`);
    const h = replyHeaders("<29@x>", refs).References!.split(" ");
    expect(h).toHaveLength(20);
    expect(h[0]).toBe("<0@x>");
  });

  it("strips quoted replies", () => {
    expect(stripQuotedReply("Sounds good.\n\nOn Tue, Oct 6, 2026 at 9:00 AM TARX <t@example.com> wrote:\n> old")).toBe("Sounds good.");
    expect(stripQuotedReply("Yes\r\n> quoted")).toBe("Yes");
    expect(stripQuotedReply("Plain message\n--\nsig")).toBe("Plain message");
  });

  it("thread token is the thread root; reply headers thread correctly", () => {
    const first = threadInfo({ id: "em_1", message_id: "<a@x>", headers: {}, subject: "Plan" });
    expect(first).toMatchObject({ token: threadToken("<a@x>"), replySubject: "Re: Plan" });
    expect(first.token).toMatch(/^t[0-9a-f]{32}$/);
    const reply = threadInfo({ id: "em_2", message_id: "<c@x>", headers: { References: "<a@x> <b@x>", "In-Reply-To": "<b@x>" }, subject: "Re: Re: Plan" });
    expect(reply.token).toBe(first.token);
    expect(reply.references).toEqual(["<a@x>", "<b@x>", "<c@x>"]);
    expect(reply.replySubject).toBe("Re: Plan");
    expect(replyHeaders(reply.messageId, reply.references)).toEqual({ "In-Reply-To": "<c@x>", References: "<a@x> <b@x> <c@x>" });
  });

  it("falls back to HTML bodies and drops quoted HTML", () => {
    expect(bodyText({ text: null, html: "<div>Ship it &amp; tell me<br>when done</div><div class=\"gmail_quote\">On Tue wrote:<blockquote>old</blockquote></div>" })).toBe("Ship it & tell me\nwhen done");
    expect(bodyText({ text: "plain wins", html: "<p>html</p>" })).toBe("plain wins");
  });

  it("reads TARX's existing Resend env names", () => {
    expect(resendApiKey({ RESEND_API_KEY: "k1" })).toBe("k1");
    expect(resendApiKey({ SOME_OTHER_RESEND_KEY: "k3" })).toBeUndefined(); // no deployment-specific aliases
    expect(resendApiKey({})).toBeUndefined();
    expect(resendFrom({ RESEND_FROM_ADDRESS: "a@example.com" })).toBe("TARX <a@example.com>");
    expect(resendFrom({ TARX_EMAIL_FROM: "t@example.com", RESEND_FROM_ADDRESS: "a@example.com" })).toBe("TARX <t@example.com>");
    expect(resendFrom({ TARX_EMAIL_FROM: "Bot <t@example.com>" })).toBe("Bot <t@example.com>");
  });
});
