# Email harness proposal 001

Status: not applied. Kiro or a human reviews this before any promotion.

## Proposer

- Model server: fused weights on `127.0.0.1:11449`
- Completion: `chatcmpl-f921185f-16db-4d4f-899b-3a8f3834c125`
- Call path: upstream `/v1/chat/completions` on that port
- Holdout ids were not in the prompt

## Input

Train split only, from `harness/splits/email-v1.json`: 160 ids.

Edge counts on those ids: threading 48, long_context 30, none 30, duplicate_delivery 24, unicode_emoji 15, rapid_fire 13, ambiguous_request 13, media_only 12, provider_error_retry 12, non_allowlisted_sender 11, approval_prompt 11, out_of_order 9, opt_out 4, opt_in_resume 4.

Gateway turns in `docs/traces/gateway-turns.jsonl` (no message bodies):

| Turn | Gate | Tool stdout | Pre-gate text |
|---|---|---|---|
| `chatcmpl-4f7e6cc1-5a59-4e73-94eb-80310661ec34` | `header_absent` | y | null |
| `chatcmpl-a5f0f5c0-b2dd-4f22-9b3d-8c0a5c0fb490` | `buffered` | y | null |
| `chatcmpl-956f74e3-9882-4401-a487-fb9b8827685e` | `appended_stdout` | y | 11 characters |

## Failure mode

`appended_stdout`. On the one turn that recorded pre-gate text, the model stopped after a short proof line and the gateway appended tool stdout.

## Proposal

NO EDIT.

The proposer completion was the proof line only. It did not name a file, a rule, or a diff. Nothing in `harness/email/` was added or changed. The evidence gate, approval gates, and secrets were not in the requested edit set.

## Review

Do not promote. A later pass may propose again only against the train split, and only with a diff a reviewer can apply by hand.
