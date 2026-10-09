import { twilioChannel } from "eve/channels/twilio";
import { listFromEnv, type ConnectorRuntime } from "../../packages/connector-kit/src/runtime.js";
import { makeOnText } from "./handlers.js";

export interface SmsTwilioOptions {
  runtime: ConnectorRuntime;
  /** E.164 numbers allowed to talk to TARX (the owner's phone). Defaults to env TARX_SMS_ALLOW_FROM. */
  allowFrom?: string[];
  /** TARX's Twilio number. Defaults to env TWILIO_FROM_NUMBER. */
  from?: string;
  /**
   * Exact public URL configured in the Twilio console. Required behind ngrok/proxies so the
   * signature check matches. Defaults to env TWILIO_WEBHOOK_URL.
   */
  webhookUrl?: string;
  /**
   * Credential resolvers. Default: env. To source from Vercel Connect, pass resolvers built on
   * getToken/getConnectorMetadata('twilio/<name>') - VERIFY the returned shape for Twilio (no eve helper exists).
   */
  credentials?: { accountSid: () => Promise<string> | string; authToken: () => Promise<string> | string };
}

export function smsTwilioChannel(o: SmsTwilioOptions) {
  const allowFrom = o.allowFrom ?? listFromEnv(process.env.TARX_SMS_ALLOW_FROM);
  if (allowFrom.length === 0) throw new Error("sms-twilio: set TARX_SMS_ALLOW_FROM (never use '*').");
  const from = o.from ?? process.env.TWILIO_FROM_NUMBER;
  const webhookUrl = o.webhookUrl ?? process.env.TWILIO_WEBHOOK_URL;
  return twilioChannel({
    allowFrom,
    turnPolicy: "steer",
    ...(from ? { messaging: { from } } : {}),
    ...(webhookUrl ? { webhookUrl } : {}),
    ...(o.credentials ? { credentials: o.credentials } : {}),
    onText: makeOnText(o.runtime),
  });
}
