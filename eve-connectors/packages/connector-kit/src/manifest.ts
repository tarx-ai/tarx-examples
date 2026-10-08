import { z } from "zod";

/** Promotion law: source -> typechecked -> live-verified (see SPEC.md §7). */
export const ConnectorStatus = z.enum(["source", "typechecked", "live-verified"]);

export const ConnectorManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  status: ConnectorStatus,
  provider: z.string().min(1),
  kind: z.literal("conversational"),
  auth: z.object({
    /** "connect" = short-lived token from Vercel Connect; "portable" = env/config credential. */
    outbound: z.enum(["connect", "portable", "connect-or-portable"]),
    connectUid: z.string().optional(),
    scopes: z.array(z.string()).default([]),
  }),
  inbound: z.object({
    route: z.string().startsWith("/"),
    verification: z.enum(["twilio-signature", "slack-v0", "svix", "vercel-oidc", "hmac-sha256"]),
    /** Which provider field dedupes retries. */
    dedupeKey: z.string(),
    events: z.array(z.string()).min(1),
  }),
  outbound: z.object({
    actions: z.array(z.enum(["reply", "typing", "proactive-send"])).min(1),
    threading: z.string(),
  }),
  rateLimits: z.object({ outboundPerSecond: z.number().positive(), burst: z.number().int().positive() }),
  /** Inbound -> first reply latency budget for the launch gate (ms, excluding model time). */
  latencyBudgetMs: z.number().int().positive().default(500),
  allowlist: z.object({ kind: z.enum(["phone", "slack-user", "email"]), configKey: z.string() }),
  env: z.array(z.string()).default([]),
});

export type ConnectorManifest = z.infer<typeof ConnectorManifestSchema>;

export function defineConnectorManifest(m: z.input<typeof ConnectorManifestSchema>): ConnectorManifest {
  return ConnectorManifestSchema.parse(m);
}
