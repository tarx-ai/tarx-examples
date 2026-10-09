import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConversation, stableId, contentKey } from "../src/dataset-schema.ts";

const good = {
  schema: "tarx.conversation.v1", channel: "sms", scenario: "Owner asks for a reminder; webhook is delivered twice.",
  edge_cases: ["duplicate_delivery"],
  turns: [
    { role: "user", text: "remind me at 5 to call Sam", t_offset_s: 0, provider_message_id: "SM01", sender: "owner" },
    { role: "system_event", text: "duplicate webhook delivery of SM01", t_offset_s: 2, provider_message_id: "SM01", duplicate_of: "SM01" },
    { role: "assistant", text: "Got it: reminder at 5:00 PM to call Sam.", t_offset_s: 4 },
  ],
  expected: { agent_should: "Reply exactly once and ignore the duplicate delivery.", reply_count: 1, must_not: ["reply twice"] },
};

test("valid record passes; ids are stable content hashes", () => {
  assert.deepEqual(validateConversation(good, "sms"), []);
  assert.match(stableId(good as never), /^sms-[0-9a-f]{10}$/);
  assert.equal(contentKey(good as never), contentKey({ ...good, turns: good.turns.map((t) => ({ ...t, text: t.text.toUpperCase() + "  " })) } as never));
});

test("rejects schema violations", () => {
  assert.ok(validateConversation({ ...good, channel: "fax" }).includes("channel"));
  assert.ok(validateConversation({ ...good, extra: 1 }).some((e) => e.startsWith("unknown key")));
  assert.ok(validateConversation({ ...good, edge_cases: ["made_up"] }).includes("edge_cases"));
  assert.ok(validateConversation({ ...good, turns: [good.turns[0]] }).includes("turns length"));
  assert.ok(validateConversation({ ...good, turns: [good.turns[1], good.turns[0]] }).some((e) => e.includes("backwards")));
  assert.ok(validateConversation({ ...good, expected: { agent_should: "x", reply_count: -1 } }).length >= 2);
  assert.ok(validateConversation(good, "slack").includes("channel != slack"));
});
