# TARX Connector Framework: SPEC (v0.1, SMS + Slack + Email)

Status: draft (v0.1). This spec describes the code in this folder. It uses placeholders only (example.com, +1555 numbers).

## 1. Goal
"TARX talks to me through those channels. Now."

The owner can message TARX over **SMS, Slack, or email**, and TARX answers on the **same channel and thread**. Requirements:
- the fewest possible hops
- no polling
- a 2xx response to the provider in under 500 ms
- every channel addition is mostly configuration

Non-goals for v0.1:
- multi-user tenancy
- voice
- MMS and attachments (they are dropped, with a note)
- Discord, Telegram, iMessage, and Gmail (later; the same framework applies)

## 2. Architecture
```
Provider (Twilio | Slack | Resend)
  └─ webhook ─► Edge relay: eve app (agent/channels/*.ts)
                  verify signature → allowlist → dedupe → 200 ACK → durable turn
                  └─ model call ─► local TARX runtime (OpenAI-compatible, via authenticated tunnel)
                  ◄─ reply ─ channel delivery (SMS / thread reply / threaded email)
```
- **eve** (vercel/eve, Apache-2.0) is the agent harness. It provides:
  - channel routing
  - durable turns (workflows)
  - continuation tokens, which give one session per thread
  - steer and queue turn policies
  - fail-closed route auth

  We keep eve because it already ships `twilioChannel` and `slackChannel`. `defineChannel` covers Resend.
- **Vercel Connect** is the credential and trigger plane where a managed connector exists:
  - **Slack:** `vercel connect create slack`, then `connectSlackCredentials(uid)`. The trigger verifies Slack's signature, then forwards the event to the deployment with a Vercel OIDC token.
  - **Twilio and Resend:** catalog connectors exist (`vercel connect create twilio|resend`), but **@vercel/connect/eve has no helper** for either. v0.1 uses portable env credentials behind resolver functions so we can swap to `getToken()` later (VERIFY the token shape).
- **Model:** `agent/agent.ts` passes eve an AI SDK `createOpenAICompatible` model pointed at the local TARX runtime (`TARX_MODEL_BASE_URL`). The relay never hosts the model. **VERIFY** that TARX exposes an OpenAI-compatible chat endpoint over the tunnel, and its context length.

### Deployment modes
**Default: Mode B (local).** eve runs on the same host as the model, ngrok carries inbound webhooks only, and the model call is loopback. The Slack app uses its own token and signing secret. Dedupe uses a durable SQLite file (`SqliteIdempotencyStore`, `node:sqlite`, Node 24). Connect is optional (`connectors/slack/connect.ts`). Email sets `Reply-To` to an address on a receiving-only subdomain (`TARX_EMAIL_INBOUND_DOMAIN`) whose MX points at Resend, so the root domain's mailbox provider is untouched.

| Mode | Where eve runs | Inbound path | Slack via Connect? | Notes |
|---|---|---|---|---|
| A: Vercel (optional) | Vercel project (`eve deploy`) | Provider → Vercel URL | Yes (trigger → `/eve/v1/slack`) | Tunnel used only for model calls to local TARX |
| **B: Local (default)** | `eve start` on the model host | Provider → ngrok → local eve | No: portable tokens | Zero Vercel usage; tunnel must carry webhooks |

Both modes run the same code. Slack switches automatically based on `TARX_SLACK_CONNECTOR`.

## 3. Routes (all verified by `eve info`: 0 errors, 0 warnings)
| Channel | Route | Verification | Turn policy | Continuation token |
|---|---|---|---|---|
| SMS | `POST /eve/v1/twilio/messages` | `X-Twilio-Signature` (HMAC-SHA1 over URL + sorted params), in eve | steer | `From:To` (eve) |
| Slack | `POST /eve/v1/slack` | Connect: Vercel OIDC. Portable: Slack v0 HMAC with a 5-minute window. Both in eve | steer | channel and thread (eve) |
| Email | `POST /connectors/email-resend/inbound` | Svix HMAC-SHA256 over `id.timestamp.body` with a 5-minute window (kit `verifySvix`) | queue | `t<sha256(thread-root Message-ID)>`; raw header text is never used as an eve address |

eve also mounts `/eve/v1/session*` and `/eve/v1/twilio/voice*`. The session routes fail closed in production by default. Voice turns get the same allowlist, but we don't advertise voice.

## 4. Connector manifest (`packages/connector-kit/src/manifest.ts`, zod)
`id, version, status (source|typechecked|live-verified), provider, kind: "conversational", auth { outbound: connect|portable|connect-or-portable, connectUid?, scopes[] }, inbound { route, verification: twilio-signature|slack-v0|svix|vercel-oidc|hmac-sha256, dedupeKey, events[] }, outbound { actions[], threading }, rateLimits?, latencyBudgetMs (default 500), allowlist { kind, configKey }, env[]`.

The manifest is used for three things:
- docs
- the launch gate (latency budget, route)
- codegen

## 5. Connector shape
```
connectors/<id>/manifest.ts      declarative facts
connectors/<id>/handlers.ts      pure provider logic (parse, sender check, threading); unit-tested
connectors/<id>/channel.ts       eve channel: built-in wrapper or defineChannel
connectors/<id>/__tests__/       unit tests + gate.test.ts (runConnectorContract)
agent/channels/<id>.ts           one-line wiring: export default <id>Channel({ runtime })
```
Every inbound handler follows the same order:
1. verify the signature on the raw body
2. parse
3. drop non-allowlisted senders with a 2xx, so the provider doesn't retry
4. claim the idempotency key (the provider message ID)
5. send a 200 ACK
6. do the remaining work in `waitUntil` / the durable turn

Outbound replies:
- carry a stable idempotency key, `tarx-${turnId}-${sequence}`
- rethrow on failure so eve's durable step retries

## 6. Shared kit (`packages/connector-kit/src`)
| Module | Purpose |
|---|---|
| `verify.ts` | constant-time compare; Twilio, Slack v0, and Svix sign and verify |
| `retry.ts` | `withRetry`: exponential backoff with full jitter; honors `Retry-After`; retries 429, 5xx, and network errors; one `onUnauthorized` refresh on 401. `ProviderHttpError`, `ensureOk` |
| `rate-limit.ts` | `TokenBucket` for outbound sends |
| `idempotency.ts` | `IdempotencyStore` interface plus an in-memory TTL implementation (**replace with a durable KV before running more than one instance**) |
| `telemetry.ts` | hooks `onAck`, `onTurnLatency`, `onProviderError`, `onRejected`. No-op default; Datadog adapter stub (VERIFY intake API) |
| `alert.ts` | `FailureAlerter`: alerts once after N consecutive failures and re-arms after a success. Logs today; target is a post to an ops channel |
| `runtime.ts` | `ConnectorRuntime` bundle (idempotency, telemetry, alerts, clock), `listFromEnv` |
| `testing/contract.ts` | launch gate (section 7) |

Credentials:
- Credentials are never stored in code. Connect issues short-lived tokens.
- Portable credentials live in env on the host. Revoking them in the provider console revokes access immediately.
- Device-side OAuth storage is out of scope for these three channels: Slack uses Connect, and Twilio and Resend use API keys.

## 7. Launch gate (`runConnectorContract(name, harness)`)
A connector can't move past `source` until the gate passes. It needs a recorded live round trip to reach `live-verified`. Checks:
1. A valid inbound starts exactly one turn, with the ACK under `latencyBudgetMs`.
2. A bad signature gets a 401 and starts no turn.
3. A stale or replayed signature gets a 401.
4. A non-allowlisted sender gets a 2xx and starts no turn.
5. A duplicate provider delivery starts one turn.
6. A malformed payload gets a 4xx and starts no turn.
7. Provider 503 and 429 are retried and the turn still starts.
8. A 401 triggers one credential refresh, then success.
9. Repeated provider failures fire exactly one alert.
10. The reply goes to the same thread with a stable idempotency key.

Coverage:
- **email-resend** implements the full harness: 10/10 passing. The whole suite is 38/38, and `tsc --noEmit` is clean.
- **SMS and Slack** use eve's built-in verification and routing. Their gate is covered by unit tests:
  - the kit's Twilio signer matches eve's `signTwilioRequest`
  - the allowlist
  - MessageSid dedupe
  - compliance keywords
  - the `/new` reset

  A full HTTP harness for them is a follow-up.

## 8. Codegen
`npx tsx scripts/create-connector.ts <id> --provider <p> --verification <kind>` writes:
- manifest
- handlers
- channel
- gate stub
- README
- `agent/channels/<id>.ts`

It refuses to overwrite existing files. New connectors start at `status: "source"`.

## 9. Per-channel details
### 9.1 SMS (Twilio)
- **Code:** eve `twilioChannel` wrapped by `smsTwilioChannel`. It requires a non-empty `TARX_SMS_ALLOW_FROM`, sets turn policy to steer, drops compliance keywords, and dedupes on MessageSid.
- **Env:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TARX_SMS_ALLOW_FROM`, and `TWILIO_WEBHOOK_URL`. The webhook URL must be the exact public URL configured in Twilio, which matters behind ngrok.
- **Twilio console:** set the number's Messaging "A message comes in" webhook to `https://<public>/eve/v1/twilio/messages` (HTTP POST).
- **US A2P:** a US 10DLC number needs A2P registration before carriers deliver application-to-person traffic. A toll-free number needs toll-free verification. Unregistered traffic may be filtered. **This is the slowest blocker of the three.**

### 9.2 Slack
- **Code:** eve `slackChannel` wrapped by `slackConnectorChannel`. It handles DMs and @mentions from allowlisted user IDs only, ignores bots, and supports a `/new` reset.
- **Connect (Mode A):**
  1. `vercel connect create slack`
  2. install it to the TARX workspace
  3. `vercel connect attach slack/<name> --triggers --trigger-path /eve/v1/slack`
  4. set `TARX_SLACK_CONNECTOR=slack/<name>`
- **Portable (Mode B):** a Slack app with scopes `app_mentions:read`, `chat:write`, `im:history`, and events `app_mention` and `message.im` sent to `https://<public>/eve/v1/slack`. Set `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`.
- **Env:** `TARX_SLACK_ALLOW_USERS` (the owner's `U…` member ID).

### 9.3 Email (Resend)
- **Code:** a custom `defineChannel` (Resend has no eve or Connect helper). The handler order is:
  1. Svix verify
  2. accept `email.received` only
  3. dedupe on `email_id`
  4. ACK
  5. fetch the full email (`GET /emails/receiving/{id}`; path verified against the Resend docs on Oct 7. Its `authentication` results are computed by Resend's receiving server, so a sender can't forge them)
  6. require an allowlisted sender, DMARC pass, and SPF or DKIM pass
  7. strip quoted text
  8. start the turn on the thread-root token

  The reply goes out through `POST /emails` with `In-Reply-To`, `References`, `Re:` subject, and an `Idempotency-Key`.
- **Resend setup:**
  - a receiving address: a Resend-managed `<id>.resend.app`, or MX on a subdomain such as `tarx.<domain>`
  - an `email.received` webhook to `https://<public>/connectors/email-resend/inbound`
  - a verified sending domain for `TARX_EMAIL_FROM`
- **Env:** `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` (whsec_…), `TARX_EMAIL_FROM`, `TARX_EMAIL_ALLOW_FROM`.

## 9.4 Hardening applied after code review
- **Email:**
  - no fabricated Message-IDs; a missing ID falls back to a deterministic `resend:<email_id>` root
  - hashed thread token
  - `References` keeps the thread root when truncated
  - new test cases for DMARC-pass with SPF and DKIM failing, and for `gray` verdicts
- **SMS:** the MessageSid claim runs before the compliance-keyword check, and the two rejections get separate telemetry reasons. `YES` passes through to the agent.
- **Slack:**
  - dedupes per `channelId:ts`, which covers Slack redeliveries
  - `onInputResponse` applies the allowlist to HITL button clicks
  - fails fast when neither Connect nor portable credentials are set
- **Kit:**
  - clearer idempotency eviction
  - `Retry-After` accepts HTTP-dates and is capped at `maxMs`
  - programming errors are no longer retried
  - a crashing alert hook can't break the caller

Rejected review points, with reasons:
- **Email reply idempotency key `turnId-sequence` was flagged as unstable.** eve's event data for one emitted message is fixed, so the key is stable; durable KV is still on the list.
- **Twilio signer URL was flagged.** eve does the inbound verification with `webhookUrl`, and the kit signer is only used in tests.
- **`email.ts` was said to throw at import.** It doesn't: the API key is read lazily through a thunk. The channel does fail fast at build if required env is missing, which is intended.
- **Svix key rotation.** Resend uses one secret per endpoint, so rotation support was deferred.

## 10. Security
- Verification happens before parsing.
- Allowlists are required; a connector refuses to start if its allowlist is empty, and `*` is never accepted.
- Email adds sender-authentication checks, because the From header is easy to spoof.
- Message bodies and signature headers are never logged.
- `agent/instructions.md` forbids revealing credentials or hostnames.
- eve's default HTTP session channel fails closed in production.
- Tunnel auth for model calls uses `TARX_MODEL_API_KEY`, from env only.

## 11. Cost notes
- **Running the channels is not strictly $0:**
  - Twilio: number rental plus per-SMS fees
  - Resend: free tier limits apply
  - Vercel Pro: Connect token requests are $3 per 1k and triggers $0.95 per 1k, plus function and workflow usage
  - Mode B avoids Vercel usage

## 12. Open questions / VERIFY list
1. Does the local TARX runtime expose an OpenAI-compatible endpoint over the tunnel? What are its model ID, context length, and auth?
2. ~~Resend received-email path~~ verified on Oct 7. HTML-only bodies (`text: null`) now fall back to HTML-to-text.
3. The `@vercel/connect` `getToken` shape for Twilio and Resend catalog connectors, which have no eve helper.
4. ~~Durable idempotency store~~ done: SQLite (`TARX_DEDUPE_DB`) for a single host. Use a shared store (Redis) if you run more than one instance.
5. The alert target: post to the owner's Slack DM or an ops channel.
6. Twilio "YES" handling versus approvals; whether Twilio double-replies.
7. ~~Mode A versus Mode B~~ resolved: Mode B (local) is the default and Mode A stays optional.
