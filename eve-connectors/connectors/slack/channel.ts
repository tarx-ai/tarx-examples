import { slackChannel, type SlackChannelCredentials } from "eve/channels/slack";
import { listFromEnv, type ConnectorRuntime } from "../../packages/connector-kit/src/runtime.js";
import { makeSlackInbound, makeSlackInputResponse } from "./handlers.js";

export interface SlackOptions {
  runtime: ConnectorRuntime;
  /** Slack user IDs (U...) allowed to talk to TARX. Defaults to env TARX_SLACK_ALLOW_USERS. */
  allowUsers?: string[];
  /**
   * Default (Mode B, local eve behind ngrok): omit. eve reads SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET and verifies
   * Slack's v0 signature itself. Optional Vercel mode: pass `connectSlackCredentialsFromEnv()` from ./connect.ts.
   */
  credentials?: SlackChannelCredentials;
}

export function slackConnectorChannel(o: SlackOptions) {
  const allowUsers = o.allowUsers ?? listFromEnv(process.env.TARX_SLACK_ALLOW_USERS);
  if (allowUsers.length === 0) throw new Error("slack: set TARX_SLACK_ALLOW_USERS.");
  if (!o.credentials && (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_SIGNING_SECRET)) {
    throw new Error("slack: set SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET (or pass Connect credentials).");
  }
  const inbound = makeSlackInbound(o.runtime, allowUsers);
  return slackChannel({
    ...(o.credentials ? { credentials: o.credentials } : {}),
    turnPolicy: "steer",
    onAppMention: inbound,
    onDirectMessage: inbound,
    onInputResponse: makeSlackInputResponse(o.runtime, allowUsers),
  });
}
