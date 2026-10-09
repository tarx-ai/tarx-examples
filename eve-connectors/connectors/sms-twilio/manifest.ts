import { defineConnectorManifest } from "../../packages/connector-kit/src/manifest.js";

export const manifest = defineConnectorManifest({
  id: "sms-twilio",
  version: "0.1.0",
  status: "source",
  provider: "twilio",
  kind: "conversational",
  auth: { outbound: "connect-or-portable", connectUid: "twilio/tarx-sms", scopes: [] },
  inbound: { route: "/eve/v1/twilio/messages", verification: "twilio-signature", dedupeKey: "MessageSid", events: ["sms.received"] },
  outbound: { actions: ["reply", "proactive-send"], threading: "continuation token <From>:<To> (one session per phone pair)" },
  rateLimits: { outboundPerSecond: 1, burst: 3 },
  latencyBudgetMs: 500,
  allowlist: { kind: "phone", configKey: "TARX_SMS_ALLOW_FROM" },
  env: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "TARX_SMS_ALLOW_FROM", "TWILIO_WEBHOOK_URL?"],
});
