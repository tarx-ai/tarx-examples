# glyph-worker

A guarded worker for **`stealth/glyph-cluster`** on the Vercel AI Gateway. The model is currently listed at $0 and is slow, but strong at review and spec work. The worker has three session profiles:

| Profile | Input | Output (under `runs/<session>/`) |
|---|---|---|
| `build` | task spec plus allowlisted public files | `draft.patch`, `draft.md`, `self-review.md`, `summary.json` (incl. `git apply --check`) |
| `dataset` | channel (`sms`/`slack`/`email`), count | `dataset.jsonl` (schema `tarx.conversation.v1`), `rejects.jsonl`, `report.json` |
| `review` | public PR (`owner/repo#N`) or a local diff | `review.md` (severity-ranked findings), `summary.json` |

Every call writes a line to `runs/<session>/calls.jsonl`: `session, profile, task, ttft_ms, total_ms, tokens_in/out/reasoning/cached, cost, market_cost, status`, plus `ddsource`/`service`/`ddtags` so the file can be tailed straight into Datadog Logs.

**It never commits, pushes, comments, or opens PRs.** It only writes files under `runs/`.

## Guardrails (all fail closed)
1. **Data boundary.** The provider retains prompts (no ZDR, no no-training). Before *any* network call, the full prompt is scanned. The request is blocked if it contains:
   - secret shapes (Resend, Slack, OpenAI-style, GitHub, AWS, Twilio SID, Svix, Vercel, private keys, JWTs, bearer tokens, assigned secrets)
   - private hosts (`*-PRIME`, `*.local`), RFC 1918 IPs, home paths, tunnel hostnames
   - non-allowlisted localhost ports
   - email addresses outside RFC 2606 example domains, phone numbers outside +1-555
   - your own `GLYPH_DENY_TERMS`

   Files are read only if their real path (no symlinks) is inside `GLYPH_PUBLIC_ROOT` and on `GLYPH_PUBLIC_PATHS`. `.env*` (except `.env.example`), `.data`, `.eve`, `node_modules`, and key files are always denied. `runs/` is denied except published `glyph-worker/runs/smoke-*` evidence. Review of a PR is allowed only if the unauthenticated GitHub API reports the repo as **public**. Model *outputs* (patches, dataset rows) are scanned too. Findings name the rule, never the matched text.
2. **$0 price guard**, run before every request:
   - the model must be listed, and every catalog and endpoint price (including tiers) must be exactly `0`
   - in strict mode, the team's AI Gateway `total_used` (`/v1/credits`) must not move during the run
   - any non-zero cost-like field in response headers or stream chunks aborts the run, with no retry
3. **Concurrency and retries.** `GLYPH_CONCURRENCY` (default 4) caps fan-out. Transient 5xx/429/network errors retry with jittered backoff. Guard, auth, and 4xx errors are fatal.

## Setup (Node 24)
```bash
cd glyph-worker
npm ci                      # dev-only deps (typescript, @types/node); runtime has zero deps
cp .env.example .env.local  # set AI_GATEWAY_API_KEY or AI_GATEWAY_API_KEY_FILE; never commit
set -a; . ./.env.local; set +a
npm test && npm run typecheck
node src/cli.ts check       # $0 preflight: prices all 0 + spend baseline (no model call)
```

## Run
```bash
# build: draft a patch (Glyph drafts; a human or the TARX agent decides)
node src/cli.ts build --files eve-connectors/packages/connector-kit/src/telemetry.ts,eve-connectors/packages/connector-kit/src/kit.test.ts \
  --task "Add a vitest file for datadogTelemetry using an injected fetchImpl ..."

# dataset: 20 synthetic multi-turn SMS conversations (validated, deduped, boundary-scanned)
node src/cli.ts dataset --channel sms --n 20 --batch 5

# review: a public PR (lockfiles excluded by default) or a local diff on allowlisted paths
node src/cli.ts review --pr tarx-ai/tarx-examples#4
git diff main... -- eve-connectors | node src/cli.ts review

# guard: scan files locally before you hand them to any model
node src/cli.ts guard eve-connectors/README.md
```

## Review flow: Glyph proposes, TARX disposes
```
 task spec ──► glyph build ──► draft.patch + self-review.md
                                   │
                                   ▼
               glyph review (second pass, fresh context) ──► review.md
                                   │
                                   ▼
        TARX agent review (final): apply in a scratch branch, run npm test / typecheck / eve info,
        reject anything unverifiable, fix or discard findings
                                   │
                                   ▼
        human approves ──► TARX agent commits and pushes (never Glyph) ──► PR ──► glyph review --pr (optional)
```
- Glyph output is a **proposal**. Its first-draft code has needed rework in testing; its reviews were the most useful output.
- The TARX agent is the final reviewer: it applies patches only after `git apply --check`, runs the package's tests, and owns the commit.
- Dataset rows are synthetic and go through schema validation, dedupe, and the boundary scan before anyone uses them.

See [`SCOPE.md`](SCOPE.md) for the ranked backlog and [`schemas/conversation.v1.json`](schemas/conversation.v1.json) for the dataset schema. `samples/` holds a synthetic sample produced by the smoke test.

## Sovereign mode (own compute, e.g. compute.tarx.com)

Point glyph at your own OpenAI-compatible endpoint and disable the marketplace
price guard (there is no external price to verify on your own metal):

```
GLYPH_BASE_URL=https://compute.tarx.com/v1
GLYPH_MODEL=tarx/t-supercomputer
AI_GATEWAY_API_KEY_FILE=~/.config/tarx-connectors/compute-gateway.key
GLYPH_SPEND_GUARD=off   # off = skip the $0 catalog price check (sovereign)
```

With `GLYPH_SPEND_GUARD=off` the price guard is fully bypassed. Keep it `strict`
(the default) on an external marketplace to enforce the $0 assumption.
