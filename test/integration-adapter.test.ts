import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSafeContext,
  requiresMatchingApproval,
  type IntegrationContext,
} from "../src/integration-adapter.ts";

function context(overrides: Partial<IntegrationContext> = {}): IntegrationContext {
  return {
    credentialHandle: { id: "vault://github/test-installation", kind: "opaque-credential-handle" },
    evidenceSink: {
      async record() {
        return { evidenceId: "evt_test" };
      },
    },
    idempotencyKey: "idem_test",
    principal: { id: "user_test", type: "user" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("safe context accepts only the public boundary fields", () => {
  assert.doesNotThrow(() => assertSafeContext(context()));
});

test("an opaque credential handle and idempotency key are mandatory", () => {
  assert.throws(
    () => assertSafeContext(context({ credentialHandle: { id: "", kind: "opaque-credential-handle" } })),
    /opaque credential handle/,
  );
  assert.throws(() => assertSafeContext(context({ idempotencyKey: "" })), /idempotency key/);
});

test("consequential operations require a matching approval receipt", () => {
  const write = { effect: "write" as const, id: "issue.comment.create" };
  assert.equal(requiresMatchingApproval(write, context()), true);
  assert.equal(
    requiresMatchingApproval(
      write,
      context({
        approvalGrant: {
          approvedAt: "2026-08-03T18:00:00.000Z",
          operationId: write.id,
          receiptId: "approval_test",
        },
      }),
    ),
    false,
  );
});
