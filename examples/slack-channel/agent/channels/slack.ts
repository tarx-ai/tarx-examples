import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

import { requireConnectorUid } from "../../../../src/env.js";

const connectorUid = requireConnectorUid("TARX_SLACK_CONNECTOR_UID");

export default slackChannel({
  credentials: connectSlackCredentials(connectorUid),
});
