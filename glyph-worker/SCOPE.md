# Glyph worker: highest-value scope (ranked)

**What we learned about `stealth/glyph-cluster`:**
- $0 today, but the provider retains prompts and has no ZDR or no-training guarantee.
- Slow: TTFT is typically 10–150 s and a long answer takes 2–10 min. It runs fine in parallel.
- 256k context.
- **Strong** at review, specs, and structured synthetic data. **Weak** at first-draft code, which always needed rework.

So: point it at public inputs, give it long-running review and data jobs, and keep a stronger reviewer (the TARX agent plus tests) as the gate.

| # | Item | Value | Effort | Profile | Output location (after TARX review) |
|---|---|---|---|---|---|
| 1 | **PR review loop** for every connector PR in public repos | High: catches security/correctness issues before merge | S (exists) | `review --pr` | PR comment posted **by the TARX agent** after triage; raw in `runs/` |
| 2 | **Synthetic conversational-turn eval sets** (SMS / Slack / email, about 200 each) | High: the regression suite for turn quality and connector behavior | M | `dataset` | `eve-connectors/evals/datasets/<channel>.v1.jsonl` |
| 3 | **Edge-case test generation**: turn dataset rows (duplicates, opt-out, threading, retries, out-of-order) into vitest cases | High: converts data into launch-gate coverage | M | `build` (with rows as input) | `eve-connectors/connectors/*/__tests__/generated/*.test.ts` |
| 4 | **Adversarial inbound set**: prompt injection in SMS/email bodies, spoofed senders, oversized payloads, unicode lookalikes | High: security posture for anything that reads user messages | S–M | `dataset` (adversarial kind) | `eve-connectors/evals/adversarial/*.jsonl` |
| 5 | **Next-connector specs plus a critique pass** (e.g. Discord, Telegram, WhatsApp via Twilio, Teams): manifest, routes, verification, threading, rate limits | High: its strongest skill; unblocks the scaffold generator | S | `build` (spec task) + `review` | `eve-connectors/specs/<connector>.md` |
| 6 | **Connector scaffold templates** for those connectors through `create-connector` | Med–High | M | `build` | `eve-connectors/scripts/templates/` |
| 7 | **Public integration-docs digests**: provider docs and changelogs (Twilio, Slack, Resend) into install guides and "VERIFY" diffs against our code | Med–High: keeps setup steps current | M (needs a `docs` profile that fetches public URLs only) | new `docs` | `eve-connectors/docs/providers/*.md` |
| 8 | **Datadog turn-quality tooling** (tooling only, no keys): instrumentation spec, dashboard JSON, monitors for `turn_ms`, `ack_ms`, rejects, provider errors, and glyph-worker `calls.jsonl` | Med | S–M | `build` | `eve-connectors/observability/{dashboard.json,monitors.json,SPEC.md}` |
| 9 | **Public docs QA**: README/SPEC accuracy versus code; flag stale commands | Med | S | `review` (diff or files) | PR suggestions via the TARX agent |
| 10 | **Weekly model battery**: re-run the synthetic battery; alert if price, latency, or quality changes (the price guard aborts on any non-zero price) | Med: protects the $0 assumption | S | `check` + battery | private ops log |
| 11 | **Release notes / changelog** drafts from merged diffs | Low–Med | S | `review` (summary prompt) | `CHANGELOG.md` PRs |

## How a new connector attaches

Read `eve-connectors/ATTACHMENT.md` and `packages/connector-kit/src/attachment.ts` before a spec or a scaffold. A connector is a manifest plus the harness steps (verify, dedupe, allowlist, ack, model, reply) plus the four `tarx.connector.*` metrics. Do not add a UI catalog row. Do not mark a card connected. Status stays `source` until a person live-verifies it.

## Guardrails for every item
- **Inputs:** public repos and paths only (`GLYPH_PUBLIC_PATHS`), synthetic data, public URLs. Never TARX runtime code, private repos, customer data, credentials, hostnames, or anything about private infrastructure.
- **Outputs:** proposals under `runs/` only. The TARX agent runs tests, triages, and commits; a human approves pushes. Glyph never posts, comments, commits, or pushes.
- **Cost:** `check` before sessions; strict spend guard on; any non-zero price or cost aborts.
- **Datasets:** schema-validated, deduped, and boundary-scanned. Rows are labeled synthetic and are never mixed with real conversations.

## Not in scope
First-draft production code merged without rework, anything requiring private context, autonomous agents with write access, and any use if the model stops being $0 or its retention terms change.
