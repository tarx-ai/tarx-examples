import { connectLinearCredentials } from "@vercel/connect/eve";
import { linearChannel } from "eve/channels/linear";

import { requireConnectorUid } from "../../../../src/env.js";

const connectorUid = requireConnectorUid("TARX_LINEAR_CONNECTOR_UID");

export default linearChannel({
  credentials: connectLinearCredentials(connectorUid),
});
