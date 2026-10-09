import { defaultSlackAuth, type SlackInboundMessageContext, type SlackInputResponseContext, type SlackInputResponseResult, type SlackInputResponseSubmission, type SlackMentionResult, type SlackMessage } from "eve/channels/slack";
import type { ConnectorRuntime } from "../../packages/connector-kit/src/runtime.js";

export function isAllowedSlackUser(message: Pick<SlackMessage, "author">, allowUsers: readonly string[]): boolean {
  const a = message.author;
  return !!a && !a.isBot && !a.isMe && allowUsers.includes(a.userId);
}

/** DM / @mention gate: only allowlisted humans reach TARX. "/new" (or "new") resets the thread's session. */
export function makeSlackInbound(rt: ConnectorRuntime, allowUsers: readonly string[]) {
  return async (ctx: SlackInboundMessageContext, message: SlackMessage): Promise<SlackMentionResult> => {
    if (!isAllowedSlackUser(message, allowUsers)) {
      rt.telemetry.onRejected("slack", "allowlist");
      return null;
    }
    // Slack redelivers events it thinks timed out; one turn per message.
    if (!(await rt.idempotency.claim(`slack:${message.channelId}:${message.ts}`))) {
      rt.telemetry.onRejected("slack", "duplicate");
      return null;
    }
    const text = message.text.replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, "").trim().toLowerCase();
    if (text === "/new" || text === "new") {
      await ctx.reset({ reason: "Slack user requested /new" });
      await ctx.thread.post("Started a fresh conversation.");
      return null;
    }
    return { auth: defaultSlackAuth(message, ctx) };
  };
}

/** HITL clicks (approve/deny buttons) resume a parked turn: apply the same allowlist so nobody else can answer for you. */
export function makeSlackInputResponse(rt: ConnectorRuntime, allowUsers: readonly string[]) {
  return async (ctx: SlackInputResponseContext, submission: SlackInputResponseSubmission): Promise<SlackInputResponseResult> => {
    if (!allowUsers.includes(submission.user.id)) {
      rt.telemetry.onRejected("slack", "allowlist-hitl");
      return null;
    }
    return { auth: ctx.defaultAuth };
  };
}
