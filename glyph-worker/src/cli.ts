#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { GlyphClient } from "./gateway.ts";
import { scanText, readPublicFile } from "./guard.ts";
import { RunLog, newSessionId } from "./log.ts";
import { PriceGuard } from "./price-guard.ts";
import { runBuild } from "./profiles/build.ts";
import { runDataset } from "./profiles/dataset.ts";
import { runReview } from "./profiles/review.ts";

const USAGE = `glyph-worker <command> [options]
  check                                   $0 preflight: price guard + spend baseline (no model call)
  guard <file...>                         scan files locally with the boundary guard (no network)
  build   --task "<spec>" | --task-file f --files a.ts,b.ts
  dataset --channel sms|slack|email --n 20 [--batch 5]
  review  --pr owner/repo#N | --diff file.diff [--exclude "package-lock.json,*.lock"]
Common: --session <id>   (env: AI_GATEWAY_API_KEY, GLYPH_* — see .env.example)`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    task: { type: "string" }, "task-file": { type: "string" }, files: { type: "string" }, channel: { type: "string" }, n: { type: "string" }, batch: { type: "string" },
    pr: { type: "string" }, diff: { type: "string" }, exclude: { type: "string" }, session: { type: "string" },
  } });
  if (!cmd || cmd === "help" || cmd === "--help") { console.log(USAGE); return; }

  if (cmd === "guard") {
    const cfg = loadConfig(process.env, { requireKey: false });
    let bad = 0;
    for (const p of positionals) {
      try { readPublicFile(p, cfg.publicRoot, cfg.publicPaths, { allowedLocalPorts: cfg.allowedLocalPorts, denyTerms: cfg.denyTerms }); console.log(`ok      ${p}`); }
      catch (e) { bad++; console.log(`BLOCKED ${p}: ${(e as Error).message}`); }
    }
    if (!positionals.length) { const f = scanText(readFileSync(0, "utf8")); console.log(f.length ? `BLOCKED: ${f.map((x) => x.rule).join(",")}` : "ok"); bad = f.length; }
    process.exitCode = bad ? 1 : 0; return;
  }

  const cfg = loadConfig();
  if (cmd === "check") {
    const g = new PriceGuard({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, spendGuard: cfg.spendGuard });
    await g.check();
    const s = await g.spend();
    console.log(JSON.stringify({ model: cfg.model, prices: "all 0", spendGuard: cfg.spendGuard, ...(s ? { team_total_used: s.used, balance: s.balance } : {}) }));
    return;
  }
  const session = values.session ?? newSessionId(cmd);
  const log = new RunLog(cfg.runsDir, session);
  const client = new GlyphClient(cfg, log, cmd);
  const t0 = Date.now();
  let result: unknown;
  if (cmd === "build") {
    const task = values.task ?? (values["task-file"] ? readFileSync(values["task-file"], "utf8") : "");
    if (!task || !values.files) throw new Error("build needs --task/--task-file and --files");
    result = await runBuild(cfg, client, log, { task, files: values.files.split(",").map((s) => s.trim()).filter(Boolean) });
  } else if (cmd === "dataset") {
    const channel = (values.channel ?? "sms") as "sms" | "slack" | "email";
    if (!["sms", "slack", "email"].includes(channel)) throw new Error("--channel must be sms|slack|email");
    result = await runDataset(cfg, client, log, { channel, n: Number(values.n ?? 20), batchSize: Number(values.batch ?? 5) });
  } else if (cmd === "review") {
    const exclude = (values.exclude ?? "package-lock.json,*.lock,pnpm-lock.yaml").split(",").map((s) => s.trim()).filter(Boolean);
    result = await runReview(cfg, client, log, values.pr ? { pr: values.pr, exclude } : { diff: readFileSync(values.diff ?? 0, "utf8"), exclude });
  } else { console.error(USAGE); process.exitCode = 2; return; }
  const final = await client.guard.spend();
  console.log(JSON.stringify({ session, dir: log.dir, wall_s: Math.round((Date.now() - t0) / 1000), spend_unchanged: final ? true : "spend guard off", result }, null, 2));
}

main().catch((e) => { console.error(`glyph-worker: ${(e as Error).name}: ${(e as Error).message}`); process.exitCode = 1; });
