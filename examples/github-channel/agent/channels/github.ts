import { connectGitHubCredentials } from "@vercel/connect/eve";
import { githubChannel } from "eve/channels/github";

import { requireConnectorUid } from "../../../../src/env.js";

const connectorUid = requireConnectorUid("TARX_GITHUB_CONNECTOR_UID");

export default githubChannel({
  botName: process.env.TARX_GITHUB_BOT_NAME ?? "your-agent",
  credentials: connectGitHubCredentials(connectorUid),
});
