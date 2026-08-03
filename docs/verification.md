# Verification contract

Every integration moves through four explicit states.

| State | Required evidence |
|---|---|
| `source` | Public code, dependency versions, credential boundary, and limitations are documented. |
| `typechecked` | A clean install, unit tests, and TypeScript validation pass. |
| `live-verified` | A real provider installation completes the defined happy path and at least one failure path with redacted evidence. |
| `upstream-validated` | A provider/framework maintainer accepts the reproducer, documentation, issue, or patch—or the relevant upstream suite runs the pattern. |

## Live proof packet

A live proof must record:

- Git commit and dependency lockfile hash.
- Provider and connector type, never the credential.
- Minimum requested scopes and events.
- Exact user action and visible result.
- Authorization and approval behavior.
- Retry, denial, invalid-signature, or revoked-token behavior.
- Whether data crossed the local machine or entered a cloud service.
- Known limitations and a status change approved by the evidence owner.

Screenshots without identity, versions, and failure behavior are marketing assets—not integration proof.
