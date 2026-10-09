/**
 * Email env resolution (generic names only; deployment-specific aliases belong in your private .env.local):
 *   API key : RESEND_API_KEY (full access, because fetching received mail needs read)
 *   From    : TARX_EMAIL_FROM, then RESEND_FROM_ADDRESS (eve registry name). A bare address becomes "TARX <addr>"
 *   Webhook : RESEND_WEBHOOK_SECRET (Svix whsec_...; each Resend webhook endpoint has its own secret)
 *   Allow   : TARX_EMAIL_ALLOW_FROM (comma-separated exact addresses)
 *   ReplyTo : TARX_EMAIL_REPLY_TO (optional)
 */
type Env = Record<string, string | undefined>;

export const RESEND_API_KEY_VARS = ["RESEND_API_KEY"] as const;
export const RESEND_FROM_VARS = ["TARX_EMAIL_FROM", "RESEND_FROM_ADDRESS"] as const;

function first(env: Env, names: readonly string[]): string | undefined {
  for (const n of names) {
    const v = env[n]?.trim();
    if (v) return v;
  }
  return undefined;
}

export function resendApiKey(env: Env = process.env): string | undefined {
  return first(env, RESEND_API_KEY_VARS);
}

/** "TARX <tarx@example.com>" from either a display-name form or a bare address. */
export function resendFrom(env: Env = process.env, displayName = "TARX"): string | undefined {
  const v = first(env, RESEND_FROM_VARS);
  if (!v) return undefined;
  return v.includes("<") ? v : `${displayName} <${v}>`;
}
