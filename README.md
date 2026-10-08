# TARX Integration Patterns

Public, testable integration contracts and vendor-specific reference configuration.

This repository is intentionally narrower than TARX Computer. It contains example configuration and TARX-authored safety helpers. It does **not** contain TARX Computer source, TARX's private runtime, credentials, customer data, or Supercomputer infrastructure.

## Current status

| Surface | Kind | Source | Typechecked | Live connector proof | Upstream validation |
|---|---|---:|---:|---:|---:|
| TARX adapter contract | Framework-neutral | Yes | Yes | Unit tested | TARX-owned |
| GitHub channel | Eve reference configuration | Yes | Yes | No | No |
| Slack channel | Eve reference configuration | Yes | Yes | No | No |
| Linear channel | Eve reference configuration | Yes | Yes | No | No |
| SMS / Slack / Email connectors (`eve-connectors/`) | Self-contained eve 0.74 app + connector kit | Yes | Yes | Contract-tested (42 tests) | No |
| Glyph worker (`glyph-worker/`) | Guarded $0 model worker: build / dataset / review | Yes | Yes | Unit-tested (17 tests); smoke-tested Oct 8 | No |

`Source` means the contract or reference configuration exists. It does not mean the provider is installed, authorized, deployed, or available in TARX Computer. The Eve channel files are vendor-specific recipes, not TARX adapter implementations.

## Why this exists

An integration is credible only when its source is inspectable, its permissions are narrow, its consequential actions are approval-gated, and an outsider can reproduce the result.

The operating sequence is:

1. Publish the smallest useful pattern.
2. Typecheck and test it.
3. Connect a real provider account with the minimum scopes.
4. Capture an outside-in proof with exact versions and limitations.
5. Contribute reproducible fixes or documentation upstream.

## Patterns

- [`src/integration-adapter.ts`](src/integration-adapter.ts) — the framework-neutral TARX adapter boundary.
- [`docs/architecture.md`](docs/architecture.md) — public API shape, trust boundary, and promotion rules.
- [`examples/github-channel`](examples/github-channel/README.md) — GitHub App webhooks and native issue/PR replies through Vercel Connect.
- [`examples/slack-channel`](examples/slack-channel/README.md) — Slack mentions and DMs through Vercel Connect.
- [`examples/linear-channel`](examples/linear-channel/README.md) — Linear Agent Sessions through Vercel Connect.
- [`eve-connectors`](eve-connectors/README.md): a self-contained eve 0.74 app with SMS (Twilio), Slack, and Email (Resend) channels, a shared connector kit (signature verification, durable SQLite dedupe, rate limits, retries, alerts), a launch-gate contract test, and a connector generator. It is its own package (Node 24), so run `npm ci && npm test` inside that folder.
- [`glyph-worker`](glyph-worker/README.md): a guarded worker for the `stealth/glyph-cluster` model on Vercel AI Gateway, with fail-closed data-boundary and $0 price guards, JSONL call logs, and `build` / `dataset` / `review` profiles. It proposes; the TARX agent reviews and commits. Ranked backlog in [`glyph-worker/SCOPE.md`](glyph-worker/SCOPE.md).
- [`src/integration-policy.ts`](src/integration-policy.ts) — a framework-neutral effect and approval policy for adapter authors.

All channel reference configurations pin `eve@0.27.13` and `@vercel/connect@0.6.0`, the versions inspected when this repository was activated. Eve is a public framework dependency; it is not copied or exposed as TARX runtime source.

## Run the checks

```bash
npm install
npm test
npm run typecheck
```

These checks validate source and policy behavior only. Live provider verification requires a configured Vercel project, a Connect client, an authorized provider installation, and provider-generated webhook traffic.

## Security rules

- Never commit provider tokens, private keys, webhook secrets, connector exports, or local TARX state.
- Keep provider credentials outside model context. The examples use Vercel Connect's credential helpers.
- Public TARX developers should depend on the framework-neutral adapter contract, not Eve sessions, private connector IDs, or TARX runtime internals.
- Treat reads, writes, deletes, and publishing as different effect classes.
- Require explicit human approval for consequential actions.
- Use allowlists for remote tools and scopes.
- Label every integration `source`, `typechecked`, `live-verified`, or `upstream-validated`; do not collapse those states.

See [SECURITY.md](SECURITY.md) and [docs/verification.md](docs/verification.md).

## Relationship to Eve

TARX uses Eve's public package APIs. Eve is an Apache-2.0 project maintained by Vercel. These examples depend on Eve; they do not copy, vendor, or rebrand Eve implementation code. Framework issues and fixes should be contributed to [vercel/eve](https://github.com/vercel/eve).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
