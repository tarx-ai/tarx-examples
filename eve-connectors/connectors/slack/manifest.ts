import { defineConnectorManifest } from "../../packages/connector-kit/src/manifest.js";

export const manifest = defineConnectorManifest({
  id: "slack",
  version: "0.1.0",
  status: "source",
  provider: "slack",
  kind: "conversational",
  auth: { outbound: "portable", scopes: ["app_mentions:read", "chat:write", "im:history", "im:write"] },
  inbound: { route: "/eve/v1/slack", verification: "slack-v0", dedupeKey: "event_id", events: ["app_mention", "message.im"] },
  outbound: { actions: ["reply", "typing", "proactive-send"], threading: "continuation token <channelId>:<threadTs> (eve built-in)" },
  rateLimits: { outboundPerSecond: 1, burst: 5 },
  latencyBudgetMs: 500,
  allowlist: { kind: "slack-user", configKey: "TARX_SLACK_ALLOW_USERS" },
  env: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "TARX_SLACK_ALLOW_USERS", "TARX_SLACK_CONNECTOR? (optional Vercel mode, see connect.ts)"],
});
