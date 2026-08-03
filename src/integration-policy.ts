export const EFFECTS = ["read", "write", "delete", "publish"] as const;

export type IntegrationEffect = (typeof EFFECTS)[number];
export type ApprovalDecision = "not-applicable" | "user-approval";

export interface IntegrationOperation {
  effect: IntegrationEffect;
  id: string;
  sensitive?: boolean;
}

export interface IntegrationManifest {
  id: string;
  operations: readonly IntegrationOperation[];
  provider: string;
  status: "source" | "typechecked" | "live-verified" | "upstream-validated";
}

export function approvalFor(operation: IntegrationOperation): ApprovalDecision {
  if (operation.sensitive === true) return "user-approval";
  return operation.effect === "read" ? "not-applicable" : "user-approval";
}

export function assertManifestIsSafe(manifest: IntegrationManifest): void {
  if (manifest.operations.length === 0) {
    throw new Error(`${manifest.id} must declare at least one operation.`);
  }

  const ids = new Set<string>();
  for (const operation of manifest.operations) {
    if (ids.has(operation.id)) {
      throw new Error(`${manifest.id} declares duplicate operation ${operation.id}.`);
    }
    ids.add(operation.id);
  }
}
