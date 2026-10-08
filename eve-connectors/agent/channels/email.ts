import { emailResendChannel } from "../../connectors/email-resend/channel.js";
import { RESEND_API_KEY_VARS, resendApiKey } from "../../connectors/email-resend/env.js";
import { createResendClient } from "../../connectors/email-resend/resend-client.js";
import { runtime } from "../runtime.js";

// Route: POST /connectors/email-resend/inbound  (Resend webhook, event email.received, URL <ngrok>/connectors/email-resend/inbound)
// Env: RESEND_API_KEY (full access), TARX_EMAIL_FROM (or RESEND_FROM_ADDRESS), optional TARX_EMAIL_REPLY_TO,
//   RESEND_WEBHOOK_SECRET (secret of the NEW email.received endpoint), plus TARX_EMAIL_ALLOW_FROM.
export default emailResendChannel({
  runtime,
  client: createResendClient({
    apiKey: () => {
      const k = resendApiKey();
      if (!k) throw new Error(`email-resend: set one of ${RESEND_API_KEY_VARS.join(", ")}`);
      return k;
    },
  }),
});
