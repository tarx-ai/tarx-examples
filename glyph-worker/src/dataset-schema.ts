import { createHash } from "node:crypto";

export const EDGE_CASES = ["none", "duplicate_delivery", "opt_out", "help_keyword", "opt_in_resume", "threading", "long_context", "non_allowlisted_sender", "unicode_emoji", "multi_segment", "rapid_fire", "out_of_order", "media_only", "approval_prompt", "provider_error_retry", "ambiguous_request"] as const;
export type Channel = "sms" | "slack" | "email";
export interface Turn { role: "user" | "assistant" | "system_event"; text: string; t_offset_s: number; provider_message_id?: string; thread?: string; duplicate_of?: string; sender?: "owner" | "unknown"; }
export interface ConversationV1 { schema: "tarx.conversation.v1"; id: string; channel: Channel; scenario: string; edge_cases: string[]; turns: Turn[]; expected: { agent_should: string; reply_count: number; must_not?: string[] }; }

const TURN_KEYS = new Set(["role", "text", "t_offset_s", "provider_message_id", "thread", "duplicate_of", "sender"]);
const str = (v: unknown, max: number, min = 0) => typeof v === "string" && v.length >= min && v.length <= max;

/** Validates against schemas/conversation.v1.json (hand-written to keep zero runtime deps). Returns error strings. */
export function validateConversation(x: unknown, channel?: Channel): string[] {
  const e: string[] = [];
  if (!x || typeof x !== "object" || Array.isArray(x)) return ["not an object"];
  const o = x as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["schema", "id", "channel", "scenario", "edge_cases", "turns", "expected"].includes(k)) e.push(`unknown key ${k}`);
  if (o.schema !== "tarx.conversation.v1") e.push("schema");
  if (!["sms", "slack", "email"].includes(o.channel as string)) e.push("channel");
  if (channel && o.channel !== channel) e.push(`channel != ${channel}`);
  if (o.id !== undefined && !/^(sms|slack|email)-[0-9a-f]{10}$/.test(String(o.id))) e.push("id");
  if (!str(o.scenario, 200, 8)) e.push("scenario");
  if (!Array.isArray(o.edge_cases) || o.edge_cases.some((c) => !(EDGE_CASES as readonly string[]).includes(c as string)) || new Set(o.edge_cases).size !== o.edge_cases.length) e.push("edge_cases");
  if (!Array.isArray(o.turns) || o.turns.length < 2 || o.turns.length > 40) e.push("turns length");
  else {
    let prev = -1;
    o.turns.forEach((t: unknown, i: number) => {
      const tt = t as Record<string, unknown>;
      if (!tt || typeof tt !== "object") { e.push(`turn ${i}`); return; }
      for (const k of Object.keys(tt)) if (!TURN_KEYS.has(k)) e.push(`turn ${i} unknown key ${k}`);
      if (!["user", "assistant", "system_event"].includes(tt.role as string)) e.push(`turn ${i} role`);
      if (!str(tt.text, 4000)) e.push(`turn ${i} text`);
      if (typeof tt.t_offset_s !== "number" || tt.t_offset_s < 0) e.push(`turn ${i} t_offset_s`);
      else if (tt.t_offset_s < prev && !(o.edge_cases as string[] | undefined)?.includes("out_of_order")) e.push(`turn ${i} time goes backwards`);
      else prev = tt.t_offset_s as number;
      for (const k of ["provider_message_id", "thread", "duplicate_of"]) if (tt[k] !== undefined && !str(tt[k], 64)) e.push(`turn ${i} ${k}`);
      if (tt.sender !== undefined && !["owner", "unknown"].includes(tt.sender as string)) e.push(`turn ${i} sender`);
    });
    if (o.channel === "sms" && o.turns.some((t: Record<string, unknown>) => t.role === "assistant" && String(t.text).length > 1600)) e.push("sms reply > 1600 chars");
  }
  const ex = o.expected as Record<string, unknown> | undefined;
  if (!ex || typeof ex !== "object") e.push("expected");
  else {
    for (const k of Object.keys(ex)) if (!["agent_should", "reply_count", "must_not"].includes(k)) e.push(`expected unknown key ${k}`);
    if (!str(ex.agent_should, 400, 8)) e.push("expected.agent_should");
    if (!Number.isInteger(ex.reply_count) || (ex.reply_count as number) < 0 || (ex.reply_count as number) > 40) e.push("expected.reply_count");
    if (ex.must_not !== undefined && (!Array.isArray(ex.must_not) || ex.must_not.length > 8 || ex.must_not.some((m) => !str(m, 200)))) e.push("expected.must_not");
  }
  return e;
}

/** Content hash over channel + normalized turn text (dedupe key and stable id). */
export function contentKey(c: Pick<ConversationV1, "channel" | "turns">): string {
  const norm = c.turns.map((t) => `${t.role}:${t.text.toLowerCase().replace(/\s+/g, " ").trim()}`).join("\n");
  return createHash("sha256").update(`${c.channel}\n${norm}`).digest("hex");
}
export const stableId = (c: Pick<ConversationV1, "channel" | "turns">) => `${c.channel}-${contentKey(c).slice(0, 10)}`;
