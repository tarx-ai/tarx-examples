import { createHash } from "node:crypto";
import type { ReceivedEmail } from "./resend-client.js";

export function addressOf(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m?.[1] ?? from).trim().toLowerCase();
}

/** True if any To address is on the dedicated inbound domain (e.g. "in.example.com"). Empty domain means accept all. */
export function addressedTo(email: { to?: string[] | null }, domain: string | undefined): boolean {
  const d = (domain ?? "").trim().toLowerCase();
  if (!d) return true;
  return (email.to ?? []).some((t) => {
    const a = addressOf(t);
    const at = a.lastIndexOf("@");
    return at >= 0 && a.slice(at + 1) === d;
  });
}

/** Anti-spoofing: the receiving server's SPF/DKIM/DMARC verdict (not forgeable headers) + exact allowlist. */
export function checkSender(email: Pick<ReceivedEmail, "from" | "authentication">, allow: readonly string[]): { ok: true; sender: string } | { ok: false; reason: "allowlist" | "auth" } {
  const sender = addressOf(email.from);
  if (!allow.map((a) => a.toLowerCase()).includes(sender)) return { ok: false, reason: "allowlist" };
  const a = email.authentication;
  // DMARC pass requires an aligned SPF or DKIM pass; require DMARC plus at least one of them.
  if (!a || a.dmarc !== "pass" || (a.dkim !== "pass" && a.spf !== "pass")) return { ok: false, reason: "auth" };
  return { ok: true, sender };
}

/** Keep only the new text of a reply (drops "On ... wrote:", quoted ">" blocks, Outlook headers, signatures marker). */
export function stripQuotedReply(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*>/.test(line)) break;
    if (/^On .+wrote:\s*$/i.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (/^From: .+/i.test(line.trim()) && out.length > 0) break;
    if (line.trim() === "--") break;
    out.push(line);
  }
  return out.join("\n").trim();
}

function header(h: Record<string, string> | null, name: string): string | undefined {
  if (!h) return undefined;
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? h[k] : undefined;
}

export function messageIds(value: string | undefined): string[] {
  return value ? value.match(/<[^<>\s]+>/g) ?? [] : [];
}

/** Thread identity: first Message-ID in References (thread root), else In-Reply-To, else this message. */
export function threadInfo(email: Pick<ReceivedEmail, "id" | "message_id" | "headers" | "subject">) {
  const refs = messageIds(header(email.headers, "references"));
  const inReplyTo = messageIds(header(email.headers, "in-reply-to"));
  const own = messageIds(email.message_id ?? undefined)[0] ?? ""; // never fabricate a Message-ID
  const root = refs[0] ?? inReplyTo[0] ?? (own || `resend:${email.id}`); // deterministic across webhook retries
  const references = [...new Set([...refs, ...inReplyTo, ...(own ? [own] : [])])];
  const baseSubject = (email.subject ?? "").replace(/^\s*((re|fwd?):\s*)+/i, "").trim() || "TARX";
  return { token: threadToken(root), messageId: own, references, replySubject: `Re: ${baseSubject}` };
}

/** Channel-owned continuation token: a hash of the thread root, so raw header text never becomes an eve address. */
export function threadToken(root: string): string {
  return "t" + createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 32);
}

/** Headers that make mail clients thread the reply under the user's message. */
export function replyHeaders(messageId: string, references: readonly string[]): Record<string, string> {
  const refs = references.length > 20 ? [references[0]!, ...references.slice(-19)] : references; // keep the root
  return { "In-Reply-To": messageId, References: refs.join(" ") };
}

/** Plain-text body for HTML-only mail (Resend returns `text: null` for some clients). Drops quoted blocks first. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(blockquote|style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<div[^>]*class="[^"]*gmail_quote[\s\S]*$/i, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Body text to hand to the agent: prefer text/plain, fall back to HTML, then strip quoted history. */
export function bodyText(email: { text?: string | null; html?: string | null }): string {
  const raw = email.text?.trim() ? email.text : email.html ? htmlToText(email.html) : "";
  return stripQuotedReply(raw);
}
