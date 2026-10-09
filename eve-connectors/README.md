# TARX connectors (Email · Slack · SMS) on eve, Mode B (local)

eve and the connectors run on the same machine as the local TARX model. ngrok forwards inbound provider webhooks to it, and the model call is a loopback request to the local OpenAI-compatible runtime. Nothing runs on Vercel. See [`SPEC.md`](SPEC.md) for the spec. Apache-2.0, like the rest of this repo.

```
Resend / Slack / Twilio ──webhook──► https://<NGROK_DOMAIN> ──ngrok──► 127.0.0.1:3000 (eve start)
                                                                         └─► 127.0.0.1:<model port>/v1 (TARX)
```

## Requirements
- Node 24 (`.nvmrc`). eve 0.74 refuses older versions, and the SQLite dedupe store uses the built-in `node:sqlite`.
- ngrok with an authtoken and a **static domain**, so webhook URLs survive restarts.

## Run
```bash
npm ci                                   # .npmrc sets legacy-peer-deps
cp .env.example .env.local && $EDITOR .env.local
set -a; . ./.env.local; set +a
npm run check:model                      # local model answers /v1/models
npm run info                             # expect: ready, 0 errors; routes listed below
npm run build && npm start               # terminal 1  (127.0.0.1:$PORT)
npm run tunnel                           # terminal 2  (ngrok http --url=$NGROK_DOMAIN $PORT)
curl -fsS https://$NGROK_DOMAIN/eve/v1/health
```

| Channel | Webhook URL to paste into the provider | Env |
|---|---|---|
| Email (Resend) | `https://<NGROK_DOMAIN>/connectors/email-resend/inbound`, event `email.received` | `RESEND_API_KEY` (full access), `TARX_EMAIL_FROM`, `RESEND_WEBHOOK_SECRET`, `TARX_EMAIL_ALLOW_FROM`, `TARX_EMAIL_REPLY_TO` + `TARX_EMAIL_INBOUND_DOMAIN` (a receiving-only subdomain whose MX points at Resend; your root MX is untouched) |
| Slack (own app) | `https://<NGROK_DOMAIN>/eve/v1/slack`, used for both Events and Interactivity. One-paste setup: `slack-app-manifest.yaml` | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `TARX_SLACK_ALLOW_USERS` |
| SMS (Twilio) | `https://<NGROK_DOMAIN>/eve/v1/twilio/messages` (Messaging, "A message comes in", HTTP POST) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `TARX_SMS_ALLOW_FROM`, `TWILIO_WEBHOOK_URL` (exactly the URL in that column) |

A channel won't start if its allowlist is empty. Email replies set `Reply-To` to the inbound address you wrote to, so your reply returns to TARX even if the From domain's MX points somewhere else.

**Dedupe:** provider retries are dropped using a durable SQLite file, `TARX_DEDUPE_DB` (default `.data/tarx-dedupe.sqlite`), which survives restarts. Set `TARX_DEDUPE_DB=memory` to turn it off.

**Safety:** the agent runs with `defaultTools: false`, meaning chat only, with no shell or file tools reachable from a text message.

**Optional Vercel mode:** `connectors/slack/connect.ts` plus the optional dependency `@vercel/connect`. It's unused in Mode B.

## Develop
`npm test` (41 tests on Node 24), `npm run typecheck`. To add a connector: `npx tsx scripts/create-connector.ts <id> --provider <p> --verification <kind>`.
