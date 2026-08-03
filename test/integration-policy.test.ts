import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalFor,
  assertManifestIsSafe,
  type IntegrationManifest,
} from "../src/integration-policy.ts";

test("ordinary reads do not require consequential-action approval", () => {
  assert.equal(approvalFor({ effect: "read", id: "issues.list" }), "not-applicable");
});

test("sensitive reads and every mutation require approval", () => {
  assert.equal(
    approvalFor({ effect: "read", id: "audit.export", sensitive: true }),
    "user-approval",
  );
  assert.equal(approvalFor({ effect: "write", id: "comment.create" }), "user-approval");
  assert.equal(approvalFor({ effect: "delete", id: "issue.delete" }), "user-approval");
  assert.equal(approvalFor({ effect: "publish", id: "release.publish" }), "user-approval");
});

test("manifests cannot contain duplicate operation ids", () => {
  const manifest: IntegrationManifest = {
    id: "github",
    provider: "GitHub",
    status: "source",
    operations: [
      { effect: "read", id: "issues.list" },
      { effect: "write", id: "issues.list" },
    ],
  };

  assert.throws(() => assertManifestIsSafe(manifest), /duplicate operation/);
});
