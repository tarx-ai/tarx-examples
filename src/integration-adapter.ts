import type { IntegrationManifest, IntegrationOperation } from "./integration-policy.js";

export interface IntegrationPrincipal {
  id: string;
  type: "service" | "user";
}

export interface OpaqueCredentialHandle {
  id: string;
  kind: "opaque-credential-handle";
}

export interface ApprovalGrant {
  approvedAt: string;
  operationId: string;
  receiptId: string;
}

export interface IntegrationEvidenceEvent {
  adapterId: string;
  idempotencyKey: string;
  operationId: string;
  outcome: "denied" | "failed" | "succeeded";
}

export interface EvidenceSink {
  record(event: IntegrationEvidenceEvent): Promise<{ evidenceId: string }>;
}

export interface IntegrationContext {
  approvalGrant?: ApprovalGrant;
  credentialHandle: OpaqueCredentialHandle;
  evidenceSink: EvidenceSink;
  idempotencyKey: string;
  principal: IntegrationPrincipal;
  signal: AbortSignal;
}

export interface ToolDescriptor extends IntegrationOperation {
  description: string;
}

export interface IntegrationResult {
  evidenceId: string;
  ok: boolean;
  output?: unknown;
}

export interface HealthResult {
  evidenceId?: string;
  status: "degraded" | "ready" | "unavailable";
}

export interface IntegrationAdapter {
  manifest: IntegrationManifest;
  discover(context: IntegrationContext): Promise<ToolDescriptor[]>;
  invoke(
    tool: string,
    input: unknown,
    context: IntegrationContext,
  ): Promise<IntegrationResult>;
  health?(context: IntegrationContext): Promise<HealthResult>;
}

export function requiresMatchingApproval(
  operation: IntegrationOperation,
  context: IntegrationContext,
): boolean {
  if (operation.effect === "read" && operation.sensitive !== true) return false;
  return context.approvalGrant?.operationId !== operation.id;
}

export function assertSafeContext(context: IntegrationContext): void {
  if (context.credentialHandle.kind !== "opaque-credential-handle") {
    throw new Error("Integration credentials must be represented by an opaque handle.");
  }

  if (!context.credentialHandle.id.trim()) {
    throw new Error("The opaque credential handle must have an id.");
  }

  if (!context.idempotencyKey.trim()) {
    throw new Error("An idempotency key is required for every invocation.");
  }

  if (!context.principal.id.trim()) {
    throw new Error("A user or service principal is required.");
  }
}
