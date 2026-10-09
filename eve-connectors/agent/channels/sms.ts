import { smsTwilioChannel } from "../../connectors/sms-twilio/channel.js";
import { runtime } from "../runtime.js";

// Route: POST /eve/v1/twilio/messages  (set as the Twilio number's "A message comes in" webhook)
// Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, TARX_SMS_ALLOW_FROM, TWILIO_WEBHOOK_URL
export default smsTwilioChannel({ runtime });
