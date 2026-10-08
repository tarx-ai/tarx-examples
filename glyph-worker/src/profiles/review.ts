import type { WorkerConfig } from "../config.ts";
import { assertPublic, diffPaths, isAllowedPath, BoundaryError } from "../guard.ts";
import type { GlyphClient } from "../gateway.ts";
import type { RunLog } from "../log.ts";
import { mapLimit } from "../pool.ts";

const SYSTEM = `You are a principal engineer doing a security- and correctness-focused code review of a PUBLIC pull request.
Prioritize: (1) security (signature verification, replay windows, allowlists, injection, secrets), (2) correctness and
race conditions (idempotency, retries, ordering), (3) API misuse versus the libraries in use, (4) tests that don't test
what they claim, (5) docs that mislead. Skip style nits. Be concrete: file:line, why it matters, and the exact fix.
Output:
## Summary (2-4 sentences)
## Findings
numbered, each "[high|med|low] path:line: problem. Fix: ..."
## Verdict: APPROVE | REQUEST_CHANGES
Finally one \`\`\`json block: {"verdict":"...","high":n,"med":n,"low":n}`;

export interface ReviewInput { diff?: string; pr?: string; exclude: string[]; }

/** Splits a git diff into per-file sections. */
export function splitDiff(diff: string): Array<{ path: string; text: string }> {
  const parts = diff.split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git "));
  return parts.map((text) => ({ path: /^diff --git a\/(\S+) b\/(\S+)/.exec(text)?.[2] ?? "?", text }));
}
const globToRe = (g: string) => new RegExp("(^|/)" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$");

/** Fetches a PR diff only if the repo is PUBLIC (unauthenticated GitHub API must see it). Fails closed otherwise. */
export async function fetchPublicPrDiff(pr: string, f: typeof fetch = fetch): Promise<string> {
  const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(pr);
  if (!m) throw new Error(`--pr must look like owner/repo#123`);
  const [, owner, repo, num] = m;
  const meta = await f(`https://api.github.com/repos/${owner}/${repo}`, { headers: { "User-Agent": "glyph-worker", Accept: "application/vnd.github+json" } });
  const j = meta.ok ? ((await meta.json()) as { private?: boolean }) : null;
  if (!j || j.private !== false) throw new BoundaryError([{ rule: "repo-not-public", index: -1 }], `${owner}/${repo}`);
  const r = await f(`https://patch-diff.githubusercontent.com/raw/${owner}/${repo}/pull/${num}.diff`, { headers: { "User-Agent": "glyph-worker" } });
  if (!r.ok) throw new Error(`could not fetch diff for ${pr}: HTTP ${r.status}`);
  return r.text();
}

export async function runReview(cfg: WorkerConfig, client: GlyphClient, log: RunLog, input: ReviewInput) {
  const guardOpts = { allowedLocalPorts: cfg.allowedLocalPorts, denyTerms: cfg.denyTerms };
  const raw = input.pr ? await fetchPublicPrDiff(input.pr) : input.diff ?? "";
  if (!raw.trim()) throw new Error("empty diff");
  const ex = input.exclude.map(globToRe);
  const files = splitDiff(raw).filter((s) => !ex.some((re) => re.test(s.path)));
  if (!input.pr) { // local diffs: every touched path must be on the public allowlist
    const off = diffPaths(raw).filter((p) => !isAllowedPath(p, cfg.publicPaths));
    if (off.length) throw new BoundaryError(off.map((p) => ({ rule: `path-not-allowlisted:${p}`, index: -1 })), "diff");
  }
  for (const s of files) assertPublic(s.text, s.path, guardOpts);
  // Chunk by file to ~120k chars per call; chunks run in parallel.
  const chunks: Array<typeof files> = [[]];
  let size = 0;
  for (const s of files) { if (size + s.text.length > 120_000 && chunks.at(-1)!.length) { chunks.push([]); size = 0; } chunks.at(-1)!.push(s); size += s.text.length; }
  log.artifact("input.json", { pr: input.pr ?? null, files: files.map((s) => s.path), excluded: input.exclude, chunks: chunks.length, chars: files.reduce((a, s) => a + s.text.length, 0) });
  const res = await mapLimit(chunks, cfg.concurrency, (c, i) => client.chat({ task: `review.chunk${i}`, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `PR DIFF (part ${i + 1}/${chunks.length}; files: ${c.map((s) => s.path).join(", ")}):\n\n${c.map((s) => s.text).join("\n")}` }] }));
  const out = res.map((r, i) => (r.status === "fulfilled" ? `<!-- chunk ${i + 1}/${chunks.length} -->\n${r.value.content}` : `<!-- chunk ${i + 1} failed: ${String((r.reason as Error)?.message)} -->`)).join("\n\n---\n\n");
  log.artifact("review.md", out);
  const tallies = [...out.matchAll(/```json\s*\n(\{[\s\S]*?\})\s*```/g)].map((m) => { try { return JSON.parse(m[1]!) as { verdict?: string; high?: number; med?: number; low?: number }; } catch { return null; } }).filter(Boolean) as Array<{ verdict?: string; high?: number; med?: number; low?: number }>;
  const summary = { chunks: chunks.length, files: files.length, verdicts: tallies.map((t) => t.verdict), high: tallies.reduce((a, t) => a + (t.high ?? 0), 0), med: tallies.reduce((a, t) => a + (t.med ?? 0), 0), low: tallies.reduce((a, t) => a + (t.low ?? 0), 0), nextStep: "TARX agent triages findings; a human decides. Glyph never comments or pushes." };
  log.artifact("summary.json", summary);
  return summary;
}
