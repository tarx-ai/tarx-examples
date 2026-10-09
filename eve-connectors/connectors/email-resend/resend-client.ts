import { ensureOk, withRetry } from "../../packages/connector-kit/src/retry.js";

export interface ReceivedEmail {
  id: string;
  from: string;
  to: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  message_id: string | null;
  headers: Record<string, string> | null;
  authentication: { spf: string; dkim: string; dmarc: string } | null;
}

export interface SendEmailInput {
  from: string;
  to: string[];
  subject: string;
  text: string;
  headers?: Record<string, string>;
  /** Where the user's reply should go: TARX's Resend receiving address (the From domain may route mail elsewhere). */
  replyTo?: string;
  idempotencyKey: string;
}

export interface ResendClient {
  getReceivedEmail(id: string): Promise<ReceivedEmail>;
  sendEmail(input: SendEmailInput): Promise<{ id: string }>;
}

/**
 * Minimal fetch client. `apiKey` is a resolver so it can come from env or Vercel Connect
 * (getToken('resend/<name>', { subject: { type: 'app' } }) - VERIFY the api-key connector returns the raw key).
 */
export function createResendClient(o: { apiKey: () => Promise<string> | string; onUnauthorized?: () => void; fetchImpl?: typeof fetch; baseUrl?: string }): ResendClient {
  const f = o.fetchImpl ?? fetch;
  const base = o.baseUrl ?? "https://api.resend.com";
  const retry = { retries: 3, ...(o.onUnauthorized ? { onUnauthorized: o.onUnauthorized } : {}) };
  return {
    async getReceivedEmail(id) {
      // Verified 2026-10-07 against Resend "Retrieve Received Email": GET /emails/receiving/{id}; authentication is server-computed.
      return withRetry(async () => {
        const res = await ensureOk(await f(`${base}/emails/receiving/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${await o.apiKey()}` } }));
        return (await res.json()) as ReceivedEmail;
      }, retry);
    },
    async sendEmail(input) {
      return withRetry(async () => {
        const res = await ensureOk(
          await f(`${base}/emails`, {
            method: "POST",
            headers: { authorization: `Bearer ${await o.apiKey()}`, "content-type": "application/json", "idempotency-key": input.idempotencyKey },
            body: JSON.stringify({ from: input.from, to: input.to, subject: input.subject, text: input.text, headers: input.headers, ...(input.replyTo ? { reply_to: input.replyTo } : {}) }),
          }),
        );
        return (await res.json()) as { id: string };
      }, retry);
    },
  };
}
