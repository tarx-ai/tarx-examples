import { createHmac, timingSafeEqual } from "node:crypto";

export function safeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const ab = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Twilio X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sorted(key+value)...)). */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}
export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, header: string | null): boolean {
  return !!header && safeEqual(twilioSignature(authToken, url, params), header);
}

/** Slack v0 signing: "v0=" + hex(HMAC-SHA256(secret, `v0:${ts}:${body}`)), 5-minute replay window. */
export function slackSignature(secret: string, ts: string, body: string): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
}
export function verifySlackSignature(secret: string, ts: string | null, body: string, header: string | null, nowSec = Date.now() / 1000, toleranceSec = 300): boolean {
  if (!ts || !header || !/^\d+$/.test(ts)) return false;
  if (Math.abs(nowSec - Number(ts)) > toleranceSec) return false;
  return safeEqual(slackSignature(secret, ts, body), header);
}

/**
 * Svix (used by Resend webhooks). Secret "whsec_<base64>"; signed content `${id}.${ts}.${body}`;
 * header "svix-signature" holds space-separated "v1,<base64sig>" entries (key rotation => several).
 */
export function svixSign(secret: string, id: string, ts: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}
export function verifySvix(
  secret: string,
  h: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  nowSec = Date.now() / 1000,
  toleranceSec = 300,
): boolean {
  if (!h.id || !h.timestamp || !h.signature || !/^\d+$/.test(h.timestamp)) return false;
  if (Math.abs(nowSec - Number(h.timestamp)) > toleranceSec) return false;
  const expected = svixSign(secret, h.id, h.timestamp, body);
  return h.signature.split(" ").some((entry) => {
    const [version, sig] = entry.split(",", 2);
    return version === "v1" && !!sig && safeEqual(sig, expected);
  });
}
