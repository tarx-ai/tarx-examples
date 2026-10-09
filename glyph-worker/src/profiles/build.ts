import { spawnSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerConfig } from "../config.ts";
import { readPublicFile, diffPaths, isAllowedPath, assertPublic } from "../guard.ts";
import type { GlyphClient } from "../gateway.ts";
import type { RunLog } from "../log.ts";
import { fenced } from "../extract.ts";

const SYSTEM = `You are a careful senior TypeScript engineer contributing to a PUBLIC open-source repo.
Rules: use only the files provided; do not invent APIs (mark unknowns "// VERIFY:"); never include secrets, real emails,
phone numbers, or hostnames (use example.com, +15550000001). Keep the change minimal and idiomatic for the existing code.
Output exactly:
1) "## Plan" (3-6 bullets)
2) "## Patch" with ONE \`\`\`diff block containing a unified diff (git format: "diff --git a/<path> b/<path>", ---/+++ headers,
   @@ hunks with correct line counts; paths relative to the repo root; new files use "--- /dev/null").
3) "## Notes" (risks, VERIFY items).`;

const REVIEW = `You are reviewing a DRAFT patch written by another model for a public repo. Be specific and skeptical.
Check: does it apply to the given files, compile under TypeScript strict, actually test the stated behavior, avoid flakiness
(timers, ordering), and match existing conventions? Output "## Verdict" (APPROVE | REQUEST_CHANGES), then "## Findings"
as a numbered list with severity [high|med|low], file:line, and a concrete fix.`;

export interface BuildInput { task: string; files: string[]; }

/** Glyph drafts a patch and reviews it. It NEVER commits or pushes; it only runs a read-only `git apply --check` in a temp copy. */
export async function runBuild(cfg: WorkerConfig, client: GlyphClient, log: RunLog, input: BuildInput) {
  const guardOpts = { allowedLocalPorts: cfg.allowedLocalPorts, denyTerms: cfg.denyTerms };
  assertPublic(input.task, "task spec", guardOpts);
  const files = input.files.map((f) => readPublicFile(f, cfg.publicRoot, cfg.publicPaths, guardOpts));
  const ctx = files.map((f) => `=== FILE: ${f.rel} ===\n\`\`\`\n${f.text}\n\`\`\``).join("\n\n");
  log.artifact("input.json", { task: input.task, files: files.map((f) => f.rel) });

  const draft = await client.chat({ task: "build.draft", messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `REPO FILES:\n\n${ctx}\n\n---\nTASK:\n${input.task}` }] });
  log.artifact("draft.md", draft.content);
  const patch = fenced(draft.content, "diff") ?? "";
  log.artifact("draft.patch", patch);

  // Output guard: the patch must stay on public paths and contain nothing private.
  const touched = diffPaths(patch).filter((p) => p !== "/dev/null" && p !== "dev/null");
  const offList = touched.filter((p) => !isAllowedPath(p, cfg.publicPaths));
  let outputGuard = "ok";
  try { assertPublic(patch, "draft.patch", guardOpts); } catch (e) { outputGuard = (e as Error).message; }
  const applyCheck = patch ? gitApplyCheck(cfg.publicRoot, patch, files.map((f) => f.rel)) : { ok: false, output: "no ```diff block in output" };

  const review = await client.chat({ task: "build.self_review", messages: [{ role: "system", content: REVIEW }, { role: "user", content: `REPO FILES:\n\n${ctx}\n\n---\nTASK GIVEN TO THE AUTHOR:\n${input.task}\n\n---\nDRAFT PATCH:\n\`\`\`diff\n${patch}\n\`\`\`\n\ngit apply --check: ${applyCheck.ok ? "OK" : "FAILED: " + applyCheck.output}` }] });
  log.artifact("self-review.md", review.content);
  const summary = { touched, offAllowlist: offList, outputGuard, applyCheck, nextStep: "Human/TARX review required. Glyph never commits or pushes." };
  log.artifact("summary.json", summary);
  return summary;
}

/** Copies only the referenced public files into a temp git repo and runs `git apply --check`. Read-only for the real tree. */
export function gitApplyCheck(root: string, patch: string, rels: string[]): { ok: boolean; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "glyph-apply-"));
  try {
    for (const rel of rels) cpSync(join(root, rel), join(dir, rel), { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: dir });
    const r = spawnSync("git", ["apply", "--check", "--recount", "-"], { cwd: dir, input: patch, encoding: "utf8" });
    return { ok: r.status === 0, output: (r.stderr || r.stdout || "").trim().slice(0, 2000) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
