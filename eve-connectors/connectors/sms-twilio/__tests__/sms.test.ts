import { describe, expect, it } from "vitest";
import { signTwilioRequest } from "eve/channels/twilio";
import { createConnectorRuntime } from "../../../packages/connector-kit/src/runtime.js";
import { twilioSignature, verifyTwilioSignature } from "../../../packages/connector-kit/src/verify.js";
import { isComplianceKeyword, makeOnText } from "../handlers.js";
import { manifest } from "../manifest.js";

const msg = (over: Partial<Record<string, string>> = {}) =>
  ({ from: "+15550000001", to: "+15550000002", body: "hi tarx", messageSid: "SM1", accountSid: "AC0", raw: new URLSearchParams(), ...over }) as never;

describe("sms-twilio", () => {
  it("manifest is valid", () => expect(manifest.inbound.route).toBe("/eve/v1/twilio/messages"));

  it("kit signer matches eve's Twilio signer (shared verify helper is correct)", () => {
    const params = { Body: "hi", From: "+15550000001", MessageSid: "SM1", To: "+15550000002" };
    const url = "https://example.ngrok.app/eve/v1/twilio/messages";
    const eveSig = signTwilioRequest({ authToken: "test_token", url, params: new URLSearchParams(params) });
    expect(twilioSignature("test_token", url, params)).toBe(eveSig);
    expect(verifyTwilioSignature("test_token", url, params, eveSig)).toBe(true);
    expect(verifyTwilioSignature("wrong", url, params, eveSig)).toBe(false);
    expect(verifyTwilioSignature("test_token", url.replace("ngrok", "other"), params, eveSig)).toBe(false);
  });

  it("drops compliance keywords", async () => {
    expect(isComplianceKeyword(" STOP ")).toBe(true);
    const onText = makeOnText(createConnectorRuntime());
    expect(await onText({}, msg({ body: "HELP" }))).toBeNull();
  });

  it("dispatches once per MessageSid (Twilio retries are deduped)", async () => {
    const onText = makeOnText(createConnectorRuntime());
    const first = await onText({}, msg());
    expect(first?.auth?.principalId).toBe("+15550000001");
    expect(await onText({}, msg())).toBeNull();
    expect(await onText({}, msg({ messageSid: "SM2" }))).not.toBeNull();
  });
});
