import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface WorkerConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  concurrency: number;
  reasoning: "low" | "medium" | "high" | "xhigh";
  runsDir: string;
  spendGuard: "strict" | "off";
  publicRoot: string;
  publicPaths: string[];
  allowedLocalPorts: number[];
  denyTerms: string[];
}

type Env = Record<string, string | undefined>;
const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const expand = (p: string) => (p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p));

/** Reads config from env only. The key comes from AI_GATEWAY_API_KEY or AI_GATEWAY_API_KEY_FILE and is never logged. */
export function loadConfig(env: Env = process.env, opts: { requireKey?: boolean } = {}): WorkerConfig {
  let apiKey = env.AI_GATEWAY_API_KEY?.trim() ?? "";
  if (!apiKey && env.AI_GATEWAY_API_KEY_FILE) apiKey = readFileSync(expand(env.AI_GATEWAY_API_KEY_FILE), "utf8").trim();
  if (!apiKey && opts.requireKey !== false) throw new Error("glyph-worker: set AI_GATEWAY_API_KEY (or AI_GATEWAY_API_KEY_FILE).");
  const reasoning = (env.GLYPH_REASONING ?? "medium") as WorkerConfig["reasoning"];
  if (!["low", "medium", "high", "xhigh"].includes(reasoning)) throw new Error(`glyph-worker: bad GLYPH_REASONING=${reasoning}`);
  return {
    apiKey,
    model: env.GLYPH_MODEL ?? "stealth/glyph-cluster",
    baseUrl: (env.GLYPH_BASE_URL ?? "https://ai-gateway.vercel.sh/v1").replace(/\/+$/, ""),
    concurrency: Math.max(1, Math.min(16, Number(env.GLYPH_CONCURRENCY ?? 4) || 4)),
    reasoning,
    runsDir: expand(env.GLYPH_RUNS_DIR ?? "./runs"),
    spendGuard: env.GLYPH_SPEND_GUARD === "off" ? "off" : "strict",
    publicRoot: expand(env.GLYPH_PUBLIC_ROOT ?? ".."),
    publicPaths: list(env.GLYPH_PUBLIC_PATHS ?? "eve-connectors/,glyph-worker/,examples/,src/,test/,docs/,README.md"),
    allowedLocalPorts: list(env.GLYPH_ALLOWED_LOCAL_PORTS ?? "0,3000").map(Number).filter(Number.isFinite),
    denyTerms: list(env.GLYPH_DENY_TERMS),
  };
}
