import { describe, expect, it, vi } from "vitest";
import { createConnectorRuntime } from "../../../packages/connector-kit/src/runtime.js";
import { slackSignature, verifySlackSignature } from "../../../packages/connector-kit/src/verify.js";
import { isAllowedSlackUser, makeSlackInbound, makeSlackInputResponse } from "../handlers.js";

const author = (userId: string, isBot = false) => ({ userId, userName: "u", fullName: "U", isBot, isMe: false });
const message = (text: string, userId = "U0OWNER") =>
  ({ text, markdown: text, ts: "1.1", threadTs: "1.1", channelId: "D1", teamId: "T1", author: author(userId), attachments: [], raw: {} }) as never;
const ctx = () => ({ reset: vi.fn(async () => ({ status: "reset" })), thread: { post: vi.fn(async () => ({})) } }) as never;

describe("slack", () => {
  it("allowlist: only listed humans", () => {
    expect(isAllowedSlackUser({ author: author("U0OWNER") }, ["U0OWNER"])).toBe(true);
    expect(isAllowedSlackUser({ author: author("U0OTHER") }, ["U0OWNER"])).toBe(false);
    expect(isAllowedSlackUser({ author: author("U0OWNER", true) }, ["U0OWNER"])).toBe(false);
    expect(isAllowedSlackUser({ author: undefined }, ["U0OWNER"])).toBe(false);
  });

  it("drops non-allowlisted senders without starting a turn", async () => {
    const h = makeSlackInbound(createConnectorRuntime(), ["U0OWNER"]);
    expect(await h(ctx(), message("hello", "U0OTHER"))).toBeNull();
  });

  it("/new resets the thread session and does not start a turn", async () => {
    const c = ctx() as unknown as { reset: ReturnType<typeof vi.fn>; thread: { post: ReturnType<typeof vi.fn> } };
    const h = makeSlackInbound(createConnectorRuntime(), ["U0OWNER"]);
    expect(await h(c as never, message("<@UBOT> /new"))).toBeNull();
    expect(c.reset).toHaveBeenCalledOnce();
  });

  it("dedupes Slack redeliveries of the same message", async () => {
    const c = ctx() as unknown as { reset: ReturnType<typeof vi.fn> };
    const h = makeSlackInbound(createConnectorRuntime(), ["U0OWNER"]);
    await h(c as never, message("/new"));
    await h(c as never, message("/new"));
    expect(c.reset).toHaveBeenCalledOnce();
  });

  it("HITL responses only from allowlisted users", async () => {
    const h = makeSlackInputResponse(createConnectorRuntime(), ["U0OWNER"]);
    const auth = { principalId: "U0OWNER" };
    const sub = (id: string) => ({ type: "block_actions", inputResponses: [], actions: [], user: { id } }) as never;
    expect(await h({ defaultAuth: auth } as never, sub("U0OTHER"))).toBeNull();
    expect(await h({ defaultAuth: auth } as never, sub("U0OWNER"))).toEqual({ auth });
  });

  it("slack v0 signature helper: valid, tampered, stale", () => {
    const now = 1_800_000_000, ts = String(now), body = "token=x&text=hi";
    const sig = slackSignature("test_secret", ts, body);
    expect(verifySlackSignature("test_secret", ts, body, sig, now)).toBe(true);
    expect(verifySlackSignature("test_secret", ts, body + "x", sig, now)).toBe(false);
    expect(verifySlackSignature("test_secret", ts, body, sig, now + 301)).toBe(false);
  });
});
