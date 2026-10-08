import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One line per model call. Field names are flat and Datadog-friendly (ddsource/service/ddtags + numeric metrics). */
export interface CallRecord {
  ts: string; ddsource: "glyph-worker"; service: "glyph-worker"; ddtags: string;
  session: string; profile: string; task: string; model: string; attempt: number;
  status: "ok" | "error" | "blocked" | "aborted";
  ttft_ms: number | null; total_ms: number; tokens_in: number | null; tokens_out: number | null;
  tokens_reasoning: number | null; tokens_cached: number | null; cost: number | null; market_cost: number | null;
  http_status?: number; error?: string;
}

export class RunLog {
  readonly dir: string;
  readonly session: string;
  constructor(runsDir: string, session: string) {
    this.session = session;
    this.dir = join(runsDir, session);
    mkdirSync(this.dir, { recursive: true });
  }
  call(r: Omit<CallRecord, "ts" | "ddsource" | "service" | "session">) {
    const rec: CallRecord = { ts: new Date().toISOString(), ddsource: "glyph-worker", service: "glyph-worker", session: this.session, ...r };
    appendFileSync(join(this.dir, "calls.jsonl"), JSON.stringify(rec) + "\n");
    return rec;
  }
  artifact(name: string, content: string | object) {
    const p = join(this.dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content, null, 2));
    return p;
  }
}

export const newSessionId = (profile: string) => `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${profile}-${Math.random().toString(36).slice(2, 6)}`;
