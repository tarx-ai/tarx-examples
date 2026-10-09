# How a connection attaches

Every connection uses this path. Email, Slack, and SMS are the first three. The next one does not get a new card or a new metric.

Glyph may add a connector only by scaffolding a `ConnectorManifest` and the harness steps below. Glyph does not add a row to a UI catalog. The thread card and Channel Settings render `uiPhase()` from `packages/connector-kit/src/attachment.ts`.

## Harness

Order is fixed. A reject returns before the model runs.

1. Verify the inbound signature (`inbound.verification`).
2. Dedupe on `inbound.dedupeKey`.
3. Allowlist. The sender must match `allowlist`.
4. Ack the webhook. Emit `tarx.connector.ack_ms` with tag `connector:<id>`.
5. The model runs one turn. It sees the manifest id, the channel, and the allowed outbound actions. It does not see the token.
6. Reply on the provider. Emit `tarx.connector.turn_ms` with the same tag.

Rejects emit `tarx.connector.rejected` with `reason:` set to `signature`, `malformed`, `duplicate`, `allowlist`, `allowlist-hitl`, `compliance-keyword`, or `auth`. An outbound failure emits `tarx.connector.provider_error`. No message body and no sender id in the tags. The adapter is `ConnectorTelemetry` in `telemetry.ts`. The UI does not emit these.

## What the person sees

One card. The mark comes from the shapes lab. The button label comes from the phase.

| Phase | Button | When |
| --- | --- | --- |
| off | Not live yet | Manifest `status` is `source`. |
| needs-private-channel | Make private | Device connector on a public channel. |
| needs-account | Sign in | Channel is private, no TARX account. |
| needs-provider | Connect | Account exists. Eve holds the token. This tab does not. |
| on | On | `live-verified` and the provider token is ready. |
| error | Try again | The last outbound call failed. |

`vercel-oidc` is the only verification that can run on the public canvas. Everything else is a device connector and requires a private channel. A shared link is the recipe, not the live session.

## What Glyph writes

A public spec, then a scaffold: manifest, route, verification, dedupe, allowlist, rate limit, and tests for each reject reason. Status stays `source` until a person live-verifies it. Do not invent a provider, a host, or a secret. Do not mark a card connected.
