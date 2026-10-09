<!-- chunk 1/16 -->
## Summary

This is a well-structured connector kit + eve app. The verification order, allowlists, Svix/Twilio/Slack checks, and the launch-gate idea are solid. However, a few concrete security/correctness issues need fixing before promotion: an unvalidated `modelContextWindowTokens` (can become `NaN`/0), the Slack `/new` path being blocked by the `ts`-based dedupe claim, the SQLite idempotency `changes` type being treated as `number` (can be `bigint` in Node 24), and `Retry-After`/clock-skew edge cases around the "past date -> drop" rule. The email hardening matches the spec. Address the high items below and this can move forward.

## Findings

1. **[high] eve-connectors/agent/agent.ts:23**  
   `modelContextWindowTokens: Number(process.env.TARX_MODEL_CONTEXT_TOKENS ?? 32768)`  
   Why: `Number("abc")` -> `NaN`. `NaN` passed to `defineAgent` can propagate to scheduling/compaction. Also `0` is not a sensible window.  
   Fix: parse int, reject `<1`, clamp to a sane max, and throw on invalid (fail closed). Example:
   ```ts
   const ctx = Number(process.env.TARX_MODEL_CONTEXT_TOKENS ?? 32768);
   if (!Number.isFinite(ctx) || !Number.isInteger(ctx) || ctx < 1024) throw new Error("TARX_MODEL_CONTEXT_TOKENS must be integer >=1024");
   modelContextWindowTokens: Math.min(ctx, 200000),
   ```

2. **[high] eve-connectors/connectors/slack/handlers.ts:15-27**  
   `if (!(await rt.idempotency.claim(\`slack:${message.channelId}:${message.ts}\`))) { rt.telemetry.onRejected("slack","duplicate"); return null; }` runs before `/new` handling.  
   Why: Slack can redeliver the same `ts`. If a redelivery arrives after you already `ctx.reset()` for `/new`, claiming first forces `duplicate` and you never re-run the reset or post the confirmation. Also if the session was cleared between attempts, you still want to treat the command idempotently but execute the side effect once.  
   Fix: detect `/new` from the raw text *before* claiming, or claim a command-scoped key (`slack:${channelId}:${ts}:cmd:new`) for the `/new` action and a separate key for starting a turn. Alternatively: check for `/new`/`"new"` first, then `claim` only when you will actually `return { auth: ... }` (i.e. start a turn). Keep the duplicate rejection for turn-starts, not for "reset-only" acknowledgements.

3. **[high] eve-connectors/packages/connector-kit/src/sqlite-idempotency.ts:39-46**  
   `return Number(this.claimStmt.run(key, t + ttlMs, t).changes) === 1;`  
   Why: `node:sqlite`'s `Statement.run` returns `{ changes: number | bigint }` (Node 24). `Number(bigint)` is fine for small values but relying on `=== 1` against a `bigint` can be surprising if ever widened; also the comparison should be type-safe. More directly: treat `changes` as integer count.  
   Fix: coerce via `BigInt` or `Number.parseInt` safely:  
   ```ts
   const ch = this.claimStmt.run(key, t + ttlMs, t).changes;
   const n = typeof ch === "bigint" ? Number(ch) : ch;
   return n === 1;
   ```  
   Also consider logging `PRAGMA optimize;` periodically or not required now, but the type is a correctness detail.

4. **[med] eve-connectors/packages/connector-kit/src/retry.ts:50-60**  
   `parseRetryAfter` treats a past HTTP-date as `undefined` and falls back to exponential backoff (comment matches). Good. However `Math.ceil((d - now)/1000)` can produce `0` only in the exact boundary? `sec>0` guards it. Also `retryAfterSec` from `ProviderHttpError` is trusted but `ensureOk` only parses seconds; a large `retryAfterSec` from a misbehaving provider is later multiplied by 1000 and `Math.min(..., max)` caps at `maxMs` (seen in tests) but the delay passed to `sleep` uses that cap – correct.  
   Fix: explicitly cap `ra` before `ra*1000` (e.g. `const raMs = Math.min((ra||0)*1000, max)`) and never let a provider force > `maxMs`. Also reject `ra <= 0` by treating as `undefined`.

5. **[med] eve-connectors/packages/connector-kit/src/retry.ts:30-38**  
   `if (status === 401 && !refreshed && o.onUnauthorized) { refreshed = true; await o.onUnauthorized(); continue; }`  
   Why: a single 401 refresh is correct for rotating tokens. But if `onUnauthorized()` throws, the exception propagates out and the call is not retried with the new token – likely intended (refresh failed). Consider catching and rethrowing `ProviderHttpError(401,...)` with context or just document. Also "one refresh per attempt chain" is fine.  
   Fix: wrap `await o.onUnauthorized()` in `try/catch` and emit via a logger hook (or rethrow as `ProviderHttpError(401, undefined, "token refresh failed")`) so `withRetry` doesn't leak an arbitrary exception type without status.

6. **[med] eve-connectors/packages/connector-kit/src/idempotency.ts:13-21**  
   Eviction loop: when `maxEntries` reached, first loop deletes expired by iterating `this.seen` (Map iteration order = insertion). Second loop deletes from the "oldest insertions" forward until `< maxEntries`.  
   Why: correct enough for in-memory. If many keys expire at once, first pass helps. However deleting while iterating the same Map keys by `for (const k of this.seen.keys())` is safe in modern JS but mutating during enumeration is fine here. Also `claim` overwrites `exp` on "take over expired row" path (SQLite) but memory path doesn't update insertion index on refresh – acceptable for "claim once".  
   Fix: when evicting to make space, prefer evicting entries with smallest `exp` (closest to expiry) or track `lastSeen`? Not critical for v0.1; add a brief comment that "oldest inserted keys are evicted first".

7. **[med] eve-connectors/connectors/sms-twilio/handlers.ts:12-30**  
   Compliance keywords: `COMPLIANCE_KEYWORDS` includes `"start","unstop","help","info"`.  
   Why: Twilio's default STOP/START handling differs by number/A2P. Silently dropping `HELP/INFO` means the agent never answers "help" even if the owner expects it. Also `START/UNSTOP` are opt-in verbs – dropping them prevents any TARX response to a re-opt-in. The comment says "YES" not dropped but others are.  
   Fix: don't drop `start`/`unstop`/`help`/`info`. Only drop true opt-out verbs that Twilio itself may auto-reply to (`stop`,`stopall`,`unsubscribe`,`cancel`,`end`,`quit`). Keep `start`,`unstop` for the owner to re-enable conversation. Update the comment + tests accordingly.

8. **[med] eve-connectors/connectors/slack/handlers.ts:32-39**  
   `makeSlackInputResponse`: checks `allowUsers.includes(submission.user.id)` but returns `ctx.defaultAuth` without verifying `defaultAuth` exists/non-null.  
   Why: if `ctx.defaultAuth` is `undefined` (unusual in eve HITL) you may leak `undefined` to the turn resumption path.  
   Fix: guard `if (!ctx.defaultAuth) return null;` before returning `{ auth: ctx.defaultAuth }`.

9. **[low] eve-connectors/connectors/email-resend/handlers.ts:73-83**  
   `htmlToText`: regex to strip `<div class="gmail_quote">...` is a coarse heuristic. Also `&amp;` decoded after removing tags but order ok.  
   Why: quoted HTML from other clients (Outlook `div id="divRplyFwdMsg"`, `blockquote`) can leak into `bodyText`. The existing `stripQuotedReply` runs after HTML->text on `>` lines – helps.  
   Fix: also strip `blockquote` blocks and common `#divRplyFwdMsg` containers before `<br>` conversion, or run a second pass: drop lines after `-----Original Message-----` already handled, and also after `Forwarded message:`? Not blocking.

10. **[low] eve-connectors/packages/connector-kit/src/testing/contract.ts:64-75**  
   "alerts after repeated provider failures": loops `for (const _ of [1,2,3]) await h.invoke(new Request(h.request("valid")));` but `failProvider(503,100)` means the first few invokes will hit failures. The harness must actually surface `alerts()` as the count from `FailureAlerter`. Also `new Request(h.request("valid"))` creates a new Request from an existing Request body? `Request` can be reused only once in some cases but `h.invoke` likely reads `.text()`/JSON – fine if harness doesn't consume body twice.  
   Fix: ensure harness uses a fresh body per invoke (the `email-resend` gate does by building new Request). If `request("valid")` returns same Request instance, the second read could be empty – make it explicit: `const r = h.request("valid"); await h.invoke(r.clone?.() ?? r)`.

## Verdict: REQUEST_CHANGES

```json
{"verdict":"REQUEST_CHANGES","high":3,"med":5,"low":2}
```

---

<!-- chunk 2/16 -->
## Summary
This PR adds the guarded glyph-worker scaffold (scope + package manifest) and a large set of synthetic smoke-run artifacts. The guardrails in `SCOPE.md` are strong (public-only inputs, runs/ outputs, $0 spend abort), and the synthetic datasets exercise important edge cases (opt-out, duplicates, allowlists, out-of-order, media-only). However there are two security/correctness gaps: the cost guard is stated but not enforced as fail-closed against null/ambiguous cost values, and the error log in the email smoke run truncates provider metadata in a way that can leak internal routing details. Tighten those before treating this as approved.

## Findings
1. [high] glyph-worker/SCOPE.md:23-28 — **Spend guard is "abort on any non-zero price or cost" but not fail-closed on missing/null cost.**  
   Why: `calls.jsonl` shows `cost:0, market_cost:0` on ok calls and `cost:null, market_cost:null` on the 408 error (runs/smoke-eval-email/calls.jsonl:34). If the provider omits cost or returns null/undefined (transient billing state), the stated guard must treat that as an abort, not as "ok". Otherwise a billing change could be logged as $0.  
   Fix: enforce pre-call and post-call checks: treat `cost == null` or `market_cost == null` as a policy violation → status `policy_violation` (or `aborted`), do not write outputs that depend on that call, and abort the session. Also require numeric >= 0 and fail closed. Example: `if (cost == null || market_cost == null || cost !== 0 || market_cost !== 0) { abort("non-zero-or-missing-cost"); }`

2. [high] glyph-worker/runs/smoke-eval-email/calls.jsonl:34 — **Provider metadata partially logged (routing fragment) on error.**  
   Why: `providerMetadata.gateway.routing...` is truncated mid-string (`"finalProvider\":"}`) in the `error` JSON. Logging even partial routing/provider identifiers is unnecessary and can leak internal deployment/routing details. The worker states it must not log private infrastructure or provider internals beyond what’s required for audit.  
   Fix: redact `providerMetadata` to minimal, non-sensitive fields (e.g. `{ "type":"provider_error" }`) before writing `calls.jsonl`. Never log `routing`, `originalModelId`, `resolvedProvider`, `canonicalSlug`, or `finalProvider`. Also avoid embedding full provider error bodies; log `http_status`, `error.type`, and a short redaction-safe message.

3. [med] glyph-worker/SCOPE.md:18 — **Docs profile fetches public URLs only but SSRF/redirects not specified.**  
   Why: “needs a `docs` profile that fetches public URLs only” lacks concrete controls. Without scheme/domain allowlist, private IP/metadata egress (0.0.0.0, ::1, 169.254.169.254, link-local, RFC1918) or open redirects can be abused.  
   Fix: constrain to `https` only, maintain an explicit domain allowlist, resolve DNS and block private/loopback/metadata IPs, deny redirects to non-allowlisted hosts, enforce max body size, request timeout, and User-Agent. Document this in guardrails.

4. [med] glyph-worker/package.json:8 — **`bin` points to TypeScript source (`./src/cli.ts`).**  
   Why: In ESM Node, running `node ./src/cli.ts` requires a TS loader (tsx/ts-node/register) or precompilation. Engines are Node >=24<25 but no `prepare/build` script or loader declared. This can break `npx glyph-worker`/global install in environments without a loader.  
   Fix: point `bin` to built JS (e.g. `./dist/cli.js`), add a `build` script and `files: ["dist"]`, and either compile before publish or clearly require a loader in dev. If meant to run via tsx in repo, document that explicitly.

5. [low] glyph-worker/runs/smoke-dataset-sms/dataset.jsonl:2-3 — **Self-referential `duplicate_of` on system_event.**  
   Why: The duplicate webhook event sets `duplicate_of` to the same `provider_message_id` (e.g. `SM2db7e80f542a41b09c964a2ac5d70f13`). This is harmless for a synthetic example but can confuse deduplication logic and schema validators expecting it to reference the original delivery or a different event id.  
   Fix: Set `duplicate_of` only when it references a different delivery/id, or omit that field for a self-described duplicate event. If the intent is “this is a duplicate delivery of message X,” reference the original delivery id (or leave null/absent) to avoid a self-cycle.

## Verdict: REQUEST_CHANGES

```json
{"verdict":"REQUEST_CHANGES","high":2,"med":2,"low":1}
```

---

<!-- chunk 3/16 -->
## Summary (2-4 sentences)
This dataset PR adds a large smoke-eval JSONL for the email channel. While comprehensive across edge cases, there are multiple correctness/security issues in the test fixtures themselves: several scenarios encode assistant replies that contradict the stated `expected` (notably `reply_count:0` cases where assistant turns are present), inconsistent `duplicate_of` semantics across duplicate-delivery events, and missing/ambiguous schema fields on `system_event` turns that can prevent the harness from asserting idempotency, allowlist enforcement, and replay windows correctly. These issues undermine the security/correctness assertions the suite claims to test and should be corrected before merge.

## Findings
1. [high] glyph-worker/runs/smoke-eval-email/dataset.jsonl:7-10 (scenario `email-95139004c5`, non_allowlisted_sender): problem. The conversation includes a `system_event` (inbound rejected) followed by an `assistant` turn that states the connector blocked the message and did not dispatch a reply, while `expected.reply_count: 0` and `must_not: ["auto_reply_unknown_sender"]`. Having an assistant turn present makes the fixture assert a reply exists even though the expectation forbids it. Fix: Remove the `assistant` turn from this scenario (or set `reply_count: 1` and adjust `must_not`) so the recorded turns match `expected.reply_count: 0` and the test actually verifies no auto-reply was produced.

2. [high] glyph-worker/runs/smoke-eval-email/dataset.jsonl:45-49 (scenario `email-e8a2408a58`, non_allowlisted_sender): problem. `system_event` records sender not allowlisted but no `provider_message_id` or `thread` is attached to that event; immediately after, a `user` turn from `sender:"unknown"` appears with `provider_message_id:"msg_e005"`, `thread:"<nallow001@example.com>"`. This split makes it ambiguous whether the rejection is associated with that message id and prevents the harness from asserting allowlist enforcement (and rate/abuse logging) against the correct inbound id. Fix: Attach `provider_message_id:"msg_e005"` and `thread:"<nallow001@example.com>"` to the `system_event` (and include `duplicate_of` only if applicable) so the event is keyed to the rejected message.

3. [high] glyph-worker/runs/smoke-eval-email/dataset.jsonl:28-35 (scenario `email-9fd1337a98`, provider_error_retry): problem. The retry `system_event` (t_offset_s:6) lacks `provider_message_id` and does not reference which outbound message id failed. The retried assistant turn uses `provider_message_id:"<remcheck2r@example.com>"` (different id) but the event does not state `retry_of`/target. This prevents verification of exactly-once retry semantics and can mask double-send. Fix: Add `provider_message_id_target:"<remcheck2@example.com>"` (or `retry_of:"<remcheck2@example.com>"`) to the `system_event` and ensure the harness expects the retried turn to reuse/replace that delivery id per the connector’s retry policy.

4. [high] glyph-worker/runs/smoke-eval-email/dataset.jsonl:40-47 (scenario `email-0d91e74b7b`, duplicate_delivery): problem. The `system_event` marks `duplicate_of:"<dup1@example.com>"` but sets `thread:"<dup1@example.com>"` and omits the inbound `provider_message_id` of the delivered duplicate payload. The duplicate is the same message id – the event must identify the delivered message id explicitly to assert idempotency against the correct record. Fix: Include `provider_message_id:"<dup1@example.com>"` on the `system_event` (and keep `duplicate_of` the original id) so the test verifies the duplicate webhook was ignored by message id.

5. [med] glyph-worker/runs/smoke-eval-email/dataset.jsonl:32-39 and many others (duplicate_delivery cases): problem. Across multiple scenarios (e.g. `email-ff0cfccb1a`, `email-a5d601e424`, `email-c9bd11313e`, `email-6999e8322f`, `email-37ad54c082`, `email-21cf8ea1f4`, etc.) `system_event` entries use `duplicate_of` equal to the same `provider_message_id` and sometimes omit the event’s own `provider_message_id`. This conflates “duplicate delivery of this message id” with a missing source id and makes replay-window assertions ambiguous. Fix: For each duplicate webhook, set `provider_message_id` to the delivered duplicate id and `duplicate_of` to the original/stored message id (or the message id that was first processed). If identical, state `duplicate_of` explicitly and include `reason:"exact_duplicate_payload"` to avoid schema ambiguity.

6. [med] glyph-worker/runs/smoke-eval-email/dataset.jsonl:99-106 (scenario `email-b2ac6ee43b`, threading/long_context): problem. The assistant reply `msg_e004` uses `In-Reply-To:"<thread001@example.com>"` but the user turn it replies to is `msg_e003` (`provider_message_id:"msg_e003"`). Using the thread root in `In-Reply-To` breaks proper message-level threading and can cause the harness to misorder turns in out-of-order tests. Fix: Set `In-Reply-To:"msg_e003"` (and keep `References` including `<thread001@example.com>` and `msg_e003`) to match the actual parent message id.

7. [med] glyph-worker/runs/smoke-eval-email/dataset.jsonl:132-139 (scenario `email-d48f860774`, rapid_fire): problem. The three assistant replies are each addressed to a different parent question (`qb001`, `qb002`, `qb003`) with correct `In-Reply-To`/`References`, which matches `expected.reply_count: 3`. However, many other rapid_fire scenarios in this file expect `reply_count: 1` and batch answers into a single reply. The suite must be consistent about whether the agent is expected to batch or to answer per turn. Fix: Add an explicit `batching_expected: true|false` to `expected` for rapid_fire scenarios (or split into two scenario types) so tests don’t silently rely on harness default and to prevent false positives between scenarios.

8. [med] glyph-worker/runs/smoke-eval-email/dataset.jsonl:173-183 (scenario `email-723aae6219`): problem. The conversation contains two `assistant` turns with different `provider_message_id`s (`<wgr002@example.com>`, `<wgr003@example.com>`) and `expected.reply_count: 2`. The second assistant turn is a follow-up note (“also noted coupons…”) sent shortly after the first. The expectation states “Set a timely weekend reminder…” but doesn’t constrain whether the follow-up is allowed. To prevent tests from accepting unintended assistant chatter, add `must_not` (e.g. `["extra_unprompted_notes"]`) or clarify `agent_should` to state whether the coupon note is expected. Fix: Tighten `expected` to explicitly include/exclude the second assistant turn (update `agent_should` to describe both replies or adjust `reply_count`) so the test asserts intended behavior.

9. [low] glyph-worker/runs/smoke-eval-email/dataset.jsonl:5-20 (scenario `email-a74c11b7ee`, duplicate_delivery): problem. The duplicate `system_event` includes `duplicate_of:"<dup001@example.com>"` equal to the inbound `provider_message_id` and the event itself lacks `provider_message_id`. The fixture states “duplicate webhook delivery of email: an identical Message-ID was received again.” but doesn’t identify the delivered event id. Fix: Add `provider_message_id:"<dup001@example.com>"` to the `system_event` to make the idempotency assertion unambiguous.

10. [low] glyph-worker/runs/smoke-eval-email/dataset.jsonl:140-148 (scenario `email-73a1e1d98c`, out_of_order): problem. The `system_event` describes reordering but has `provider_message_id:"<sysbs001@example.com>"` and no reference to the message ids being reordered (e.g. bs001–bs003). The harness cannot verify that reordering used `Date`/`References`. Fix: Add `reordered_message_ids:["<bs001@example.com>","<bs002@example.com>","<bs003@example.com>"]` and `ordered_by:["References","Date"]` to the `system_event` to make the correctness assertion explicit.

## Verdict: REQUEST_CHANGES

```json
{"verdict":"REQUEST_CHANGES","high":5,"med":5,"low":2}
```

---

<!-- chunk 4/16 -->
## Summary (2-4 sentences)

This PR adds eighteen raw JSONL conversation fixtures under `glyph-worker/runs/smoke-eval-email/raw/` to exercise edge cases for the email smoke eval (e.g., `duplicate_delivery`, `out_of_order`, `non_allowlisted_sender`, `approval_prompt`, `provider_error_retry`, `media_only`, `ambiguous_request`, `long_context`, `rapid_fire`, `threading`, and `unicode_emoji`). The fixtures are useful for correctness and idempotency coverage, but there are a few concrete data-integrity issues (a duplicated JSON key that makes one line non-parseable as written, ambiguous `duplicate_of` semantics that can break replay/dedup logic, and an expectation/reply mismatch for a "non-allowlisted sender" case) that should be corrected before merging. There is also minor PII in sample values that is better to neutralize for a public repo.

## Findings

1. [high] glyph-worker/runs/smoke-eval-email/raw/batch-11.md:5 — JSON object has the key `provider_message_id` duplicated in the same turn (`"provider_message_id":"<b15-c01-m03@example.com>","provider_message_id":"<b15-c01-m03@example.com>"`).  
   Why it matters: duplicate keys in JSON are undefined/overwritten by many parsers and create non-deterministic ingestion or a hard parse failure for strict validators.  
   Fix: remove the duplicate key so the user turn has a single `provider_message_id`.

2. [high] glyph-worker/runs/smoke-eval-email/raw/batch-1.md:1 — Non-allowlisted sender fixture states the connector blocked the message and logs an event, but the conversation includes an `assistant` reply ("The connector blocked an unrecognized message and did not dispatch a reply.") while `expected.reply_count` is `0` and `must_not` is `["auto_reply_unknown_sender"]`.  
   Why it matters: this is a direct contradiction between the recorded reply and the expected behavior. An eval harness that asserts `reply_count==0` will fail, or one that trusts the transcript may incorrectly count/allow an auto-reply to an unknown sender (a security policy signal).  
   Fix: either (a) remove the assistant turn entirely from this blocked case and only keep `system_event` (reflecting "no reply dispatched"), or (b) change `expected.reply_count` to `1` and update `must_not`/description to match. Given `must_not: ["auto_reply_unknown_sender"]`, the correct transcript is system_event only (reply_count 0).

3. [high] glyph-worker/runs/smoke-eval-email/raw/batch-10.md:66, batch-13.md:66, batch-14.md:66, batch-15.md:66, batch-16.md:66, batch-17.md:66, batch-18.md:66 (representative) — `duplicate_of` is set equal to the same `provider_message_id` (e.g. `"<dd-1@example.com>"` → `duplicate_of":"<dd-1@example.com>"`, `"<batch14-c-root@example.com>"` → same, etc.).  
   Why it matters: deduplication/replay must distinguish the original message delivery from a duplicate webhook/delivery attempt. Using the same ID as both the current message and its "duplicate_of" origin is ambiguous (can create a self-reference, prevent correct windowing, or be misread as a replay loop) and weakens idempotency guarantees.  
   Fix: represent the original delivery with a stable key (e.g. `original_provider_message_id` or `original_delivery_id`) and set `duplicate_of` to that original key, or include a separate `delivery_id` and require `duplicate_of != provider_message_id`. Update the fixture schema notes to that semantic and adjust those system_event entries accordingly.

4. [med] glyph-worker/runs/smoke-eval-email/raw/batch-10.md:1,7 and scattered across batches — Sample PII includes multiple E.164-like phone numbers (e.g. `+15551234001`, `+15551234002`, `+15551234003`, `+15551234004`, `+15551234005`, `+15551234006`).  
   Why it matters: Public eval fixtures should avoid realistic personal contact numbers (even examples) to reduce noise and accidental reuse; prefer neutral example values.  
   Fix: replace with reserved/example-safe placeholders (e.g. `+15555550100` or `tel:

---

<!-- chunk 5/16 -->
## Summary
The PR adds six raw smoke-eval email fixture files (batches 19–26) containing JSONL conversation traces. The fixtures are evaluation test data only (all addresses use `example.com`), contain no secrets, and correctly exercise security/correctness scenarios (non-allowlisted sender blocking, explicit approval prompts, duplicate delivery handling, out-of-order delivery, provider retries, and threading). No concrete security, correctness, or API-misuse issues were identified in these artifacts.

## Findings
None.

## Verdict: APPROVE

```json
{"verdict":"APPROVE","high":0,"med":0,"low":0}
```

---

<!-- chunk 6/16 -->
## Summary (2-4 sentences)

The added smoke-eval JSONL artifacts are synthetic and contain no embedded secrets or direct injection payloads. However, multiple batches incorrectly label assistant messages with `sender:"owner"`, which directly undermines the allowlist, sender verification, and actor-based assertions these tests are meant to validate. These identity mislabels must be corrected before the fixtures can be trusted as ground truth for a security/correctness evaluation. 

## Findings

1. [high] glyph-worker/runs/smoke-eval-email/raw/batch-28.md:3: The assistant turn at `t_offset_s=4` sets `"sender":"owner"`. Why it matters: this flips the actor identity (assistant output is marked as the owner), which will break allowlist enforcement and any test asserting message provenance. Fix: remove the `sender` field for all `role:"assistant"` messages, or explicitly set `"sender":"assistant"`. 

2. [high] glyph-worker/runs/smoke-eval-email/raw/batch-28.md:3: The assistant turn at `t_offset_s=9` sets `"sender":"owner"`. Why it matters: same provenance corruption as #1, allowing tests to conflate inbound and outbound messages. Fix: omit `sender` for this assistant turn. 

3. [high] glyph-worker/runs/smoke-eval-email/raw/batch-28.md:3: The assistant turn at `t_offset_s=19` sets `"sender":"owner"`. Why it matters: propagates an incorrect sender to downstream dedup/threading checks. Fix: remove the `sender` property. 

4. [med] glyph-worker/runs/smoke-eval-email/raw/batch-31.md:3: The first assistant reply (`t_offset_s=3`, `provider_message_id":"<rf-a1@example.com>"`) includes `"sender":"owner"`. Why it matters: corrupts the actor for threading/allowlist assertions under the "rapid_fire" scenario. Fix: delete `sender` from assistant messages. 

5. [med] glyph-worker/runs/smoke-eval-email/raw/batch-33.md:3: The assistant reply at `t_offset_s=5` includes `"sender":"owner"`. Why it matters: mislabels the responder, weakening the test's coverage of outbound message identity. Fix: remove `sender`. 

6. [med] glyph-worker/runs/smoke-eval-email/raw/batch-33.md:3: The assistant reply at `t_offset_s=30` includes `"sender":"owner"`. Why it matters: same identity inconsistency for the confirmation turn. Fix: remove `sender`.

## Verdict: REQUEST_CHANGES

```json
{"verdict":"REQUEST_CHANGES","high":3,"med":3,"low":0}
```

---

<!-- chunk 7/16 -->
## Summary (2-4 sentences)

This PR adds seven public smoke-eval email batches (batch-4,5,34–39) as raw JSONL fixtures. The corpus is useful for ordering/idempotency and allowlist cases, but several security/correctness issues stand out: (1) inconsistent allowlist quarantine expectations between batches (reply vs no-reply to unknown senders), (2) ambiguous deduplication keys (duplicate_of often equals provider_message_id with no delivery/webhook ID), and (3) nontrivial PII and a payment authorization example committed to a public raw artifacts path. These can mask enforcement bugs and violate safe test-data policy; the batches should be hardened before merge.

## Findings

1. [high] glyph-worker/runs/smoke-eval-email/raw/batch-4.md:1-60 (non_allowlisted_sender): problem. Expected behavior conflicts with batch-37: batch-4 has reply_count=1 and the assistant replies to the unknown sender ("advise the sender to have an owner contact the agent"), while batch-37 has reply_count=0 and states "No response sent. The sender is not allowlisted, so the request was not actioned." and must_not ["auto_reply_to_unknown_sender","disclose_internal_details"]. Why it matters: quarantine policy must be unambiguous (security boundary). Replying to an untrusted sender can be abused (backscatter, enumeration) and the "must_not disclose any access codes" claim is hard to enforce if any outbound to that sender exists. Fix: standardize on a single allowlist policy for these fixtures (prefer no outbound reply to non-allowlisted senders; log quarantine only), make expected.reply_count consistent, and move any polite guidance to an internal audit event (not sent to the unknown address). Also update batch-4's expected.agent_should and must_not accordingly.

2. [high] glyph-worker/runs/smoke-eval-email/raw/batch-39.md:1-70 and batch-4.md:35: problem. Public raw eval fixtures contain sensitive/identifying test values (phone numbers +1555-9001, +1555-9012, +1555-9023, +1555-9045, +1555-9056; account ending 1234; recipient example-supplies@example.com; and a request about an "access code to a shared folder"). Why it matters: committed to a PUBLIC PR in raw artifacts, increases PII/test-secrets surface and normalizes a payment action example in fixtures. Fix: replace with RFC 2606/.test domains, neutral placeholders (e.g., +1555-0000 or omitted), redact last4 to ****1234 or remove, use recipient@example.com/payee@example.com, and remove or fictionalize the access-code reference. Enforce a "no live PII/secrets in eval raw JSONL" rule in test data generation.

3. [med] glyph-worker/runs/smoke-eval-email/raw/batch-34.md:44, batch-36.md:21, batch-39.md:32: problem. Duplicate delivery events set duplicate_of equal to provider_message_id (self-referential). Why it matters: deduplication/idempotency becomes ambiguous (cannot distinguish "previous delivery event ID" vs "original message ID") and can mask race conditions between webhook processing and event replay. Fix: use a composite, non-self-referential key (e.g., delivery_id/webhook_id + provider + provider_message_id) in system_event, and change fixtures so duplicate_of references the canonical processed delivery (or original event_id), not the same value. Also assert the dedupe window and that the second inbound is ignored before any new assistant action.

4. [med] glyph-worker/runs/smoke-eval-email/raw/batch-35.md:6-26, batch-38.md:25-31, batch-5.md:35-45: problem. out_of_order system_event contradicts t_offset_s chronology (e.g., assistant/user at 0,65 but system_event at t_offset_s=12 claiming re-indexing/reorder). Why it matters: conflates wall-clock time with logical processing order and can make "must_not drop_queued_message/resend_full_thread" untestable or encourage time-based rather than thread-order (References/In-Reply-To/Message-ID) sorting. Fix: represent ordering explicitly (e.g., logical_order/index or received_at vs processed_at) instead of relying on backwards t_offset_s, or set system_event.t_offset_s >= the effective arrival of the late message and document that re-sequencing is by threading metadata. Add an assertion that ordering uses threading headers, not timestamps.

5. [med] glyph-worker/runs/smoke-eval-email/raw/batch-39.md:40-52 and 60-70: problem. provider_error_retry cases lack an explicit retry cap and two-step approval state machine details for the payment path. (Two retry attempts recorded with no expected.max_retries/backpressure.) Why it matters: correctness for retries (retry storm, idempotency of the outbound attempt, at-most-once delivery of the reply) and the approval_prompt gate for a funds action must be testable. Fix: add expected.retry/max_attempts and must_not ["retry_unbounded"], and for the payment scenario assert state transitions (media_only clarified → details confirmed → approval_prompt issued → explicit 'yes' received → action executed) with must_not ["auto_pay_without_explicit_auth"] and ["pay_on_details_only"].

6. [low] glyph-worker/runs/smoke-eval-email/raw/batch-36.md:5, batch-37.md:15, batch-38.md:25: problem. Several system_event entries are underspecified for reproducibility (no event_id, webhook_id or connector version). Why it matters: makes duplicate_delivery/provider_error_retry claims hard to assert deterministically and weakens regression coverage of the dedupe/retry paths. Fix: include a stable event_id per system_event and, for retries, attempt_index and retry_after (or backpressure reason) to match the "retry in accordance with connector backpressure" text.

## Verdict: REQUEST_CHANGES

```json
{"verdict":"REQUEST_CHANGES","high":2,"med":3,"low":1}
```

---

<!-- chunk 8/16 -->
## Summary (2-4 sentences)

This PR adds raw smoke-eval email batches, a rejects log, an aggregated report and Slack telemetry calls. The artifacts mix metadata and full conversation payloads in a way that creates a public PII exposure and leaks an internal model identity in committed telemetry. There are also schema/consistency issues (unknown turn keys for MIME `References`, orphan IDs in `replyCountMismatch`, and coverage counts that are not derivable from the files added here). These are correctness and security concerns before merge.

## Findings

1. [high] glyph-worker/runs/smoke-eval-email/rejects.jsonl:1,7: The `line` field stores the entire rejected JSON record (full conversation turns/headers/emails). Why it matters: committing full payloads of rejected samples to a public PR leaks PII (email addresses, message bodies, attachment names) and increases blast radius if data is sensitive. Fix: replace `line` with a redacted snippet + stable identifiers (e.g. `{"reason":"...","schema":"tarx.conversation.v1","error_code":"schema_unknown_key","id":"<generated-or-hash>","line_trunc":"{\"schema\":\"...\"}…","line_sha256":"..."}`) or omit raw payload entirely; enforce redaction at collection time.

2. [high] glyph-worker/runs/smoke-eval-slack/calls.jsonl:1-40: Every call hardcodes `model:"stealth/glyph-cluster"` and `ddtags` includes `model:stealth/glyph-cluster` (and `session:"smoke-eval-slack"`). Why it matters: public VCS artifacts explicitly naming the stealth model/identity are a disclosure risk and violate the stated identity policy for public artifacts. Fix: redact to `model:"redacted"` (or remove the model field), strip `model:*` from `ddtags`, and treat identity tags as non-committed telemetry (env-specific) or filter before writing run artifacts to the repo.

3. [high] glyph-worker/runs/smoke-eval-email/raw/batch-8.md:1-8, batch-9.md:1-8: Turns embed full MIME headers (`From:`, `To:`, `Message-ID:`, `In-Reply-To:`, `References:`, `Date:`) inside `text` while also populating `provider_message_id` and `thread`. Why it matters: header duplication creates ID/source-of-truth ambiguity and is the likely source of schema rejections; it also expands PII surface. Fix: normalize inputs so MIME headers are not duplicated into `turn.text` (extract to metadata only) and validate that header-derived IDs match `provider_message_id`/`thread` before acceptance.

4. [med] glyph-worker/runs/smoke-eval-email/rejects.jsonl:1,7: Reject reasons read `schema: turn 0 unknown key References` and `turn 1 unknown key references` (case differs). Why it matters: indicates the validator treats turn fields case-sensitively and is tripping on MIME `References`/`In-Reply-To` leaking into turn objects (not part of `tarx.conversation.v1` turn schema). Fix: either (a) strip non-allowlisted turn keys (whitelist: role,text,t_offset_s,provider_message_id,thread,sender,duplicate_of,...) before JSON Schema validation, (b) normalize header names, or (c) correct the schema to explicitly reject/ignore unknown keys with a structured error; add a unit test covering MIME-wrapped inputs.

5. [med] glyph-worker/runs/smoke-eval-email/report.json:10-16: `replyCountMismatch` lists IDs `email-95139004c5, email-1effc6e547, email-77a0ff6ae5, email-678db2fe17, email-3986395a3a` that do not appear anywhere in the added raw batches (batches here contain inline JSONL with no `id`/`conversation_id` fields). Why it matters: cross-part/partial artifact inconsistency makes the report untraceable and can mislead reviewers/tests. Fix: include each conversation's `id` in the accepted/rejected records, or scope `replyCountMismatch` to the batch set being committed, or regenerate report.json from only these added files.

6. [med] glyph-worker/runs/smoke-eval-email/report.json:21-34: `edgeCaseCoverage` includes `opt_out: 4, opt_in_resume: 4` but none of batch-6.md..batch-9.md contain those edge cases. Why it matters: aggregated coverage for a partial diff is misleading and will pollute downstream metrics. Fix: either add the corresponding batches, or mark this report as `scope: "partial-part-8/16"` and exclude global coverage totals, or commit per-batch coverage instead of a global rollup.

7. [med] glyph-worker/runs/smoke-eval-email/rejects.jsonl:2-6: Five entries are `invalid JSON` with the raw `line` truncated mid-object. Why it matters: malformed JSON generation blocks acceptance but the logged `line` still contains partial message content and there's no `line_number`/`batch`/`offset` to reproduce. Fix: log `batch`, `line_index`, `line_sha256`, and a redacted prefix/suffix (not the full broken payload) plus a parsing error code; consider rejecting with `max_bytes` truncation before logging.

8. [low] glyph-worker/runs/smoke-eval-email/raw/batch-7.md:3,5 and batch-8.md:5, batch-9.md:6: Duplicate-delivery events vary in representation (`duplicate webhook delivery of the same inbound email detected.` vs `duplicate webhook delivery of EMAIL provider_message_id 'em_d5001@example.com' detected; duplicate ignored.` and a system_event with `duplicate_of` pointing to different id forms). Why it matters: inconsistent event schema/strings make idempotency assertions harder to test deterministically. Fix: normalize `system_event` to a structured form (e.g. `{"type":"duplicate_delivery","provider_message_id":"...","duplicate_of":"..."}`) and use consistent id formats.

9. [low] glyph-worker/runs/smoke-eval-email/report.json:1-39: Arithmetic is internally consistent (generated-accepted-rejected=33 == surplusDropped) but the `replyCountMismatch` set has no inverse traceability. Why it matters: minor correctness of reporting; hard to audit. Fix: add counters per reason (`replyCountMismatchCount: 5`) and include an `audit` array referencing batch paths or IDs to make the report verifiable against committed artifacts.

## Verdict: REQUEST_CHANGES

```json
{"verdict":"REQUEST_CHANGES","high":3,"med":4,"low":2}
```

---

<!-- chunk 9/16 -->
## Summary (2-4 sentences)

This is a public eval dataset (tarx.conversation.v1) that broadly covers replay, ordering, threading and allowlists. However the fixtures are inconsistent about the allowlist deny behavior and many `system_event` turns used for duplicate/retry cases are missing the correlation keys (e.g. `provider_message_id`, `duplicate_of`) that the harness needs to assert idempotency. These are correctness issues for the tests themselves (they don't test what they claim) and should be normalized before merge. No obvious secrets or injection vectors are introduced by the diff.

## Findings

1. [high] glyph-worker/runs/smoke-eval-slack/dataset.jsonl:~7–200 (non_allowlisted_sender fixtures): Inconsistent expected deny behavior between fixtures. For example `slack-0bf289b009` expects `reply_count:0` and `must_not:["reply_to_unknown_sender"]` (silent drop) while `slack-82b2d9565e` expects `reply_count:1` with a safe rejection reply.  
   Why: contradicts the stated security policy and makes the eval non-deterministic (passes/fails depending on harness implementation).  
   Fix: pick a single allowlist-deny contract (recommend "deny with a single safe, non-disclosing reply" to avoid user probing) and update every `non_allowlisted_sender` fixture's `expected.reply_count` and `must_not` to match it.

2. [high] glyph-worker/runs/smoke-eval-slack/dataset.jsonl: multiple `system_event` turns (e.g. duplicate_delivery/provider_error_retry cases such as the `slack-4f2b2c4528`, `slack-8f08b9af17`, `slack-3cdd01faf0` style events): `system_event` entries lack correlation identifiers (`provider_message_id` and/or `duplicate_of`) even though the text claims a duplicate/retry.  
   Why: breaks idempotency/replay assertions (harness cannot key the duplicate to the original message). Correctness/race condition risk for the test suite.  
   Fix: require that every duplicate/retry `system_event` includes `provider_message_id` and, when it is a duplicate, `duplicate_of` (and a monotonic `t_offset_s`/sequence). Audit all fixtures with `edge_cases` containing `duplicate_delivery` or `provider_error_retry` and backfill these keys.

3. [high] glyph-worker/runs/smoke-eval-slack/dataset.jsonl: fixtures representing duplicate deliveries (e.g. `slack-4f7d5b34bc`, `slack-01987d66d0`) use `duplicate_of` equal to the same `provider_message_id` and sometimes the user turn and system_event share the same `t_offset_s`.  
   Why: ambiguous for ordering/replay (self-referential duplicate without a delivery attempt id) can hide race conditions in the harness.  
   Fix: represent duplicates with a distinct delivery id (e.g. `delivery_id`, `webhook_attempt_id`) or ensure `duplicate_of` references the original delivery and the system_event is recorded at a later/logical offset. Also avoid re-using identical `(provider_message_id, t_offset_s)` for the original user turn and the duplicate event when they are separate events.

4. [med] glyph-worker/runs/smoke-eval-slack/dataset.jsonl: out_of_order fixtures (e.g. `slack-6cec03a7fb`, `slack-9871e87634`, `slack-5f3a665fa7` variants) do not consistently include the reconciliation signal (`system_event.text` noting re-sorting) with correlation keys.  
   Why: makes "process events in correct order" untestable (assertion cannot distinguish reordering from re-interpretation).  
   Fix: add a `system_event` that records the sort key(s) used (e.g. `provider_timestamp`, `received_at`, `sequence_id`) for each event in the batch and update `expected` to state the ordering rule exercised.

5. [med] glyph-worker/runs/smoke-eval-slack/dataset.jsonl: synthetic PII is widespread (phone numbers like `+1555-…`, multiple `@example.com`/`@exmaple-not-real.example.com`, tracking IDs).  
   Why: while clearly synthetic for evals, publishing in a public PR sets a precedent to avoid realistic-looking identifiers in test data and can complicate redaction in logs if the harness ever emits fixtures.  
   Fix: replace with reserved/example ranges (e.g. `+15555550100` or `555-0100` in a reserved block), use `user@example.com`, `contact@example.org`, and mark tracking IDs as `trk-example-001`. Also correct the small typo `exmaple-not-real.example.com` to a valid example domain.

6. [med] glyph-worker/runs/smoke-eval-slack/dataset.jsonl: schema consistency gaps (e.g. `thread` typed as string/ts in places, `sender` missing vs `"unknown"` vs `"owner"`, `provider_message_id` missing on some user/system_event turns).  
   Why: reduces reproducibility of assertions (harness must guess defaults) and can mask API misuse in the eval schema.  
   Fix: define required fields per role (e.g. `system_event` must carry a correlation id when describing a delivery/retry; `user` with `thread` must carry `thread` as a stable ts string), add a brief schema note in the eval README, and normalize existing fixtures to that contract.

7. [low] glyph-worker/runs/smoke-eval-slack/dataset.jsonl: media_only fixtures (e.g. `slack-71d1c9d1d5`, `slack-0885e62edd`) sometimes represent the attachment as empty `text` and sometimes as a placeholder token but lack `attachments[]` metadata.  
   Why: the eval claims to test media-only handling but the payload shape is underspecified.  
   Fix: add an `attachments` array (e.g. `[{type:"image", name:"receipt.png", url:"https://example.com/attachments/receipt.png"}]`) to media_only turns so the harness validates the actual input shape rather than freeform text.

## Verdict: REQUEST_CHANGES

```json
{"verdict":"REQUEST_CHANGES","high":3,"med":3,"low":1}
```

---

<!-- chunk 10/16 -->
## Summary (2-4 sentences)

This PR adds a large set of public smoke-eval Slack conversation fixtures under `glyph-worker/runs/smoke-eval-slack/raw/`. While useful for regression tests, committing these JSONL traces introduces security and correctness risks: multiple fixtures include PII (emails and phone numbers), there is no evidence of signature verification or replay protection for the `system_event`/webhook fields they rely on, and the loader contract implied by the fixtures is ambiguous about idempotency and ordering. At least the PII and unvalidated webhook inputs must be remediated before merging.

## Findings

1. [high] glyph-worker/runs/smoke-eval-slack/raw/batch-0.md:1: **PII committed to a public PR.** The JSONL contains real-looking emails (e.g. `alex.johnson@example.com`, `jordan.lee@example.com`) and message identifiers that are not necessary for the behavior under test. **Why:** publishing PII in VCS increases exposure and can leak test accounts. **Fix:** replace all emails, phone numbers, and workspace-specific ids with deterministic redaction tokens (e.g. `user_001@example.com`, `+15550000000`) or use fixture fakers, and add a `scripts/check-fixtures-for-pii.mjs` gate in CI.

2. [high] glyph-worker/runs/smoke-eval-slack/raw/batch-1.md:6: **Unverified webhook fields enable replay confusion.** The fixture accepts `provider_message_id`, `duplicate_of`, and `system_event` at face value without requiring a signature, nonce, or timestamp from Slack Events API. **Why:** if the test loader ever treats these as trusted inputs, replay/dedup logic can be bypassed. **Fix:** enforce in the loader that any `system_event` representing a webhook is validated (HMAC signature + `event_ts` + nonce + replay window) and the fixtures must explicitly assert those fields are ignored unless verified (or split into "verified" vs "synthetic" test sets).

3. [high] glyph-worker/runs/smoke-eval-slack/raw/batch-2.md:6: **Ordering assumption not enforced by schema.** The `out_of_order` case provides `t_offset_s` but no monotonic `event_ts`/`event_id` from the transport. **Why:** race conditions between webhook retries and rapid messages require the processor to sort by a server-supplied timestamp, not client offsets. **Fix:** extend the `tarx.conversation.v1` schema used by these fixtures to require `event_ts` (epoch seconds.ms) and use it for ordering; reject `t_offset_s` as authoritative for dedup/replay.

4. [med] glyph-worker/runs/smoke-eval-slack/raw/batch-10.md:2: **Retry modeled but no replay window tested.** `provider_error_retry` + `duplicate_delivery` lacks a `retry_after`/`seen_at`/`nonce` and doesn't test expiration. **Why:** correct dedup must distinguish "legit retry within window" from "replay after window". **Fix:** add explicit `replay_window_s` and `max_retries` to the fixture's `expected` block, and assert the loader evicts seen keys by TTL (not just a global set).

5. [med] glyph-worker/runs/smoke-eval-slack/raw/batch-11.md:5: **Allowlist bypass surface in test data.** `non_allowlisted_sender` fixtures show the connector rejecting requests, but the raw traces include `sender:"unknown"` and no `team_id`/`enterprise_id` allowlist context. **Why:** tests must prove the allowlist is checked before any assistant reply and before reading conversation state. **Fix:** require `allowed_teams`/`allowed_senders` in the scenario context and assert the loader short-circuits on the allowlist check (return 403/ignore) with no side effects logged to the assistant channel.

6. [med] glyph-worker/runs/smoke-eval-slack/raw/batch-12.md:5: **Idempotency key missing for side effects.** Scenarios that "create a reminder"/"schedule" don't include an `idempotency_key` (e.g. `key = "${channel}:${provider_message_id}:reminder:create"`). **Why:** duplicate deliveries can still create side effects if the store check and insert aren't atomic. **Fix:** add `idempotency_key` to action-intent fixtures and assert the executor uses insert-if-not-exists + versioned update (or DB unique constraint) rather than "read then write".

7. [med] glyph-worker/runs/smoke-eval-slack/raw/batch-14.md:4: **Ambiguity tests don't prevent prompt injection via user text.** `ambiguous_request` uses freeform text but the loader isn't constrained. **Why:** if these fixtures are ever rendered into a prompt that forwards raw user text to tools, injection is possible. **Fix:** treat fixture `text` as untrusted, escape for any templating, and enforce allowlists on tool args (no echo of unsanitized `text` into system/tool strings).

8. [med] glyph-worker/runs/smoke-eval-slack/raw/batch-15.md:3: **"media_only" fixture lacks safe fallback contract.** The expected behavior is to prompt for description, but no guard against blind OCR/extraction is asserted. **Why:** prevents accidental PII exfiltration or hallucinated content. **Fix:** add `expected.must_not` including `extract_text_from_media` unless `media_text_verified=true`, and require explicit consent before any media processing.

9. [med] glyph-worker/runs/smoke-eval-slack/raw/batch-17.md:5: **Approval prompt bypass test gap.** `approval_prompt` cases rely on the user replying `yes`/`approve` but don't assert the action is gated by a policy decision (who, what, scope) and logged. **Why:** approval strings are guessable and must be tied to the request id. **Fix:** require `approval_request_id` and assert the executor checks (approver in allowlist) and records an audit event before executing.

10. [low] glyph-worker/runs/smoke-eval-slack/raw/batch-23.md:1: **Misleading artifact location.** Committing "raw" run outputs to the source tree blurs test fixtures and runtime logs. **Why:** increases repo size, risks accidental import, and misleads readers about whether these are generated. **Fix:** move fixtures to `glyph-worker/__fixtures__/slack-smoke/` (or `tests/fixtures/`), add `runs/` to `.gitignore`, and document the generation script instead of checking in raw batches.

## Verdict: REQUEST_CHANGES

```json
{"verdict":"REQUEST_CHANGES","high":3,"med":6,"low":1}
```

---

<!-- chunk 11/16 -->
## Summary

This PR adds 15 raw Slack smoke-eval fixture files under `glyph-worker/runs/smoke-eval-slack/raw/`. The fixtures are useful for replay/idempotency coverage, but committing them to a public PR introduces a high-severity data exposure risk (PII-like placeholders that should be scrubbed), and several batches rely on `duplicate_of`/`provider_message_id` reuse without making the loader's composite key explicit. These issues must be addressed before merge to avoid leaking test identities and masking replay/race bugs in the consumer.

## Findings

1. [high] glyph-worker/runs/smoke-eval-slack/raw/batch-24.md:1-8: The fixture includes contact-like values (`+15551230001`, `alex+rem@example.com`, `morgan@example.com`, `jordan@example.com`, `updates.example.com`, `notes.example.com`, `release-updates@example.com`) inside a PUBLIC PR. Why it matters: even if synthetic, publishing phone numbers/emails in repo history expands attack surface and can be scraped. Fix: scrub to reserved `.example`/RFC 2606 values (e.g. `+15550000`, `user@example.com`) or generate via a fixture factory that never emits real identities; add a `scripts/check-fixtures-no-pii.mjs` gate to block new batches from adding non-example domains or E.164 numbers outside a whitelist.

2. [high] glyph-worker/runs/smoke-eval-slack/raw/batch-26.md:1-8: `non_allowlisted_sender` cases set `sender:"unknown"` and expect the assistant to reject (`"must_not":["execute_commands","process_unknown_request","process_external_requests"]`) with a fallback reply. Why it matters: if the event loader ever trusts `sender` from the raw JSONL before allowlist lookup, injection/path confusion is possible. Fix: enforce server-side allowlist by authenticated actor only (never trust `sender` from unverified webhook body), require `actor_id` from connector identity, and have the fixture loader explicitly mark `sender` as "test-only" and ignored by runtime.

3. [med] glyph-worker/runs/smoke-eval-slack/raw/batch-25.md:1-8: `duplicate_delivery` and `provider_error_retry` reuse `provider_message_id` and set `"duplicate_of": "<same id>"` across system_event + user event. Why it matters: correctness depends on idempotency key. If the dedup logic only keys by `provider_message_id` (and ignores `channel`, `thread`, `event_ts`), a cross-thread retry could be mis-detected (race condition). Fix: change the fixture schema expectation to require composite key `(channel, team_id?, thread, provider_message_id, event_ts)` and assert in unit tests that dedup rejects duplicates with mismatched thread/channel.

4. [med] glyph-worker/runs/smoke-eval-slack/raw/batch-29.md:1-8: The `"duplicate webhook delivery of SM received..."` events reuse the original `provider_message_id` and expect `"must_not":["duplicate_assistant_reply","create_duplicate_calendar_events","dispatch_reminders_with_undefined_deadline"]`. Why it matters: tests that "don't test what they claim" are easy here (counting `reply_count` alone can miss in-process double-write). Fix: extend expected to include `side_effects` (e.g. `reminder_created_count==1`, `calendar_event_ids` deduped) and have the verifier compare before/after state, not just assistant messages.

5. [med] glyph-worker/runs/smoke-eval-slack/raw/batch-31.md:1-8: `out_of_order` fixtures (e.g. t_offset_s 5 then 3) rely on reordering by logical context. Why it matters: without a max replay window and monotonic watermark, a delayed event can be re-injected to replay an action. Fix: enforce `replay_window_s` (e.g. 300s), `max_skew_s`, and reject events with `t_offset_s` older than window or whose `provider_message_id` already expired from dedup cache; include these constraints in fixture validation.

6. [med] glyph-worker/runs/smoke-eval-slack/raw/batch-33.md:1-8: `long_context` batches include large free-text blocks (meeting notes, feature lists) that the agent is told to "sort by effort and urgency". Why it matters: if the loader ever feeds these to an unscoped tool (e.g. broad search/create) instead of a read-only summarizer, prompt injection surface grows. Fix: constrain allowed tools for these scenarios to `read_only` set, add `must_not:["use_write_tool"]` to those cases, and verify tool calls in expected trace.

7. [med] glyph-worker/runs/smoke-eval-slack/raw/batch-35.md:1-8: `media_only` uses `"text":""` and system_event `"media attachment received..."` but expected says `"must_not":["guess_file_contents","guess_attachment_content"]`. Why it matters: API misuse risk if the connector passes raw attachment URL to model without allowlist of domains/mime types and without redaction. Fix: require `attachment.allowlisted==true`, `mime_type` in safe list, strip query params from `url` (or use signed, internal URL), and explicitly block image OCR tools unless scenario opts in.

8. [med] glyph-worker/runs/smoke-eval-slack/raw/batch-36.md:1-8: `ambiguous_request` + `duplicate_delivery` combined cases expect clarification before action. Why it matters: race between "clarify" and the duplicate retry could send two clarification messages. Fix: treat "awaiting_clarification" as a conversation state with idempotent reply key (`(channel,thread,user_msg_id,"clarify")`) to prevent double replies on retry.

9. [low] glyph-worker/runs/smoke-eval-slack/raw/batch-32.md:1-8: Approval-required destructive action (`delete 'draft ideas'`) expects `"must_not":["delete_without_approval"]`. Why it matters: to actually test this, verifier must assert the destructive side-effect didn't occur until after affirmative `yes`. Fix: add `precondition` and `postcondition` (e.g. resource exists before turn 1, still exists after rejection path, removed only after approval) to the fixture instead of relying on assistant text.

10. [low] glyph-worker/runs/smoke-eval-slack/raw/batch-38.md:1-8: `opt_in_resume` asserts normal processing resumes after system_event `"opt-in confirmed..."`. Why it matters: correctness of carrier consent state machine. Fix: track `consent_state` transitions (opt_out->opt_in) with timestamp and reject any assistant reply between opt-out and opt-in events except the safe confirmation.

## Verdict: REQUEST_CHANGES

```json
{"verdict":"REQUEST_CHANGES","high":2,"med":6,"low":2}
```

---

<!-- chunk 12/16 -->
## Summary (2-4 sentences)

This is a PUBLIC PR adding smoke-eval run artifacts (Slack raw JSONL batches + report/rejects and SMS-2 call telemetry). The largest security issue is committing operational telemetry in `glyph-worker/runs/smoke-eval-sms-2/calls.jsonl` (model slug, per-task timings, abort reason with an internal "price guard: team total_used" string and many null fields) which can leak internal infrastructure/accounting if published. Correctness issues include `glyph-worker/runs/smoke-eval-slack/report.json` reporting `accepted: 200, rejected: 0` while listing 4 `replyCountMismatch` IDs with an empty `glyph-worker/runs/smoke-eval-slack/rejects.jsonl`, plus sample PII in the raw conversation fixtures. These must be sanitized and the acceptance/reporting made internally consistent before merge.

## Findings

1. [high] glyph-worker/runs/smoke-eval-sms-2/calls.jsonl:1-41: Sensitive telemetry leaked to a public artifact. The JSONL includes `model:"stealth/glyph-cluster"`, per-task `ttft_ms/total_ms/tokens_*`, HTTP 408 and `aborted` events (e.g. lines near 10,23,38,39 in this diff) and the verbatim string `error:"price guard: team total_used rose by 0.035000000"`. Why it matters (security): public run artifacts must not expose internal model identifiers, team accounting totals or guardrail internals; they also increase recon of infra. Fix: redact before publish — replace `model` with `model:redacted`, strip `cost`, `market_cost`, any `team_*`/`price guard` values, hash or drop session/profile/task identifiers if not needed, and move aborted/guard events to a private `runs/*/telemetry-private.jsonl` excluded by `.gitignore`/publish allowlist. Also ensure error messages are generic (e.g. `guard_threshold_exceeded`).

2. [high] glyph-worker/runs/smoke-eval-sms-2/calls.jsonl:10,23,38,39: Inconsistent event schema for failures. `status:"error"`/`"aborted"` have `tokens_in/tokens_out/tokens_reasoning/tokens_cached/cost/market_cost` null and `ttft_ms` null while `http_status`/`error` exist. Why it matters (correctness/API misuse): downstream ingest will treat these as partially valid events (type confusion) and can hide retry budget/timeout classification. Fix: use a discriminated union per status (e.g. `ok` requires non-null token/timing fields or allow partial with `usage:null` explicit), add `failure_kind` (`timeout|http_408|guard|client|unknown`), `retry_after_ms` (or `retryable:boolean`), `attempts` and do not emit raw guard strings; normalize nulls to explicit `null` with schema validation in the writer.

3. [high] glyph-worker/runs/smoke-eval-slack/raw/batch-4.md:3, batch-5.md:3, batch-6.md:2, batch-7.md:6, batch-8.md:3, batch-9.md:6 and others: PII in sample fixtures. Examples reference concrete emails `morgan@example.com`, `alex@example.com`, `jordan@example.com`, `sunday@example.com` and a phone-like `+15551230001`. Why it matters (security): public eval fixtures should not use realistic personal identifiers (even examples) and can be scraped; also can leak test data intent. Fix: use RFC 2606/5737-safe values (`alice@example.com`, `bob@example.com`), E.164 reserved `+15555550100` range or `REDACTED`, and replace any owner-specific tokens with neutral placeholders.

4. [med] glyph-worker/runs/smoke-eval-slack/report.json:10-14 and rejects.jsonl:1: Acceptance/reporting inconsistent with measured mismatches. `replyCountMismatch` lists `slack-779c57b2b9`, `slack-21b4a2c693`, `slack-ec7ed30ea7`, `slack-5b683413b1` but `rejected: 0`, `rejectReasons: {}` and `rejects.jsonl` is empty. Why it matters (correctness/tests): the report claims `accepted: 200` while recording acceptance failures — misleading for reviewers and any CI gate reading these artifacts. Fix: write each mismatch to `rejects.jsonl` with `id, reason:"reply_count_mismatch", expected_reply_count, actual_reply_count, path`, set `rejected = count` (or `acceptedWithWarnings`) and update `acceptanceBasis` to reflect the rule used.

5. [med] glyph-worker/runs/smoke-eval-slack/report.json: overall: Coverage missing security enforcement metrics. `edgeCaseCoverage` covers delivery/threading/media/allowlist/approval but has no `replay_window`, `signature_verification`, `allowlist_enforced`, `idempotency_key`, `retry_dedup` or `rate_limit` buckets despite scenarios testing duplicates/retries/non_allowlisted_sender. Why it matters (security): you cannot prove the stated security priorities were exercised by these fixtures. Fix: add `securityCoverage` (e.g. `replay_window_tested:n`, `allowlist_enforced:n`, `webhook_signature_verified:n`, `idempotency_enforced:n`) sourced from scenario tags.

6. [med] glyph-worker/runs/smoke-eval-sms-2/calls.jsonl:12,22-25,34-41: Retry classification and abort root cause unclear. `dataset.sms.b12` appears as attempt 1 `status:error` (http 408) then attempt 2 `status:ok` later; `b23` and `b39` are `aborted` with price guard. Why it matters (correctness/retries): the artifact conflates “provider retryable timeout” with “pipeline guard abort” and loses `request_id`, `retry_after_ms`, `timeout_ms`. Fix: record `retry_budget_used`, `max_attempts`, `retryable`, `duration_until_abort_ms`, and do not log internal accounting amounts; treat guard aborts as `status:aborted` with `failure_kind:guard` and generic `error_code`.

7. [med] glyph-worker/runs/smoke-eval-slack/raw/batch-39.md:4, batch-5.md:3, batch-6.md:3, batch-7.md:2, batch-9.md:5: Duplicate event self-reference and dedup signal clarity. Several `system_event` entries set `provider_message_id` equal to `duplicate_of` (e.g. `Ev0123C001` with `"duplicate_of":"Ev0123C001"`) and rely on `reply_count<=1`. Why it matters (correctness/race conditions/idempotency): a self-referential `duplicate_of` is ambiguous for ordering/replay windows and can hide a missing `delivery_id`/`event_id` or clock skew. Fix: require `delivery_id != event_id`, use `original_event_id`+`delivery_id` (or `webhook_event_id`), enforce `replay_window_s` and treat self-ref as `schema_violation` in validation rather than a valid duplicate.

8. [low] glyph-worker/runs/smoke-eval-slack/report.json:5-9,33-36: Generation accounting not self-consistent with drops. `generated: 240, requested: 200, surplusDropped: 40` with no `dropReasons` histogram and `turnsMin/Max/Mean` computed post-drop. Why it matters (correctness/docs misleading): unclassified surplus drops impede reproducibility of coverage. Fix: add `dropReasons` (e.g. `max_turns_exceeded`, `schema_invalid`, `edge_case_collision`, `token_limit`) and `keptByBatch[]` or generation seed.

9. [low] glyph-worker/runs/smoke-eval-slack/raw/batch-*.md: Some scenarios assert `must_not:["start a top level reply"]`, `["double reply to a duplicate"]` but the acceptance uses only `reply_count`. Why it matters (tests don't test what they claim): negative constraints need explicit assertions (e.g. `thread_id` preserved, no assistant turn emitted for duplicate event id) not inferred from count alone. Fix: extend evaluator to check `must_not` predicates (thread continuity, no emission on duplicate delivery id, allowlist enforcement result) and record per-constraint pass/fail in rejects.jsonl.

## Verdict: REQUEST_CHANGES

```json
{"verdict":"REQUEST_CHANGES","high":3,"med":4,"low":2}
```

---

<!-- chunk 13/16 -->
## Summary (2-4 sentences)

The added `glyph-worker/runs/smoke-eval-sms-2/dataset.jsonl` is a large smoke eval fixture. While useful for opt-out/allowlist/dedup coverage, it introduces security and correctness issues for a PUBLIC PR: realistic PII (phone numbers and contact addresses), a few contradictions between `expected.reply_count` and "must_not" constraints (especially for non-allowlisted senders), and ambiguous idempotency markers (`duplicate_of` equal to `provider_message_id`). Additionally the dataset implicitly relies on connector-side reassembly/retry semantics that the harness must explicitly enforce to avoid false positives.

## Findings

1. [high] glyph-worker/runs/smoke-eval-sms-2/dataset.jsonl:1-200: Synthetic but realistic E.164 numbers and emails are committed to a public repo.  
   Problem: Even for eval data, publishing live-looking numbers (+15551234567, +15559876543, +15554321987, +15558675309, +15552223333, etc.) and `alex.j@example.com` normalizes PII in fixtures and can be scraped/reused.  
   Fix: Replace all sender numbers and any contact endpoints with RFC 5737/555 test ranges (e.g. `+15555550100`–`+15555550999`) or non-reversible tokens (`sender:"owner_token_001"`), and use `example.com` only. Also add a `dataset.readme` note that values are synthetic and consider `git filter-repo` if already exposed.

2. [high] glyph-worker/runs/smoke-eval-sms-2/dataset.jsonl:39, 84, 146, 158, 179: Expected replies to non-allowlisted senders conflict with allowlist policy.  
   Problem: Cases `sms-73b9b112d1`, `sms-d88fae3ba5`, `sms-29c428e736`, `sms-43a6f22e57`, `sms-293f1108d8` expect `reply_count:1` (and include `assistant` text) while also stating `must_not: ["reply_to_unknown","leak_private_context"]` / "connector blocked..." and to send zero replies to unknown senders. This trains the harness to violate the security constraint and masks a policy bypass.  
   Fix: Change `expected.reply_count` to `0` for these cases, remove any `assistant` turns emitted to the unknown sender, and only assert connector `system_event`s (block/drop/dedup). If rejection is required, assert a single connector audit event and explicitly prohibit agent replies in the test harness.

3. [high] glyph-worker/runs/smoke-eval-sms-2/dataset.jsonl:28, 35, 77, 121, 166, 183: Opt-out must be enforced after `STOP`.  
   Problem: `sms-754943389d`, `sms-a07e269d50`, `sms-99664a8293`, `sms-20cd062849`, `sms-129720a82f` show a post-STOP user turn that must be suppressed, but `sms-754943389d` expects `reply_count:1` (only the pre-STOP reply) and others rely on "message suppressed" without asserting that no `assistant` turn is produced after `t_offset_s` of the `STOP` processing event. A race in connector->agent handoff can leak a reply.  
   Fix: For each opt-out case, assert `last_assistant_t_offset_s < stop_processed_t_offset_s` and `replies_to_post_stop == 0`, and add a harness check that `must_not: ["reply after the STOP keyword is processed"]` is validated by timestamp (not just count alone).

4. [med] glyph-worker/runs/smoke-eval-sms-2/dataset.jsonl:18, 24, 29, 48, 53, 64, 77, 95, 109, 112, 118, 133, 137, 139, 147, 156, 164, 166, 176, 180, 181, 183, 191, 195, 200: Self-referential `duplicate_of` for the same `provider_message_id`.  
   Problem: Many `system_event` entries set `"duplicate_of":"<same id>"` and in some cases the `assistant` turn is also tagged with the same `duplicate_of`. This is ambiguous for a dedup key (original vs retransmit) and can be exploited to bypass "drop the duplicate with no re-execution" by re-injecting the same key.  
   Fix: Treat `provider_message_id` as the delivery id and `duplicate_of` as the original id. When a webhook is a retransmit of the same delivery, omit `duplicate_of` or use `null`; when it's a repeat of the user message, set `duplicate_of` to the first processed `provider_message_id` (different value). Add a schema constraint test (reject self-equality) and update the affected fixtures to use the original id.

5. [med] glyph-worker/runs/smoke-eval-sms-2/dataset.jsonl:23, 50, 59, 74, 97, 107, 110, 115, 132, 142, 151, 162, 173, 177, 187, 192, 199: Out-of-order messages lack a verifiable timeline assertion.  
   Problem: Cases rely on "connector detected out_of_order messages and reassembled timeline..." but `expected` never asserts that agent turns were computed against chronological order by `t_offset_s`, only final reply text/count. A naive "process in delivery order" implementation could pass text-based checks while violating correctness.  
   Fix: For `out_of_order` cases, add `expected.timeline_must_be_chronological: true` and a harness assertion that the effective turn sequence used for the reply is sorted by `t_offset_s` (and thread) before NLU/action execution; also assert the reply does not reference a pre-correction constraint.

6. [med] glyph-worker/runs/smoke-eval-sms-2/dataset.jsonl:2-200: Opt-in resume path doesn't enforce idempotency/replay window.  
   Problem: `sms-692667f04f`, `sms-8f1926d1f2`, `sms-c033dc29a4`, `sms-779f30280d`, `sms-380d3745f1`, `sms-b3f259f102`, `sms-04bfd214d3`, `sms-06deaaa48d` accept `START` and system opt-in events but have no `replay_until`/`nonce`/`window_s` or `must_not: ["replay_opt_in"]` verified by timestamp delta (e.g. +24h jumps).  
   Fix: For opt-in events include `event_id` (nonce), `issued_at_s`, `window_s` (e.g. 300s), and add harness checks: reject events outside window, reject re-use of `event_id`, and assert "replay_opt_in" is never observed (dedup by event_id, not only message id).

7. [med] glyph-worker/runs/smoke-eval-sms-2/dataset.jsonl:18, 24, 35, 48, 77, 84, 95, 109, 112, 121, 133, 137, 146, 147, 156, 158, 164, 166, 176, 179, 180, 181, 183, 191, 195, 200: Multi-segment and rapid-fire expectations don’t enforce reply deduplication to the agent.  
   Problem: Several fixtures expect a small `reply_count` but don’t explicitly assert "reply_to_each_message_with_excess_delay_spam" is prevented by batching; combined with duplicate_delivery this is prone to double execution if not keyed by (conversation_id, turn_range, action_key).  
   Fix: Add `expected.batching_required: true` for `rapid_fire` and `multi_segment` cohorts and assert: at most one `assistant` turn per action batch, and that assistant turns are not generated per user segment when concatenated.

8. [med] glyph-worker/runs/smoke-eval-sms-2/dataset.jsonl:35, 77, 118, 133, 139, 156, 164, 166, 176, 181, 183, 191, 195: Provider retry path conflates "outbound retry successful" with re-delivering the user request.  
   Problem: Events like "outbound retry succeeded for SM..." and re-emitting the user text as an `assistant` turn (e.g. `sms-68125be8cf`, `sms-d746ea54e4`) blur actor roles and can trigger re-execution if the harness treats assistant-echoed user text as input.  
   Fix: Treat retry events as transport-only (`role:"transport_event"` or `role:"system_event"` with `type:"outbound_retry"`), never echo the original user `text` in `assistant` role, and assert `side_effects_executed_once: true` (idempotency key by reminder_id/action_id, not by the echoed string).

9. [med] glyph-worker/runs/smoke-eval-sms-2/dataset.jsonl:28, 108, 117, 135, 138, 144, 149, 159, 167, 170, 178, 182, 186, 190, 196, 200: Approval_prompt cases lack a negative path and a state guard.  
   Problem: Destructive actions (`delete job`, `broadcast`, `cancel meeting`, `clear list`, `delete notes`, `send to group`, `pay hold fee`) only test the "Y" path. No test asserts: no execution on "N"/timeout/unknown reply, no execution before confirmation, and that approval is single-use (cannot be replayed).  
   Fix: Add companion cases for each approval action with `"N"`, empty reply, and a replay attempt (resend the same approval context) asserting `reply_count` unchanged and `must_not` includes "execute without confirmation" and "reuse approval token".

10. [low] glyph-worker/runs/smoke-eval-sms-2/dataset.jsonl:1: Schema/version pinning unclear for public harness.  
   Problem: `"schema":"tarx.conversation.v1"` is unversioned in the repo; if the eval loader expects a specific minor/feature flags, a silent schema evolution could misparse `thread`, `duplicate_of`, `provider_message_id`, `transport_event`.  
   Fix: Pin to `tarx.conversation.v1.0` or include `schema_version` and `min_harness_version`, and fail fast on unknown fields in CI for public PRs.

## Verdict: REQUEST_CHANGES

```json
{"verdict":"REQUEST_CHANGES","high":3,"med":6,"low":1}
```

---

<!-- chunk 14/16 -->
## Summary
This PR adds 27 raw SMS smoke-eval fixtures under `glyph-worker/runs/smoke-eval-sms-2/raw/` to exercise deduplication, allowlists, opt-in/out, threading, media-only, and ordering. The dataset is useful for security/correctness coverage, but a few fixtures contain self-referential `duplicate_of` values, mixed types for `duplicate_of` (number vs string), and a small number of expectations that are ambiguous for an idempotency test (e.g. when a duplicate webhook should produce 0 vs 1 assistant replies). These can mask real bugs in the dedup/replay logic and should be corrected before merging. 

## Findings

1. [high] glyph-worker/runs/smoke-eval-sms-2/raw/batch-0.md:1: The first turn's `system_event` sets `"duplicate_of":0` while referencing `provider_message_id` `SM3f8a620e94d742cbb62e018ac7f92d04`. A numeric `0` is not a message id and is inconsistent with the string ids used elsewhere, making deduplication unverifiable. Fix: set `duplicate_of` to the original `provider_message_id` string (or omit it for the original event) and keep types consistent across fixtures.

2. [high] glyph-worker/runs/smoke-eval-sms-2/raw/batch-10.md:4: The duplicate webhook uses `"duplicate_of":"SMbf4888901649832af41415f9e02eb833"` which equals the same `provider_message_id`. This is self-referential and contradicts `"duplicate_of"` meaning "original message id". Fix: set `duplicate_of` to the id of the first user message that triggered the assistant reply (or to the original delivery id), not to the duplicate event's own id.

3. [high] glyph-worker/runs/smoke-eval-sms-2/raw/batch-10.md:4: The scenario expects `reply_count:2` but also includes `"must_not":["create_duplicate_reminder"]` while the duplicate event produces an assistant reply `"No reminders currently set for tomorrow."` (turn at t_offset_s:9). For strict idempotency of side effects the correct expectation is usually `reply_count:1` with a no-op reply, or explicitly document whether the evaluator counts a safety reply. Fix: either change `reply_count` to 1 and ensure only the original turn replies, or adjust the event to not emit a second assistant turn if the action was already completed.

4. [med] glyph-worker/runs/smoke-eval-sms-2/raw/batch-1.md:6: The `unknown` sender's duplicate delivery uses `"duplicate_of":"SM90B7E24FC6D8152A45C06E81A9A5D02"` and the system_event text states "duplicate webhook delivery of SM90B7E24FC6D8152A45C06E81A9A5D02 for +15558675309." While the allowlist block is correct, the fixture doesn't assert `reply_count` change or that the assistant reply at t_offset_s:55 is only to `owner`. Fix: add an explicit assertion (e.g. `must_not:["respond_to_unknown_sender"]` already present) and ensure the evaluator filters replies by `sender`/thread before counting to avoid inflating `reply_count`.

5. [med] glyph-worker/runs/smoke-eval-sms-2/raw/batch-11.md:1: The non-allowlisted sender scenario expects `reply_count:1` and `must_not:["forward_request_to_agent"]`. The reply text is a generic rejection sent to the blocked sender context. Fix: explicitly constrain the reply direction (e.g. `must_not:["respond_with_actionable_data"]`) and ensure the test harness treats connector-blocked requests as not producing agent-executed actions, not just reply count.

6. [med] glyph-worker/runs/smoke-eval-sms-2/raw/batch-12.md:3: The `media_only` turn includes an empty `text` string for the user message. Some evaluators treat empty body as "no user turn" and may count replies incorrectly. Fix: either omit the `text` field or set it to `""` consistently but add `must_not:["treat_empty_text_as_command"]` and verify `reply_count:1` matches the single `assistant` prompt.

7. [med] glyph-worker/runs/smoke-eval-sms-2/raw/batch-13.md:3: The `provider_error_retry` case emits the same `provider_message_id` on the `assistant` retry event and expects `reply_count:2` total for assistant/user turns but relies on the connector to not re-execute side effects. Fix: add `must_not:["duplicate_side_effects"]` (or strengthen existing) and include `retry_id` to distinguish original delivery vs retry in fixtures.

8. [med] glyph-worker/runs/smoke-eval-sms-2/raw/batch-15.md:5: The duplicate delivery uses the same `provider_message_id` as the original and the assistant responds with "Reminder already set..." expecting `reply_count:2`. This is reasonable but mixes dedup of webhook vs user intent. Fix: annotate the duplicate as `webhook_duplicate: true` or split into two sub-cases (webhook retry vs user resent text) to avoid conflating idempotent reply with a new turn.

9. [med] glyph-worker/runs/smoke-eval-sms-2/raw/batch-18.md:3: The duplicate webhook is logged but the scenario states "process the original message once and ignore the duplicate webhook with no extra assistant reply" yet the fixture only shows the original user+assistant (reply_count:1). Fix: ensure the `system_event` for duplicate is marked `consumed: true` in fixture metadata and that the evaluator does not increment reply count for dropped webhooks.

10. [low] glyph-worker/runs/smoke-eval-sms-2/raw/batch-21.md:3: The duplicate delivery expects "avoid resending the same acknowledgment unnecessarily" with `reply_count:2` (original ack + "Already noted..." at later offset). Fix: document that this is an "intent-level dedup" (different from webhook drop) in the scenario text to prevent the test from being interpreted as a pure webhook dedup test.

11. [low] glyph-worker/runs/smoke-eval-sms-2/raw/batch-22.md:3: The `provider_error_retry` sequence uses `assistant` turns to report "retrying..." and success. Fix: tag those as `system_event` or `assistant_status` (non-user-visible action log) in future fixtures to prevent counting transient status messages as conversational replies unless explicitly included in `reply_count`.

12. [low] glyph-worker/runs/smoke-eval-sms-2/raw/batch-26.md:3: `out_of_order` corrections apply across multiple offsets (0,2,1). Fix: include a `sequence_key` (e.g. `client_seq`) in turns to make ordering deterministic for the evaluator instead of relying solely on `t_offset_s`.

## Verdict: REQUEST_CHANGES

```json
{"verdict":"REQUEST_CHANGES","high":3,"med":5,"low":4}
```

---

<!-- chunk 15/16 -->
## Summary (2-4 sentences)

This PR adds only raw SMS smoke-eval artifacts (`glyph-worker/runs/smoke-eval-sms-2/raw/*.md`, batches 3–8 and 27–38) with no executable source changes. The dataset is useful for correctness tests, but several conversation fixtures are inconsistent with the security invariants they claim to exercise (non-allowlisted sender handling, opt-out gating, duplicate delivery idempotency and out-of-order timeline reconstruction). The main risks are test fidelity (assertions that could mask double-execution/replay), potential log leakage of fixture phone numbers and a few schema misuse items (system events carrying a `sender` field). These must be corrected before treating these fixtures as the oracle for a security-sensitive eval.

## Findings

1. [high] glyph-worker/runs/smoke-eval-sms-2/raw/batch-29.md:12-20: `scenario` states the non-allowlisted sender (+15559876543) "must be safely rejected." and `expected.reply_count=1` but the `turns` include `{"role":"assistant","text":"I can only respond to the registered owner on this number..." , ...}` (assistant reply to `sender:"unknown"`).  
   Fix: do not emit any `assistant` turn for `non_allowlisted_sender`; replace that assistant turn with only `system_event` blocks (e.g. `connector blocked ...`, audit event), set `expected.reply_count=0` and add `must_not:["assistant_reply_to_unknown","disclose_private_data"]`. This is a correctness+security invariant (prevents accidental disclosure and enforces the "no outbound reply to unknown sender" control).

2. [high] glyph-worker/runs/smoke-eval-sms-2/raw/batch-6.md:9-19: non-allowlisted sender (+15551234567) explicitly expects `reply_count=0` and system_event drops with "no reply queued", which matches the required control. However batch-29 directly contradicts it.  
   Fix: enforce a single invariant across all non-allowlisted_sender fixtures: `reply_count==0`, zero `role:"assistant"` turns for `sender!="owner"`, and `turns` must not include assistant text in response to unknown senders. Add an eval schema assertion `assistant_sender_must_be_owner == true`.

3. [high] glyph-worker/runs/smoke-eval-sms-2/raw/batch-28.md:38-46: `role:"system_event"` objects include `"sender":"owner"` (e.g. duplicate webhook events and carrier opt-out/opt-in events). System lifecycle events are not user-authored messages and must not be attributed to the owner.  
   Fix: remove `sender` from all `system_event` entries, or set `sender:"system"`. Also consider splitting `actor` vs `origin` (connector/carrier) to avoid polluting allowlist-based access control logic.

4. [high] glyph-worker/runs/smoke-eval-sms-2/raw/batch-35.md:6-13: duplicate_delivery fixture: `system_event` reports `duplicate webhook delivery ... ignored.` and then `assistant` replies again with `provider_message_id:"SM4852927bb10446d5b8b02b48079a4cfa"` and `"duplicate_of":"SM4852927bb10446d5b8b02b48079a4cfa"` (reusing the original message id for the assistant turn).  
   Fix: treat a duplicate webhook as idempotent: do not create a new action or re-emit an action-producing assistant reply; prefer `reply_count==1` (the original reply) and have the system_event record the drop with `result:"ignored_no_action"`, or return a safe cached read-only confirmation without reusing the inbound id to "re-send" an agent action. Add `must_not:["action_executed_twice","duplicate_action_id_created"]`.

5. [high] glyph-worker/runs/smoke-eval-sms-2/raw/batch-4.md:7-17 and batch-7.md:7-17: duplicate_delivery cases show `assistant` text emitted twice for the same `provider_message_id` (one original, one with `duplicate_of`) and expect `reply_count==2`.  
   Fix: for webhook-level duplicates (transport/replay), the oracle must assert at most one action result. If the reply is served from idempotency cache, represent that as `system_event` (cache hit) not as a second `role:"assistant"` turn, or change `expected.reply_count` to `1` and require `idempotency_key` equality. This directly tests replay safety (prevents tests from accepting double-execution).

6. [high] glyph-worker/runs/smoke-eval-sms-2/raw/batch-31.md:10-23: out_of_order scenario moves `t_offset_s:300` messages before `t_offset_s:5` (alarm updated at 300 before "set alarm for tomorrow" at 5). `expected` requires reconstruction.  
   Fix: add an explicit assertion in the eval (e.g. `must_not:["applied_future_intent_to_past_turn","replied_in_delivery_order"]`) and require the processor to sort by `t_offset_s` and by `provider_message_id` tie-breaker before intent resolution. Also consider including a `sequence_index` to detect gaps to avoid time skew abuse.

7. [med] glyph-worker/runs/smoke-eval-sms-2/raw/batch-31.md:25-39 and batch-5.md:6-19: approval_prompt fixtures use free-text affirmatives (`"Y"`, `"yes"`, `"Yes, go ahead."`).  
   Fix: constrain to an allowlist of exact confirmation tokens (e.g. `^Y$|^YES$` case-insensitive) and treat other values as rejection/no-op; update `expected` to reflect token gating and add `must_not:["approve_on_partial_text"]`. Also require the approval to be bound to the specific action id (target, count, recipients) before execution.

8. [med] glyph-worker/runs/smoke-eval-sms-2/raw/batch-36.md:6-19: provider_error_retry reuses the same `provider_message_id` (`SM56b8e4a207cd42ef9c2d70a1f8cae963`) for the retried assistant turn (`duplicate_of` that id).  
   Fix: distinguish transport retry (redelivery of the same outbound message) from action retry. Either (a) keep the outbound id stable for the message attempt but do not count as a new assistant turn in `reply_count` of the conversation action, or (b) use `attempt`/`retry_count` and `idempotency_key` (not conflating inbound `duplicate_of` with outbound retry). Add `must_not:["regen_reply_body_on_transport_retry"]`.

9. [med] glyph-worker/runs/smoke-eval-sms-2/raw/batch-33.md:21-31 and batch-5.md:21-41: opt_in_resume/opt_out sequencing: ensure the most recent carrier keyword wins and that outbound assistant replies are suppressed after `STOP` until a valid `START` from an allowlisted sender.  
   Fix: add state transition assertions (`state_after_stop == opted_out`, `outbound_blocked_until_optin == true`) and include `must_not:["send_while_opted_out"]` explicitly for the post-STOP window (batch-33 already has this in spirit; enforce it for any post-STOP turn set).

10. [med] glyph-worker/runs/smoke-eval-sms-2/raw/batch-34.md:7-12 and batch-6.md:9-19: `non_allowlisted_sender` fixtures use real-looking +E.164 numbers and `example.com`. For a PUBLIC PR of eval raw logs, treat these as non-sensitive fixtures but avoid committing any operational identifiers if they can be rotated.  
   Fix: prefer reserved/test ranges (e.g. +1555… is fine for smoke tests) and replace any internal hosts with `example.com` in `must_not`/event text if environment-dependent; also ensure no auth tokens/secrets appear (scan for `sk-`, `key=`, `Bearer `, webhook secrets). (No obvious secrets found here.)

11. [low] glyph-worker/runs/smoke-eval-sms-2/raw/batch-27.md onward (media_only cases): some `media_only` turns set `text:""` and rely on `system_event` only.  
   Fix: require `media_payload_present=true` and explicitly forbid inferring content; add `must_not:["ocr_inferred_without_confirmation"]` to those scenarios to prevent content leakage assumptions.

12. [low] glyph-worker/runs/smoke-eval-sms-2/raw/batch-28.md:23-36 and batch-37.md:6-13: `duplicate_delivery` + `help_keyword` combined fixtures: add a targeted assertion that HELP response is not duplicated and that the reminder action count remains 1.  
   Fix: add `action_counts.reminder_created == 1` to `expected` (or equivalent) to catch idempotency bugs explicitly.

## Verdict: REQUEST_CHANGES

```json
{"verdict":"REQUEST_CHANGES","high":6,"med":4,"low":2}
```

---

<!-- chunk 16/16 -->
## Summary (2-4 sentences)

This is a well-structured, fail-closed addition: a boundary guard that scans before any network call, a strict $0 price+spend guard, OpenAI-compatible streaming with per-chunk cost checks, content-based dataset validation/dedupe, chunked public-PR review, and a read-only build path. The "scan before prompt leaves machine", symlink denial, smoke-only runs allowlist, and git apply --check are all solid. The main gap is the `assigned-secret` regex only catching quoted values (misses `API_KEY=...`, `TOKEN: ...`, `export ...`), which can let unquoted secrets slip through a prompt. A few small correctness nits (out-of-order time check in the schema validator, and the spend baseline comparison comment) are also worth tightening.

## Findings

1. [high] src/guard.ts:32-37: `assigned-secret` requires the value to be quoted (`["'][^"'\s]{12,}["']`). Real prompts/config snippets often use `RESEND_API_KEY=re_...`, `export SLACK_TOKEN=xoxb-...`, or `token: abcdefghijklmnopqrstuvwxyz012345` (unquoted). With the current rule those are missed.  
   Fix: add an unquoted branch that matches `[:=]\s*[^\s"'`,;]{16,}` (or >=12 but prefer >=16 to reduce placeholder noise), and skip values that look like placeholders (`x{4,}|placeholder|test|example|fake|redacted|<[^>]*>`). Also consider `export\s+\w+\s*=\s*...`. Example:  
   `["assigned-secret", /\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*(?:"([^"\s]{12,})"|'([^'\s]{12,})'|([^\s"'`,;]{16,}))/gi]` and in the loop test the captured value(s) against `PLACEHOLDER` (if any non-empty token is a placeholder, ignore). Alternatively run a second scan on unquoted values with the same placeholder guard.

2. [med] src/dataset-schema.ts:25-39: When `edge_cases` includes `"out_of_order"`, the backwards-time check still compares each `t_offset_s` to the previous element and only skips pushing an error on that comparison, but it unconditionally does `prev = tt.t_offset_s` after the `else`. For a sequence like `[5, 2, 3]` with `out_of_order`, `2 < 5` is allowed (no error) and `prev` becomes `2`; `3 < 2` is true and `out_of_order` is set so the `if` does *not* push, but you still execute `prev = 3`. Also `[0, 10, 2, 3]` with out_of_order: `2<10` allowed -> `prev=2`, `3<2` is backwards relative to `2` and should not be treated as "allowed" just because the whole list is out-of-order. The flag means "the array order of turns is not chronological" — the validator must not enforce `t_offset_s >= prev` at all in that case.  
   Fix: if `out_of_order` is present, do not run the backwards comparison at all for that conversation (or only compare when you can establish a global chronological order). Minimal change:  
   `let prev = -1; const allowOO = (o.edge_cases as string[]).includes("out_of_order"); ... if (!allowOO && tt.t_offset_s < prev) e.push(\`turn ${i} time goes backwards\`); prev = tt.t_offset_s;` (still tracking prev is harmless but the test is skipped). Also ensure the check uses `>= -1` semantics.

3. [med] src/price-guard.ts:71-79: `spend()` treats any `used > baselineUsed + 1e-9` as "team total_used rose" and aborts. That’s correct for strict mode. However the baseline is captured on the first successful call to `/credits` after construction/check; if the team already spent between process start and first check, the run still aborts on first comparison? Also network errors from `/credits` propagate as `PriceGuardError("GET /credits returned ...")` — good. Consider logging `baselineUsed` only in the run artifact (never to stdout) and documenting that "any increase aborts". No code change required, but add a short comment above `spend()` stating the "non-decreasing or equal" invariant for this run.

4. [med] src/gateway.ts:47-57: Retry loop uses `fatal = err instanceof PriceGuardError || err instanceof BoundaryError || status===400||401||403`. Correct to not retry guard/policy failures. For 408/409/422 with `retry-after`, you don't special-case them (treat as non-fatal -> exponential+jitter) — that’s reasonable given the `withRetry`-style behavior is implicit. Also `lastErr` is assigned but if the loop never executes (maxAttempts<1, though you pass >=3) it could be undefined; not possible here. Minor.

5. [low] src/guard.ts:61: `email` rule blocks any address whose domain is not in `ALLOWED_EMAIL_DOMAIN` (RFC 2606 reserved + `users.noreply.github.com`). The guard.test.ts explicitly expects `someone@example.com` to be blocked — this is a deliberate "public-only prompts" policy. If any future synthetic content legitimately needs a non-reserved public domain, adjust `ALLOWED_EMAIL_DOMAIN`. For the current codebase (example.com only in dataset prompts), keep as-is but consider adding a one-line comment: "Only reserved/example domains allowed to prevent leaking real contact data into prompts."

6. [low] src/review.ts:46-56: For local diffs you enforce `isAllowedPath` on every touched path; for `--pr` you only check the repo is public and you don't re-check individual file paths against `GLYPH_PUBLIC_PATHS`. Since PR diffs are fetched from a public repo and you still `assertPublic` each file section's text, path-based allowlisting is less critical than the content guard. If you later support private mirrors, this should change. Add a brief comment in `runReview` noting that PR path filtering relies on "public repo + content guard".

## Verdict: REQUEST_CHANGES

```json
{"verdict":"REQUEST_CHANGES","high":1,"med":3,"low":2}
```