/**
 * Data-boundary guard. Every prompt is scanned BEFORE it leaves the machine. The model's provider retains prompts
 * (no ZDR, no no-training), so anything private must never reach it. It fails closed: any finding, or any error while
 * scanning, blocks the request. Findings report the rule and position, never the matched text.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export interface Finding { rule: string; index: number; }
export class BoundaryError extends Error {
  readonly findings: Finding[];
  constructor(findings: Finding[], where: string) {
    super(`boundary guard blocked ${where}: ${findings.map((f) => `${f.rule}@${f.index}`).join(", ")}`);
    this.name = "BoundaryError";
    this.findings = findings;
  }
}

export interface GuardOptions { allowedLocalPorts?: number[]; denyTerms?: string[]; }

/** Obvious placeholders that public docs and tests use on purpose. */
const PLACEHOLDER = /(x{4,}|placeholder|example|dummy|fake|test|your[-_]?|sample|redacted|<[^>]*>|\.\.\.|…)/i;
const ALLOWED_EMAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost|users\.noreply\.github\.com)$/i; // RFC 2606 reserved names

const SECRET_RULES: Array<[string, RegExp]> = [
  ["resend-key", /\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{12,}\b/g],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["slack-webhook", /hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g],
  ["openai-like-key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g],
  ["github-token", /\b(?:gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["twilio-sid", /\bAC[0-9a-f]{32}\b/g],
  ["svix-secret", /\bwhsec_[A-Za-z0-9+/=]{16,}/g],
  ["vercel-key", /\b(?:vck|vcp|vca)_[A-Za-z0-9]{16,}/g],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+/-]{24,}/g],
  ["assigned-secret", /\b(?:api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["'][^"'\s]{12,}["']/gi],
];

const INFRA_RULES: Array<[string, RegExp]> = [
  ["private-host", /\b[A-Za-z0-9-]+-PRIME\b|(?<![.\w/-])[A-Za-z][A-Za-z0-9-]{1,62}\.local\b(?![.\w-])/g], // mDNS hosts; not ".env.local"
  ["private-ip", /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g],
  ["home-path", /(?:\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+\/\.config)/g],
  ["tunnel-host", /\b[a-z0-9-]+\.(?:ngrok-free\.app|ngrok\.app|ngrok\.io|trycloudflare\.com)\b/gi],
];

function scanRule(text: string, rule: string, re: RegExp, out: Finding[], allowPlaceholder = true) {
  for (const m of text.matchAll(re)) {
    if (allowPlaceholder && PLACEHOLDER.test(m[0])) continue;
    out.push({ rule, index: m.index ?? -1 });
  }
}

/** Returns findings for one string. Pure; no I/O. */
export function scanText(text: string, opts: GuardOptions = {}): Finding[] {
  const out: Finding[] = [];
  for (const [rule, re] of SECRET_RULES) scanRule(text, rule, re, out);
  for (const [rule, re] of INFRA_RULES) scanRule(text, rule, re, out);
  // Loopback ports: allow only listed ones (public docs use :3000; :0 is a "set via env" placeholder).
  const ports = new Set(opts.allowedLocalPorts ?? [0, 3000]);
  for (const m of text.matchAll(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{1,5})\b/g)) if (!ports.has(Number(m[1]))) out.push({ rule: "local-port", index: m.index ?? -1 });
  // Email addresses: only reserved example domains.
  for (const m of text.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)) if (!ALLOWED_EMAIL_DOMAIN.test(m[1]!)) out.push({ rule: "email", index: m.index ?? -1 });
  // Phone numbers: only the fictional +1-555 range.
  for (const m of text.matchAll(/\+\d[\d\s().-]{8,16}\d/g)) if (!/^\+1[\s().-]*555/.test(m[0])) out.push({ rule: "phone", index: m.index ?? -1 });
  for (const m of text.matchAll(/(?<![\w+])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g)) if (!/^\(?555\)?/.test(m[0]) && !/^\(?\d{3}\)?[\s.-]555[\s.-]01\d\d/.test(m[0])) out.push({ rule: "phone", index: m.index ?? -1 });
  for (const term of opts.denyTerms ?? []) {
    let i = text.toLowerCase().indexOf(term.toLowerCase());
    while (i >= 0) { out.push({ rule: "deny-term", index: i }); i = text.toLowerCase().indexOf(term.toLowerCase(), i + 1); }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Throws BoundaryError if anything is found. Any internal error also blocks (fail closed). */
export function assertPublic(text: string, where: string, opts: GuardOptions = {}): void {
  let findings: Finding[];
  try { findings = scanText(text, opts); } catch (err) { throw new BoundaryError([{ rule: `scanner-error:${(err as Error).message}`, index: -1 }], where); }
  if (findings.length) throw new BoundaryError(findings, where);
}

const DENY_PATH = /(^|\/)(\.data|\.eve|node_modules|\.git|runs)(\/|$)|\.(pem|key|p12|sqlite|db)$|(^|\/)(id_rsa|id_ed25519)/i;
/** Published smoke evidence only. Other runs/ stay denied so a local session cannot be read back into a prompt. */
const SMOKE_RUN = /^glyph-worker\/runs\/smoke-[A-Za-z0-9._-]+(\/|$)/;
const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/; // .env, .env.local, ... (but .env.example is allowed: placeholders only)

/** Checks that a repo-relative path is on the public allowlist (prefix match, "dir/" or exact file). */
export function isAllowedPath(rel: string, allow: readonly string[]): boolean {
  const p = rel.split(sep).join("/").replace(/^\.\//, "");
  if (!p || p.startsWith("../") || p.startsWith("/")) return false;
  if (DENY_PATH.test(p) && !SMOKE_RUN.test(p)) return false;
  if (ENV_FILE.test(p) && !p.endsWith(".env.example")) return false;
  return allow.some((a) => (a.endsWith("/") ? p.startsWith(a) : p === a));
}

/** Reads a file only if it resolves (after symlinks) inside the public root and on the allowlist, then scans it. */
export function readPublicFile(path: string, root: string, allow: readonly string[], opts: GuardOptions = {}): { rel: string; text: string } {
  const rootReal = realpathSync(root);
  const abs = resolve(rootReal, path);
  if (lstatSync(abs).isSymbolicLink()) throw new BoundaryError([{ rule: "symlink", index: -1 }], path);
  const real = realpathSync(abs);
  const rel = relative(rootReal, real);
  if (!isAllowedPath(rel, allow)) throw new BoundaryError([{ rule: "path-not-allowlisted", index: -1 }], rel || path);
  const text = readFileSync(real, "utf8");
  assertPublic(text, rel, opts);
  return { rel: rel.split(sep).join("/"), text };
}

/** File paths touched by a unified diff (a/ and b/ sides). */
export function diffPaths(diff: string): string[] {
  const s = new Set<string>();
  for (const m of diff.matchAll(/^(?:---|\+\+\+) (?:a|b)\/(.+)$/gm)) s.add(m[1]!.trim());
  for (const m of diff.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) { s.add(m[1]!); s.add(m[2]!); }
  return [...s];
}
