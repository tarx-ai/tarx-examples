import type { TwilioInboundResult, TwilioTextMessage } from "eve/channels/twilio";
import type { ConnectorRuntime } from "../../packages/connector-kit/src/runtime.js";

/** Carrier/compliance keywords. Twilio default opt-out handling auto-replies to these, so the agent stays silent. "YES" is deliberately NOT dropped (Twilio treats it as opt-in, but TARX needs it for approvals); VERIFY whether Twilio double-replies on the chosen number. */
export const COMPLIANCE_KEYWORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "start", "unstop", "help", "info"]);

export function isComplianceKeyword(body: string): boolean {
  return COMPLIANCE_KEYWORDS.has(body.trim().toLowerCase());
}

/**
 * onText: runs after eve verified X-Twilio-Signature and `allowFrom`.
 * Drops compliance keywords and Twilio retries (same MessageSid), then starts/continues the turn.
 */
export function makeOnText(rt: ConnectorRuntime) {
  return async (_ctx: unknown, message: TwilioTextMessage): Promise<TwilioInboundResult> => {
    const t0 = rt.now();
    if (message.messageSid && !(await rt.idempotency.claim(`sms-twilio:${message.messageSid}`))) {
      rt.telemetry.onRejected("sms-twilio", "duplicate");
      return null;
    }
    if (isComplianceKeyword(message.body)) {
      rt.telemetry.onRejected("sms-twilio", "compliance-keyword");
      return null;
    }
    rt.telemetry.onAck("sms-twilio", rt.now() - t0);
    return {
      auth: {
        principalId: message.from,
        principalType: "user",
        authenticator: "twilio",
        attributes: { to: message.to ?? "" },
      },
    };
  };
}
