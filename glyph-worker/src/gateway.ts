import type { WorkerConfig } from "./config.ts";
import { assertPublic, BoundaryError } from "./guard.ts";
import { PriceGuard, PriceGuardError, scanCost } from "./price-guard.ts";
import type { RunLog } from "./log.ts";

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string; }
export interface ChatRequest { task: string; messages: ChatMessage[]; reasoning?: WorkerConfig["reasoning"]; maxTokens?: number; temperature?: number; }
export interface ChatResult { content: string; reasoningChars: number; ttftMs: number | null; totalMs: number; usage: Record<string, unknown> | null; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const n = (v: unknown) => (typeof v === "number" ? v : null);

/**
 * Shared client for the AI Gateway (OpenAI-compatible /chat/completions, streaming).
 * Order per attempt: boundary guard (fail closed) → price/spend guard → stream → cost scan on every chunk.
 */
export class GlyphClient {
  readonly guard: PriceGuard;
  private readonly cfg: WorkerConfig;
  private readonly log: RunLog;
  private readonly profile: string;
  private readonly f: typeof fetch;
  constructor(cfg: WorkerConfig, log: RunLog, profile: string, f: typeof fetch = fetch) {
    this.cfg = cfg; this.log = log; this.profile = profile; this.f = f;
    this.guard = new PriceGuard({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, spendGuard: cfg.spendGuard, fetch: f });
  }

  async chat(req: ChatRequest, maxAttempts = 3): Promise<ChatResult> {
    const base = { profile: this.profile, task: req.task, model: this.cfg.model, ddtags: `profile:${this.profile},model:${this.cfg.model},task:${req.task}` };
    try {
      assertPublic(req.messages.map((m) => m.content).join("\n\u0000\n"), `prompt(${req.task})`, { allowedLocalPorts: this.cfg.allowedLocalPorts, denyTerms: this.cfg.denyTerms });
    } catch (err) {
      this.log.call({ ...base, attempt: 0, status: "blocked", ttft_ms: null, total_ms: 0, tokens_in: null, tokens_out: null, tokens_reasoning: null, tokens_cached: null, cost: null, market_cost: null, error: (err as Error).message });
      throw err;
    }
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const t0 = performance.now();
      try {
        await this.guard.check();
        const res = await this.once(req);
        await this.guard.spend(); // post-call: still no team spend
        const u = res.usage ?? {};
        const ctd = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
        const ptd = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
        this.log.call({ ...base, attempt, status: "ok", ttft_ms: res.ttftMs, total_ms: res.totalMs, tokens_in: n(u.prompt_tokens), tokens_out: n(u.completion_tokens), tokens_reasoning: n(ctd.reasoning_tokens), tokens_cached: n(ptd.cached_tokens), cost: n(u.cost), market_cost: n(u.market_cost) });
        return res;
      } catch (err) {
        lastErr = err;
        const fatal = err instanceof PriceGuardError || err instanceof BoundaryError || (err as { status?: number }).status === 400 || (err as { status?: number }).status === 401 || (err as { status?: number }).status === 403;
        this.log.call({ ...base, attempt, status: err instanceof PriceGuardError ? "aborted" : "error", ttft_ms: null, total_ms: Math.round(performance.now() - t0), tokens_in: null, tokens_out: null, tokens_reasoning: null, tokens_cached: null, cost: null, market_cost: null, ...(typeof (err as { status?: number }).status === "number" ? { http_status: (err as { status: number }).status } : {}), error: String((err as Error).message).slice(0, 300) });
        if (fatal || attempt === maxAttempts) throw err;
        await sleep(Math.min(30_000, 2_000 * 2 ** (attempt - 1)) * (0.5 + Math.random()));
      }
    }
    throw lastErr;
  }

  private async once(req: ChatRequest): Promise<ChatResult> {
    const body = {
      model: this.cfg.model, messages: req.messages, stream: true, stream_options: { include_usage: true },
      reasoning: { effort: req.reasoning ?? this.cfg.reasoning }, max_tokens: req.maxTokens ?? 32_000,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
    const t0 = performance.now();
    const r = await this.f(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${this.cfg.apiKey}`, "Content-Type": "application/json", "User-Agent": "glyph-worker" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(20 * 60_000),
    });
    const costHeaders: Record<string, string> = {};
    r.headers.forEach((v, k) => { if (/cost/i.test(k)) costHeaders[k] = v; });
    scanCost(costHeaders, "response headers");
    if (!r.ok || !r.body) { const e = new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`) as Error & { status: number }; e.status = r.status; throw e; }
    let content = "", reasoningChars = 0, ttft: number | null = null, usage: Record<string, unknown> | null = null, buf = "";
    const dec = new TextDecoder();
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const ev = JSON.parse(data) as { usage?: Record<string, unknown>; choices?: Array<{ delta?: { content?: string; reasoning?: string; reasoning_content?: string } }> };
        scanCost(ev, "stream chunk");
        if (ev.usage) usage = ev.usage;
        for (const c of ev.choices ?? []) {
          const d = c.delta ?? {}; const rs = d.reasoning ?? d.reasoning_content ?? "";
          if ((d.content || rs) && ttft === null) ttft = Math.round(performance.now() - t0);
          content += d.content ?? ""; reasoningChars += rs.length;
        }
      }
    }
    return { content, reasoningChars, ttftMs: ttft, totalMs: Math.round(performance.now() - t0), usage };
  }
}
