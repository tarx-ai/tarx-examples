# Public adapter architecture

TARX's public integration boundary is framework-neutral. A developer should not need access to Eve sessions, private connector IDs, internal filesystem paths, or Supercomputer topology.

## Adapter contract

Every adapter implements:

- `manifest` — provider, versioned status, and explicit operation effects.
- `discover(context)` — the tools available to the current principal.
- `invoke(tool, input, context)` — one bounded operation with idempotency and evidence.
- `health(context)` — optional readiness without exposing credentials.

The context exposes only:

- A user or service principal.
- An opaque credential handle.
- An explicit approval receipt when required.
- An idempotency key.
- An evidence sink.
- A cancellation signal.

Raw provider tokens, Eve session objects, connector exports, private filesystem paths, and internal infrastructure are outside the contract.

## Proposed HTTP surface

```text
GET  /v1/integrations
GET  /v1/integrations/{id}/tools
POST /v1/integrations/{id}/tools/{tool}
```

The consuming TARX runtime is responsible for Bearer authentication, tenant authorization, approval receipts, idempotency, redaction, and normalized evidence IDs. An internal bridge may translate this contract to Eve tools, channels, connections, or another runtime.

This repository does not claim those routes are publicly deployed.

## Eve and Vercel Connect

The channel directories in `examples/` are reference configuration against public Eve APIs. They demonstrate how a separate agent project could mount a provider channel.

Vercel Connect is an optional cloud credential broker. It is not an offline capability and is not part of the framework-neutral TARX contract. A consuming project must create and authorize its own connector, request minimum scopes, and record live proof before changing an integration from `typechecked` to `live-verified`.

## Promotion law

Source and typecheck prove code shape. They do not prove installation, authorization, provider delivery, retry behavior, or TARX Computer availability.

An integration becomes `live-verified` only after a real provider installation passes:

1. One defined happy path.
2. One denied, invalid-signature, revoked-token, or unavailable-provider path.
3. Minimum-scope review.
4. Exact source and dependency identity.
5. Redacted evidence with limitations.
