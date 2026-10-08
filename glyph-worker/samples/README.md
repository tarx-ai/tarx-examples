# Samples (synthetic)

`sms-conversations.sample.jsonl`: 20 synthetic multi-turn SMS conversations from the Oct 8, 2026 smoke run (`glyph-worker dataset --channel sms --n 20 --batch 5`).
- Produced by 4 parallel calls in 110 s wall time, at $0.
- 24 rows generated: 20 accepted, 0 rejected, 4 surplus dropped.
- Every row passed schema validation (`schemas/conversation.v1.json`), dedupe, and the boundary scan.
- A post-hoc check found 0 rows where `reply_count` disagreed with the number of assistant turns.

Coverage: none 4, duplicate_delivery 3, unicode_emoji 3, opt_out 2, help_keyword 2, opt_in_resume 2, long_context 2, non_allowlisted_sender 2, multi_segment 2, rapid_fire 2, out_of_order 1, media_only 1. Turns per conversation: 3–8 (mean 5.2).

All names, numbers, and message IDs are fictional. Rows are not reviewed for label correctness beyond the automated checks; treat `expected` as a draft.
