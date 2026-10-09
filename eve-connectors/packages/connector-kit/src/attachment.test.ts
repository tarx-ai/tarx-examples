import { describe, expect, it } from "vitest";
import { defineConnectorManifest } from "./manifest.js";
import { UI_PHASE_LABEL, uiPhase } from "./attachment.js";

const device = defineConnectorManifest({
  id: "email-resend",
  version: "0.1.0",
  status: "source",
  provider: "resend",
  kind: "conversational",
  auth: { outbound: "portable", scopes: [] },
  inbound: { route: "/connectors/email-resend/inbound", verification: "svix", dedupeKey: "svix-id", events: ["email.received"] },
  outbound: { actions: ["reply"], threading: "in-reply-to" },
  rateLimits: { outboundPerSecond: 1, burst: 2 },
  allowlist: { kind: "email", configKey: "EMAIL_ALLOWLIST" },
  env: [],
});

describe("attachment ui phase", () => {
  it("keeps a source connector off", () => {
    expect(uiPhase({ manifest: device, channelPrivate: true, account: true, providerReady: true, providerError: false })).toBe("off");
    expect(UI_PHASE_LABEL.off).toBe("Not live yet");
  });

  it("asks for a private channel before an account", () => {
    const ready = { ...device, status: "typechecked" as const };
    expect(uiPhase({ manifest: ready, channelPrivate: false, account: false, providerReady: false, providerError: false })).toBe("needs-private-channel");
  });

  it("turns on only when live-verified and the provider is ready", () => {
    const live = { ...device, status: "live-verified" as const };
    expect(uiPhase({ manifest: live, channelPrivate: true, account: true, providerReady: false, providerError: false })).toBe("needs-provider");
    expect(uiPhase({ manifest: live, channelPrivate: true, account: true, providerReady: true, providerError: false })).toBe("on");
    expect(uiPhase({ manifest: live, channelPrivate: true, account: true, providerReady: true, providerError: true })).toBe("error");
  });
});
