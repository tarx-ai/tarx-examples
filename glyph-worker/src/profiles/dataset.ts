import type { WorkerConfig } from "../config.ts";
import { scanText } from "../guard.ts";
import type { GlyphClient } from "../gateway.ts";
import type { RunLog } from "../log.ts";
import { fenced } from "../extract.ts";
import { EDGE_CASES, contentKey, stableId, validateConversation, type Channel, type ConversationV1 } from "../dataset-schema.ts";
import { mapLimit } from "../pool.ts";

const CHANNEL_NOTES: Record<Channel, string> = {
  sms: "SMS via a Twilio number: short plain-text messages, no markdown, replies <= 320 chars ideally (1600 max), STOP/HELP/START keywords are carrier-level, duplicates arrive with the same MessageSid (provider_message_id like SM + 32 hex).",
  slack: "Slack DMs and @mentions: threads (thread = parent ts like 1700000000.000100), mrkdwn allowed, Events API retries deliver the same event (provider_message_id like Ev0123ABCD).",
  email: "Email via Resend: subject lines, quoted replies, threading via Message-ID/References (thread = root message id like <abc@example.com>), longer messages, signatures.",
};

const SYSTEM = `You generate SYNTHETIC test data for an open-source messaging connector framework where an owner talks to a personal
AI assistant ("the agent") over SMS, Slack, or email. Everything must be fictional: use only example.com emails, +1555 phone numbers,
generic first names, no real companies, no real URLs other than example.com. Output ONLY JSON Lines inside one \`\`\`jsonl block:
one JSON object per line, no comments, no trailing commas.`;

function prompt(channel: Channel, count: number, focus: string[], batch: number): string {
  return `Generate ${count} distinct multi-turn ${channel.toUpperCase()} conversations (batch ${batch}).
Channel notes: ${CHANNEL_NOTES[channel]}
Each line must match this shape exactly (no extra keys):
{"schema":"tarx.conversation.v1","channel":"${channel}","scenario":"<one sentence>","edge_cases":[<from list>],
 "turns":[{"role":"user|assistant|system_event","text":"...","t_offset_s":0,"provider_message_id":"optional","thread":"optional","duplicate_of":"optional","sender":"owner|unknown (optional)"}],
 "expected":{"agent_should":"<what a correct agent/connector does>","reply_count":<int>,"must_not":["optional"]}}
Allowed edge_cases: ${EDGE_CASES.join(", ")}.
Focus this batch on: ${focus.join(", ")} (one or two per conversation; at least one conversation with "none").
Rules: 3-12 turns each; t_offset_s non-decreasing (unless out_of_order); system_event turns describe connector events
(e.g. "duplicate webhook delivery of SM...", "carrier opt-out confirmation sent"); duplicates repeat the same provider_message_id
and set duplicate_of; reply_count = number of assistant replies the connector should actually send. Vary tasks (reminders,
quick questions, scheduling, summaries, follow-ups), tone, and length. Do not repeat scenarios.`;
}

export interface DatasetInput { channel: Channel; n: number; batchSize: number; }

export async function runDataset(cfg: WorkerConfig, client: GlyphClient, log: RunLog, input: DatasetInput) {
  const guardOpts = { allowedLocalPorts: cfg.allowedLocalPorts, denyTerms: cfg.denyTerms };
  const pool = EDGE_CASES.filter((e) => e !== "none" && !(input.channel !== "sms" && ["opt_out", "opt_in_resume", "help_keyword", "multi_segment"].includes(e)) && !(input.channel === "sms" && e === "threading"));
  const accepted = new Map<string, ConversationV1>();
  const rejects: Array<{ reason: string; line: string }> = [];
  let batchNo = 0, generated = 0, surplus = 0;

  for (let round = 0; round < 2 && accepted.size < input.n; round++) {
    const need = input.n - accepted.size;
    const batches = Math.ceil(need / input.batchSize);
    const jobs = Array.from({ length: batches }, () => { const b = batchNo++; return { b, focus: [pool[(b * 3) % pool.length]!, pool[(b * 3 + 1) % pool.length]!, pool[(b * 3 + 2) % pool.length]!], count: Math.min(input.batchSize + 1, need) }; });
    const results = await mapLimit(jobs, cfg.concurrency, (j) => client.chat({ task: `dataset.${input.channel}.b${j.b}`, temperature: 0.9, maxTokens: 24_000, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt(input.channel, j.count, j.focus, j.b) }] }));
    results.forEach((r, i) => {
      if (r.status === "rejected") { rejects.push({ reason: `call failed: ${String((r.reason as Error)?.message).slice(0, 200)}`, line: "" }); return; }
      log.artifact(`raw/batch-${jobs[i]!.b}.md`, r.value.content);
      const body = fenced(r.value.content, "jsonl") ?? fenced(r.value.content, "json") ?? r.value.content;
      for (const line of body.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"))) {
        generated++;
        let obj: ConversationV1;
        try { obj = JSON.parse(line); } catch { rejects.push({ reason: "invalid JSON", line: line.slice(0, 200) }); continue; }
        const errs = validateConversation(obj, input.channel);
        if (errs.length) { rejects.push({ reason: `schema: ${errs.slice(0, 4).join("; ")}`, line: line.slice(0, 200) }); continue; }
        const findings = scanText(JSON.stringify(obj), guardOpts); // model output must also be public-safe
        if (findings.length) { rejects.push({ reason: `boundary: ${[...new Set(findings.map((f) => f.rule))].join(",")}`, line: "<redacted>" }); continue; }
        const key = contentKey(obj);
        if ([...accepted.values()].some((a) => contentKey(a) === key)) { rejects.push({ reason: "duplicate", line: line.slice(0, 120) }); continue; }
        const rec: ConversationV1 = { schema: "tarx.conversation.v1", id: stableId(obj), channel: obj.channel, scenario: obj.scenario, edge_cases: obj.edge_cases, turns: obj.turns, expected: obj.expected };
        if (accepted.size < input.n) accepted.set(key, rec); else surplus++;
      }
    });
  }

  const records = [...accepted.values()];
  const coverage: Record<string, number> = {};
  for (const r of records) for (const e of r.edge_cases) coverage[e] = (coverage[e] ?? 0) + 1;
  const turns = records.map((r) => r.turns.length);
  const report = {
    channel: input.channel, requested: input.n, generated, accepted: records.length, rejected: rejects.length, surplusDropped: surplus,
    // Semantic consistency warnings (rows are kept; reviewers decide).
    replyCountMismatch: records.filter((r) => r.expected.reply_count !== r.turns.filter((t) => t.role === "assistant").length).map((r) => r.id),
    duplicateTagWithoutRef: records.filter((r) => r.edge_cases.includes("duplicate_delivery") && !r.turns.some((t) => t.duplicate_of)).map((r) => r.id),
    rejectReasons: rejects.reduce<Record<string, number>>((a, r) => { const k = r.reason.split(":")[0]!; a[k] = (a[k] ?? 0) + 1; return a; }, {}),
    edgeCaseCoverage: coverage, turnsMin: Math.min(...turns), turnsMax: Math.max(...turns), turnsMean: turns.length ? +(turns.reduce((a, b) => a + b, 0) / turns.length).toFixed(1) : 0,
  };
  log.artifact("dataset.jsonl", records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));
  log.artifact("rejects.jsonl", rejects.map((r) => JSON.stringify(r)).join("\n"));
  log.artifact("report.json", report);
  return report;
}
