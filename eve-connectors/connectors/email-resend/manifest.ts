import { defineConnectorManifest } from "../../packages/connector-kit/src/manifest.js";

export const manifest = defineConnectorManifest({
  id: "email-resend",
  version: "0.1.0",
  status: "source",
  provider: "resend",
  kind: "conversational",
  auth: { outbound: "portable", scopes: [] },
  inbound: { route: "/connectors/email-resend/inbound", verification: "svix", dedupeKey: "data.email_id", events: ["email.received"] },
  outbound: { actions: ["reply"], threading: "continuation token = thread root Message-ID; replies set In-Reply-To + References" },
  rateLimits: { outboundPerSecond: 2, burst: 4 },
  latencyBudgetMs: 500,
  allowlist: { kind: "email", configKey: "TARX_EMAIL_ALLOW_FROM" },
  env: ["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "TARX_EMAIL_FROM | RESEND_FROM_ADDRESS", "TARX_EMAIL_ALLOW_FROM"],
});
