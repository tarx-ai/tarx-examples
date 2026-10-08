/**
 * $0 guard. Before every request: the model must be listed, every listed price must be exactly 0 (catalog and
 * endpoints, including tiers), and (strict mode) the team's AI Gateway total_used must not have moved since the
 * run began. During and after the call, any non-zero cost-like field in headers or the stream aborts the run.
 */
export class PriceGuardError extends Error { constructor(msg: string) { super(`price guard: ${msg}`); this.name = "PriceGuardError"; } }

type Json = unknown;
const NUM = /[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g;

function nonZeroIn(v: Json): boolean {
  if (v === null || v === undefined || v === "") return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") { const n = Number(v); return Number.isFinite(n) ? n !== 0 : false; }
  return (JSON.stringify(v).match(NUM) ?? []).some((x) => Number(x) !== 0);
}

/** Pure check of a catalog entry and its endpoints. Exported for tests. */
export function checkPricing(model: string, catalogEntry: Record<string, Json> | undefined, endpoints: Array<Record<string, Json>> | undefined): void {
  if (!catalogEntry) throw new PriceGuardError(`${model} is missing from /models`);
  const p = catalogEntry.pricing as Record<string, Json> | undefined;
  if (!p || typeof p !== "object") throw new PriceGuardError(`${model} has no pricing block`);
  for (const k of ["input", "output"]) if (!(k in p)) throw new PriceGuardError(`${model} pricing lacks ${k}`);
  for (const [k, v] of Object.entries(p)) if (nonZeroIn(v)) throw new PriceGuardError(`${model} price ${k} is not 0`);
  if (!endpoints?.length) throw new PriceGuardError(`${model} has no endpoints`);
  for (const e of endpoints) for (const [k, v] of Object.entries((e.pricing as Record<string, Json>) ?? {})) {
    if (k === "discount") continue;
    if (nonZeroIn(v)) throw new PriceGuardError(`${model} endpoint price ${k} is not 0`);
  }
}

/** Throws if any key containing "cost" (or price/charge/spend) holds a non-zero number. */
export function scanCost(obj: Json, where: string): void {
  if (Array.isArray(obj)) { for (const x of obj) scanCost(x, where); return; }
  if (!obj || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj as Record<string, Json>)) {
    const costKey = /cost|^price$|^charge$|^spend$/i.test(k);
    if (costKey && (typeof v === "number" || typeof v === "string")) { if (nonZeroIn(v)) throw new PriceGuardError(`non-zero ${k} in ${where}`); }
    else scanCost(v, where);
  }
}

export class PriceGuard {
  private checkedAt = 0;
  private baselineUsed: number | null = null;
  private readonly o: { baseUrl: string; apiKey: string; model: string; spendGuard: "strict" | "off"; fetch?: typeof fetch; cacheMs?: number };
  constructor(o: PriceGuard["o"]) { this.o = o; }
  private get f() { return this.o.fetch ?? fetch; }

  private async getJson(path: string, auth = false): Promise<Record<string, Json>> {
    const r = await this.f(`${this.o.baseUrl}${path}`, { headers: { "User-Agent": "glyph-worker", ...(auth ? { Authorization: `Bearer ${this.o.apiKey}` } : {}) } });
    if (!r.ok) throw new PriceGuardError(`GET ${path} returned ${r.status}`);
    return (await r.json()) as Record<string, Json>;
  }

  /** Run before every request (a short cache avoids re-hitting the catalog for parallel fan-out). */
  async check(): Promise<void> {
    if (Date.now() - this.checkedAt > (this.o.cacheMs ?? 20_000)) {
      const cat = await this.getJson("/models");
      const list = (Array.isArray(cat.data) ? cat.data : cat) as Array<Record<string, Json>>;
      const entry = list.find((m) => m.id === this.o.model);
      const ep = await this.getJson(`/models/${this.o.model}/endpoints`).catch(() => undefined);
      const endpoints = ((ep?.data as Record<string, Json> | undefined)?.endpoints ?? undefined) as Array<Record<string, Json>> | undefined;
      checkPricing(this.o.model, entry, endpoints);
      this.checkedAt = Date.now();
    }
    await this.spend();
  }

  /** Strict: abort if the team's total_used rose at all since the first check (conservative; any team spend aborts). */
  async spend(): Promise<{ used: number; balance: number } | null> {
    if (this.o.spendGuard === "off") return null;
    const c = await this.getJson("/credits", true);
    const used = Number(c.total_used), balance = Number(c.balance);
    if (!Number.isFinite(used)) throw new PriceGuardError("credits endpoint returned no total_used");
    if (this.baselineUsed === null) this.baselineUsed = used;
    else if (used > this.baselineUsed + 1e-9) throw new PriceGuardError(`team total_used rose by ${(used - this.baselineUsed).toFixed(9)}`);
    return { used, balance };
  }
}
