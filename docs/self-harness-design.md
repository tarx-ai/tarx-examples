# TARX Self-Harness

Date: 2026-10-11. Research and design only. Weights stay frozen. No training in this document.

## Summary and recommendation

Self-Harness (Zhang et al., Shanghai AI Laboratory, [arXiv:2606.09498](https://arxiv.org/abs/2606.09498), v3, 20 Aug 2026, CC BY 4.0) is a loop that improves an agent by editing the harness around a frozen model. Three stages: weakness mining from traces that have a verifiable outcome, a proposer that emits diverse minimal edits each tied to one failure, and regression validation that promotes an edit only when held-in and held-out scores support it. The paper reports relative gains up to 132% across Terminal-Bench-2.0, SWE-bench Verified, and AppWorld. The public code is [qzzqzzb/Self-Harness](https://github.com/qzzqzzb/Self-Harness). VentureBeat’s 22 June 2026 headline (“up to 60%”) is the earlier relative reading; the v3 abstract is the number to cite. See [VentureBeat](https://venturebeat.com/ai/researchers-introduce-self-harness-a-framework-that-lets-ai-agents-rewrite).

TARX should copy the loop shape and not the paper’s runtime. The proposer is the resident model already serving `127.0.0.1:11449`. No outside model sees traces. Harness text lives in git. Promotion is a human merge. Rollback is `git revert`.

Recommended stack, all local:

| Piece | Choice | Why |
|---|---|---|
| Harness store | Git files under a future `harness/` tree in this repo | Diffable, reviewable, revertible |
| Task set | Synthetic email rows already on disk | Verifiable expected fields, no customer mail |
| Runner | A small local script, Promptfoo-shaped (MIT) if we adopt a runner | Offline, CI, no hosted judge |
| Optimizer | Do not adopt DSPy/GEPA/TextGrad for v1 | They want many model calls and often a stronger proposer |
| Traces | Local JSONL only | Datadog and Phoenix both move or license data the wrong way |
| Locked gate | `evidence-gate.ts` stays outside the editable set | The loop may only preserve or tighten it |

The paper’s own repo has one commit, no `LICENSE` file in the tree listing, and harnesses aimed at Terminal-Bench. Treat it as a specification, not a dependency.

## Current harness map

Checked 2026-10-11 against the live machine and this repo at `5cd7298` (`origin/main`).

| Surface | Where it lives | Owner | Versioning today |
|---|---|---|---|
| Session evidence rule | `tarx-cli` `daemon/always-on/session-prompt.md` and `~/.tarx/always-on/session-prompt.md` | CLI / Always On | Git on the CLI flywheel branch; the home copy is a loose file |
| Chat system prefix | `tarx-cli` `daemon/bin/tarx-chat-ui.py` `system_text` | CLI | Git describe of `tarx-cli` (`v1.1.0-38-gc46dc5b` at last check) |
| Tool choice inside the evidence gate | `supercomputer-n1-s0` `src/supercomputer/evidence-gate.ts` `toolsFor` | Gateway | Worktree source. Not in `tarx-examples`. Locked for this design |
| Stream buffering and stdout append | Same file, `evidenceGate`. Gateway calls it on stream and non-stream completions | Gateway | Same. Header `x-tarx-evidence-gate: buffered` |
| Upstream and model id | launchd `com.tarx.supercomputer.gateway` env `TARX_GATEWAY_UPSTREAM`, `TARX_GATEWAY_UPSTREAM_MODEL` | Ops plist | Not in git. Live upstream `http://127.0.0.1:11449` |
| Fused server | launchd `com.tarx.supercomputer.evidence-mlx` → `mlx_lm.server` on `127.0.0.1:11449` | Ops plist | Weights directory `~/.tarx/models/evidence-lora-v1-fused`. Base GGUF file untouched |
| Approval and effects | This repo `src/integration-policy.ts` (`approvalFor`: read is automatic, write/delete/publish and `sensitive` need user approval) and `src/integration-adapter.ts` | tarx-examples | Git. Locked. Self-Harness must not weaken `approvalFor` |
| Channel examples | `examples/slack-channel`, `github-channel`, `linear-channel` | tarx-examples | Git. README-level retry notes only. No email harness file in this checkout |
| Connector eval worker | `/tmp/tarx-examples-pr4/glyph-worker` (not in `origin/main`) | Glyph / Kiro datasets | Run directories, not a released package |
| Negative fabrication log | `~/.tarx/always-on/negative-examples.jsonl` | Gateway gate | Append-only local file. Mode 600 as of this pass (was 644) |
| Preference pairs | `~/.tarx/always-on/preference-evidence-v1.jsonl` (76 lines) | Local training corpus | Same. Mode 600. Not a harness. Do not feed it to a non-local model |
| MCP connector record | `~/.tarx/mcp/connectors.json` | CLI and local preview | Local JSON, schema `tarx.mcp.connectors.v1` |
| Route health | `~/.tarx/always-on/route-health.json`, written by gateway `GET /health` | Gateway | Local JSON, schema `tarx.route_health.v1` |
| Verification contract (docs) | `docs/verification.md` | tarx-examples | Git. States source → typechecked → live-verified → upstream-validated |

Retry and timeout policy is split and thin. The evidence gate’s tool exec timeout is 8 seconds (`exec` `timeout: 8000` in `evidence-gate.ts`). Connector READMEs mention retry as a test case. There is no shared retry budget, no duplicate-command forbid, and no “recreate missing artifact” rule in this repo. Memory for chat is the CLI agent history under `~/.tarx/agents/`, not a versioned context policy.

Eve connectors (email via Resend as howdy@tarx.com, Slack, SMS) run on the machine behind ngrok Mode B. They are not the files in `examples/` on `main`. Glyph’s worker under `/tmp/tarx-examples-pr4/glyph-worker` is the place the synthetic datasets were written.

## Trace and eval gaps

What exists:

| Trace | What a row holds | Verifiable outcome |
|---|---|---|
| `smoke-eval-email/dataset.jsonl` | 200 rows, schema `tarx.conversation.v1`: `id`, `channel`, `scenario`, `edge_cases`, `turns`, `expected` (`agent_should`, `reply_count`, and further must-fields) | Expected behavior is text in the row. A grader can check reply count, threading, and “do not send a duplicate.” Synthetic, not customer mail |
| `smoke-eval-email/calls.jsonl` | 41 rows. Glyph call telemetry: `session`, `task`, `status`, `ttft_ms`, `total_ms`, token counts, `model` | `status: ok` is a generation success, not a task success |
| `smoke-eval-email/rejects.jsonl` | 6 rows | Reject reasons, small |
| `smoke-dataset-sms/dataset.jsonl` | **20 rows**, not 200 | Same schema family. Too small to split |
| `smoke-eval-sms/dataset.jsonl` | 48 rows | Same |
| `smoke-eval-slack/dataset.jsonl` | 200 rows | Same schema, Slack |
| `negative-examples.jsonl` | 5 lines. Fabricated tool-like claims the gate rejected | Binary: fabrication logged. No task id, no holdout split |
| Gateway `/health` | `upstream`, `upstream_healthy`, `upstream_models`, `route_health`, `metrics` | Process health only |
| Datadog | Glyph rows are tagged `ddsource: glyph-worker`. Connector `turn_ms` is still not emitting (standing stress: Eve down, email inbound not live) | No per-turn pass/fail for the live agent |

Self-Harness needs, and we do not have:

- A deterministic verifier that scores a turn against `expected` without asking another model.
- A frozen held-out split. The 200 email rows are one file. Nothing marks train versus holdout.
- A regression suite that re-runs the previous harness on the same ids.
- Traces of the live fused upstream. `calls.jsonl` records Glyph dataset generation, not gateway turns.
- A harness id on each trace. Today a row cannot name which prompt, tool list, or retry rule produced it.

Starting task set for the MVP: the 200 email rows. Split once, by id hash, 160 develop / 40 holdout, and write the split file into git so it cannot drift. SMS stays a later channel. Do not treat the 20-row SMS dataset as a 200-row set.

## Tooling comparison

Licenses checked against public repos and the October 2026 survey [LLM Evaluation Tools 2026](https://vdf.ai/blog/llm-evaluation-tools/) (VDF AI, 6 Oct 2026). Local/offline means the optimizer and the traces stay on this Mac.

| Tool | License | Maturity | Local / offline | Fit for the resident model |
|---|---|---|---|---|
| [Self-Harness code](https://github.com/qzzqzzb/Self-Harness) | No LICENSE file in the repo listing | One commit. README, diagnosis, proposer, eval, one Qwen TB2 harness | Designed to be local. Not packaged | Spec only. Their harness targets Terminal-Bench, not email |
| [DeepAgents](https://github.com/langchain-ai/deepagents) | MIT | Active LangChain harness SDK | Can point at an OpenAI-compatible base URL | A runtime, not an optimizer. Optional later. Not required for v1 |
| [DSPy](https://github.com/stanfordnlp/dspy) MIPROv2 and [GEPA](https://github.com/gepa-ai/gepa) | MIT | DSPy is the active prompt compiler. GEPA is MIT and reflects over traces | Local if the LM client is local. Call volume is high | GEPA’s usual setup uses a strong reflector. That violates “no outside model sees traces” unless the reflector is `:11449` |
| [TextGrad](https://github.com/zou-group/textgrad) | MIT | Quiet since mid-2025 (0.1.8) | Local possible | Research. Do not depend on it |
| OPRO-style | Paper method, no single library | Old | Local possible | Superseded here by the three-stage loop |
| [Promptfoo](https://github.com/promptfoo/promptfoo) | MIT. 0.124.0 on 6 Oct 2026 | Production eval and red-team CLI | Offline and CI. No hosted scoring required | Good grader shell if we keep assertions deterministic |
| [AdalFlow](https://github.com/SylphAI-Inc/AdalFlow) | Apache-2.0 | Smaller than DSPy | Local | Extra framework. Skip |
| [OpenHands](https://github.com/OpenHands/OpenHands) | MIT | Software-agent harness | Heavy, often cloud sandbox | Wrong shape for email turns |
| [SWE-agent](https://github.com/SWE-agent/SWE-agent) | MIT | Benchmark agent | Local with a sandbox | Same. Not conversational channels |
| Terminal-Bench 2 + [Harbor](https://github.com/harbor-framework/terminal-bench) | Apache-2.0 | The paper’s terminal harness | Local containers | Use as a citation, not a TARX runner |
| [tau-bench](https://github.com/sierra-research/tau-bench) | MIT | Tool-agent bench with a user simulator | Needs a judge model | Simulator would have to be local. Defer |
| [Inspect AI](https://github.com/UKGovernmentBEIS/inspect_ai) | MIT. 0.3.276 on 2 Oct 2026 | UK AISI eval runner | Local | Strong later, if Kiro wants a standard runner. Heavier than v1 |
| OpenTelemetry GenAI semconv | Spec ([OTel GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/)) | Conventions, not storage | Local collector possible | Adopt field names in our JSONL. Do not stand up a collector in week 1 |
| [Langfuse](https://github.com/langfuse/langfuse) | MIT core. ClickHouse, Jan 2026 | Mature self-host | Self-host is still another service and a database | Skip until traces exist and stay on-box by policy |
| [Arize Phoenix](https://github.com/Arize-ai/phoenix) | Elastic License 2.0 | Active | Self-host, source-available, not OSI | Reject. License is the wrong shape |
| Datadog LLM Observability | Proprietary, us5 | Already the intended turn-timing sink | Data leaves the machine | Keep for ops counters only. Out of the optimization loop |
| [Meta-Harness](https://github.com/stanford-iris-lab/meta-harness) | MIT | Research | Uses a stronger external optimizer | Reject. Traces must not leave, and the proposer is the local model |
| [auto-harness](https://github.com/neosigmaai/auto-harness) and Harness-of-Harness ([arXiv:2609.01481](https://arxiv.org/abs/2609.01481)) | Research, 2026 | Early | Varies | Watch. Do not adopt |

## Loop design

Harness-as-code, once a follow-up ticket adds it (not in this PR):

```text
harness/email/system.md          # editable instructions
harness/email/tools.json         # tool list and descriptions
harness/email/runtime.json       # retry budget, timeouts, duplicate-command rule
harness/email/memory.md          # what may enter the next turn
harness/email/verify.md          # recovery steps the agent is allowed to take
harness/email/LOCKS.md           # pointers at files the loop must not edit
harness/splits/email-v1.json     # 160 / 40 id lists
```

`LOCKS.md` names `evidence-gate.ts`, `integration-policy.ts`, send and approval gates, and secret handling. A proposal that diffs a lock path is discarded before scoring.

Trace schema, one JSON object per turn, local file mode 600. Field names follow OTel GenAI where they match (`gen_ai.request.model` stored as `model_id` locally, without writing the public product name into user-facing copy). Required:

- `trace_id`, `harness_git_sha`, `channel` (`email`), `task_id`
- `split` (`develop` or `holdout`)
- `tool_calls[]` with name, args hash, exit, stdout length (not raw secrets)
- `outcome`: `pass` or `fail` plus `failure_class`
- `gate`: `buffered`, `appended_stdout`, `rejected_fabrication`
- `latency_ms`

No message body from a real person. No secrets, no tarx-internal paths, no Bridge rows, no `tarx.db`. Synthetic task text from the dataset file is allowed because we authored it.

Failure taxonomy for a conversational turn:

| Class | Meaning | Email verifier |
|---|---|---|
| `wrong_tool` | Called a tool the scenario does not allow, or skipped the one it requires | Tool name set versus `expected` |
| `loop` | Same tool and same args repeated | Retry budget in `runtime.json` |
| `premature_done` | Stopped before the required reply | `reply_count` |
| `context_rot` | Answer ignores an earlier turn that the scenario depends on | Slot checks against `turns` |
| `channel_format` | Subject/threading broken, or a body that would blow an SMS limit on a later channel | Thread id present; SMS length cap stays out of the email MVP |
| `narration_without_action` | Says the send happened with no tool result | Gate already covers fabricated stdout. Verifier checks a real send stub result |
| `fabricated_evidence` | Hash, health JSON, or command text not in tool stdout | Existing evidence gate. Fail closed |
| `duplicate_side_effect` | Second send of the same reminder | `edge_cases` contains `duplicate_delivery` |

Proposer: one completion against `127.0.0.1:11449` through the gateway so the evidence gate still wraps the call. Input is a redacted failure cluster (class, counts, harness diff context). Output is a unified diff touching one editable file and one failure class. Kiro rejects diffs that touch a lock, that mix two classes, or that do not parse.

Acceptance, copied from the paper and tightened:

1. Score the candidate on the 160 develop ids. Target metric is verifier pass rate.
2. Score the same candidate on the 40 holdout ids.
3. Promote only when develop pass rate rises by at least 2 points and holdout pass rate does not fall by more than 0 points (no regression).
4. A human (Kiro QA gate, founder on outbound) approves the merge.
5. Rollback is `git revert` of that harness commit. The gateway plist and the fused weights do not change.

The evidence gate is not a candidate edit. A harness that tells the model to skip tools, hide stdout, or speak unverified hashes is a failed proposal even if the email verifier goes up.

## Safety boundaries

Out of scope, and a proposal that edits them is invalid:

- `evidence-gate.ts` behavior: buffer the stream, append tool stdout, replace unproven claims. Edits may only preserve or tighten this.
- `approvalFor` and any send/approval gate. Write, delete, and publish stay user-approved.
- Secret handling, data-boundary filters, and credential files.
- The base GGUF. The fused LoRA on `:11449` is the live upstream and is not a training target of this loop.

Traces used by any non-local model must not contain private data, secrets, tarx-internal material, supercomputer paths, Bridge state, or `tarx.db`. The v1 proposer is local, so this rule is the reason we do not “just try GEPA in the cloud.”

High-stakes domains stay human-approved even after a harness promotion: legal, medical, money, and any outbound send. The email MVP scores a stub sender. It does not send mail.

## MVP plan (two weeks, email only)

Baseline to beat: pass rate of today’s harness (session prompt plus the live evidence gate, no new email rules) on the frozen 40-id holdout. Measure it in week 1 before any edit. That number is the bar. Do not cite the paper’s 18% → 36.7% Terminal-Bench table as our baseline.

| Day | Work | Owner |
|---|---|---|
| 1–2 | Freeze the 160/40 split. Write the deterministic email grader for `reply_count`, duplicate-delivery, and thread fields. Record the baseline on both splits | Kiro (datasets, evals, QA) |
| 3–4 | Add `harness/email/*` as a copy of the rules the gateway and CLI already apply. Tag traces with `harness_git_sha`. Mode 600 JSONL under `~/.tarx/always-on/self-harness/` | Grok Build |
| 5 | One dry proposer call on a single redacted `duplicate_delivery` cluster. Confirm the diff does not touch locks and the gate still returns `buffered` | Grok Build proposes, Kiro rejects or accepts the diff shape |
| 6–8 | Run at most three proposal rounds. Each round: mine, propose ≤4 diffs, score develop then holdout, discard regressions | Kiro scores. Grok Build runs the local proposer |
| 9 | Human review of the surviving diff. Merge only with explicit approval | Kiro QA, founder if the diff mentions a send |
| 10 | Rollback drill: revert the harness commit, re-score 10 holdout ids, confirm the baseline returns | Grok Build executes, Kiro signs the numbers |

Metrics:

- Primary: holdout verifier pass rate.
- Guardrail: develop pass rate, fabrication count in `negative-examples.jsonl`, evidence-gate reject count.
- Cost: zero tokens off-box. On-box, a full pass is 200 completions. At the observed Glyph email call size (~50 s, not the live fused server), 200 rows is on the order of 3 hours if serialized. The fused server is the proposer and the candidate runner, so budget one Mac-day per full develop+holdout rescore and do not run rounds in parallel with other heavy local jobs. Proposer calls are a handful per round, not the cost. Latency added to a user turn is zero until a promoted harness file is loaded. The gate’s 8 s tool cap stays.

Grok Build owns the design, the harness files, and the local proposer wiring. Kiro owns the dataset split, the grader, the QA gate, and the decision to promote. This PR does not implement the loop.

## Hygiene notes

Checked this session. No high-value process was restarted. `:11445` was not booted.

- launchd `com.tarx.supercomputer.evidence-mlx` is `running`, pid 30670, program `mlx_lm.server`, listening on `127.0.0.1:11449`.
- Gateway `GET /health` reports `upstream` `http://127.0.0.1:11449` and `upstream_healthy` true.
- `evidence-gate.ts` still runs tools, buffers the decision, and appends stdout when the model text is kept (`evidenceGate` returns prose plus stdout). Fabrications still append to `negative-examples.jsonl`.
- `negative-examples.jsonl` (5 lines) and `preference-evidence-v1.jsonl` (76 lines) were mode 644 (world-readable). Both are now mode 600. Behavior of readers is unchanged. The files are not in git.

## Open questions

1. Email inbound is not live (Eve down, `turn_ms` not emitting). The MVP can score synthetic rows without Eve. A live send test is a later ticket and stays human-approved.
2. Should the editable email instructions live in `tarx-examples` or `tarx-cli`? This design puts the versioned harness next to the adapter contract. The CLI session prompt would become a generated or copied file, not a second source of truth.
3. The gateway evidence gate is in the supercomputer worktree, not this repo. Locking it means a path outside the harness diff, which the proposer must be told explicitly.
4. Is a 0-point holdout regression cap too tight for a 40-row set (one miss is 2.5 points)? Kiro should confirm the cap before round 1. The paper required held-out improvement, which is stricter.
5. Promptfoo versus a 100-line local grader: Kiro picks at the week-1 grader task. Either way the assertions stay deterministic.
6. Glyph `calls.jsonl` names a dataset model. Those rows are not evidence about the fused upstream. Do not mix them into the baseline.

## Sources

- Zhang et al., Self-Harness: Harnesses That Improve Themselves, arXiv:2606.09498v3, 20 Aug 2026. https://arxiv.org/abs/2606.09498 https://arxiv.org/html/2606.09498v3 License CC BY 4.0.
- Code: https://github.com/qzzqzzb/Self-Harness
- VentureBeat, 22 June 2026: https://venturebeat.com/ai/researchers-introduce-self-harness-a-framework-that-lets-ai-agents-rewrite
- Harbor / Terminal-Bench: https://github.com/harbor-framework/terminal-bench
- DSPy: https://github.com/stanfordnlp/dspy
- GEPA: https://github.com/gepa-ai/gepa
- TextGrad: https://github.com/zou-group/textgrad
- Promptfoo: https://github.com/promptfoo/promptfoo
- AdalFlow: https://github.com/SylphAI-Inc/AdalFlow
- OpenHands: https://github.com/OpenHands/OpenHands
- SWE-agent: https://github.com/SWE-agent/SWE-agent
- tau-bench: https://github.com/sierra-research/tau-bench
- Inspect AI: https://github.com/UKGovernmentBEIS/inspect_ai
- OpenTelemetry GenAI semantic conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- Langfuse: https://github.com/langfuse/langfuse
- Arize Phoenix (Elastic License 2.0): https://github.com/Arize-ai/phoenix
- Meta-Harness: https://github.com/stanford-iris-lab/meta-harness
- Harness-of-Harness, arXiv:2609.01481: https://arxiv.org/abs/2609.01481
- Evaluation-tool license survey, 6 Oct 2026: https://vdf.ai/blog/llm-evaluation-tools/
- DeepAgents: https://github.com/langchain-ai/deepagents
