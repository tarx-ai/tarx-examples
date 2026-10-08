import { slackConnectorChannel } from "../../connectors/slack/channel.js";
import { runtime } from "../runtime.js";

// Route: POST /eve/v1/slack  (Slack app Event Subscriptions + Interactivity Request URL = <ngrok>/eve/v1/slack)
// Env: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, TARX_SLACK_ALLOW_USERS. Optional Vercel mode: see connectors/slack/connect.ts.
export default slackConnectorChannel({ runtime });
