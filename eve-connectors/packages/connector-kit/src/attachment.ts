import type { ConnectorManifest } from "./manifest.js";
import type { RejectReason } from "./telemetry.js";

/**
 * One attachment pattern for every connection.
 * The UI, the harness, and Glyph all read this. A connector is not attached
 * by adding a card. It is attached by a manifest plus these steps.
 */

export const UI_PHASES = [
  "off",
  "needs-private-channel",
  "needs-account",
  "needs-provider",
  "on",
  "error",
] as const;

export type UiPhase = (typeof UI_PHASES)[number];

/** Button label for each phase. The thread card and Channel Settings use this list. */
export const UI_PHASE_LABEL: Record<UiPhase, string> = {
  off: "Not live yet",
  "needs-private-channel": "Make private",
  "needs-account": "Sign in",
  "needs-provider": "Connect",
  on: "On",
  error: "Try again",
};

/**
 * Harness order. A reject returns before the model runs.
 * Metrics: ack_ms at ack, turn_ms at reply, rejected{reason} on reject, provider_error on outbound failure.
 */
export const HARNESS_STEPS = [
  "verify",
  "dedupe",
  "allowlist",
  "ack",
  "model",
  "reply",
] as const;

export const METRICS = {
  ack: "tarx.connector.ack_ms",
  turn: "tarx.connector.turn_ms",
  rejected: "tarx.connector.rejected",
  providerError: "tarx.connector.provider_error",
} as const;

export function surfaceFor(manifest: ConnectorManifest): "web" | "device" {
  return manifest.inbound.verification === "vercel-oidc" ? "web" : "device";
}

export function uiPhase(input: {
  manifest: ConnectorManifest;
  channelPrivate: boolean;
  account: boolean;
  providerReady: boolean;
  providerError: boolean;
}): UiPhase {
  if (input.providerError) return "error";
  if (input.manifest.status === "source") return "off";
  const web = surfaceFor(input.manifest) === "web";
  if (!web && !input.channelPrivate) return "needs-private-channel";
  if (!input.account) return "needs-account";
  if (input.manifest.status !== "live-verified" || !input.providerReady) return "needs-provider";
  return "on";
}

/** Reasons the harness may reject before the model. The metric tag uses these strings. */
export const REJECT_BEFORE_MODEL: RejectReason[] = [
  "signature",
  "malformed",
  "duplicate",
  "allowlist",
  "allowlist-hitl",
  "compliance-keyword",
  "auth",
];
