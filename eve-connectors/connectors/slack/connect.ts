/**
 * OPTIONAL Vercel mode (not used in Mode B). Requires the optional dependency @vercel/connect and a deployment
 * on Vercel with a Slack Connect connector attached: `vercel connect attach slack/<name> --triggers --trigger-path /eve/v1/slack`.
 * Usage in agent/channels/slack.ts:  slackConnectorChannel({ runtime, credentials: connectSlackCredentialsFromEnv() })
 */
import { connectSlackCredentials } from "@vercel/connect/eve";

export function connectSlackCredentialsFromEnv(uid = process.env.TARX_SLACK_CONNECTOR) {
  if (!uid) throw new Error("slack/connect: set TARX_SLACK_CONNECTOR=slack/<name>.");
  return connectSlackCredentials(uid);
}
