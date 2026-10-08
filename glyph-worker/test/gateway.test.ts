import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { GlyphClient } from "../src/gateway.ts";
import { RunLog } from "../src/log.ts";
import { BoundaryError } from "../src/guard.ts";
import { PriceGuardError } from "../src/price-guard.ts";
import { mapLimit } from "../src/pool.ts";

const sse = (events: object[]) => new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close(); } }), { headers: { "content-type": "text/event-stream" } });

function harness(opts: { price?: string; chunkCost?: number; failFirst?: number } = {}) {
  const calls: string[] = [];
  let fails = opts.failFirst ?? 0;
  const f = (async (url: string) => {
    calls.push(url);
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "stealth/glyph-cluster", pricing: { input: "0", output: opts.price ?? "0" } }] }));
    if (url.endsWith("/endpoints")) return new Response(JSON.stringify({ data: { endpoints: [{ pricing: { prompt: "0" } }] } }));
    if (url.endsWith("/credits")) return new Response(JSON.stringify({ balance: "1", total_used: "5" }));
    if (fails-- > 0) return new Response("busy", { status: 503 });
    return sse([
      { choices: [{ delta: { reasoning: "thinking" } }] },
      { choices: [{ delta: { content: "Hello " } }] },
      { choices: [{ delta: { content: "world" } }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, cost: opts.chunkCost ?? 0, market_cost: 0, completion_tokens_details: { reasoning_tokens: 2 } } },
    ]);
  }) as typeof fetch;
  const cfg = { ...loadConfig({ AI_GATEWAY_API_KEY: "test-key" }), runsDir: mkdtempSync(join(tmpdir(), "gw-runs-")) };
  const log = new RunLog(cfg.runsDir, "s1");
  return { calls, client: new GlyphClient(cfg, log, "test", f), log };
}

test("streams content, logs Datadog-ready metrics with cost 0", async () => {
  const h = harness();
  const r = await h.client.chat({ task: "t", messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.content, "Hello world");
  assert.equal(r.reasoningChars, 8);
  const rec = JSON.parse(readFileSync(join(h.log.dir, "calls.jsonl"), "utf8").trim());
  assert.equal(rec.status, "ok"); assert.equal(rec.tokens_in, 12); assert.equal(rec.tokens_out, 3); assert.equal(rec.tokens_reasoning, 2); assert.equal(rec.cost, 0);
  assert.equal(rec.ddsource, "glyph-worker"); assert.ok(typeof rec.ttft_ms === "number" && typeof rec.total_ms === "number");
});

test("boundary guard blocks before ANY network call", async () => {
  const h = harness();
  await assert.rejects(h.client.chat({ task: "t", messages: [{ role: "user", content: "email someone" + "@" + "acme.io" }] }), BoundaryError);
  assert.equal(h.calls.length, 0);
});

test("non-zero price aborts before the chat request", async () => {
  const h = harness({ price: "0.5" });
  await assert.rejects(h.client.chat({ task: "t", messages: [{ role: "user", content: "hi" }] }), PriceGuardError);
  assert.ok(!h.calls.some((u) => u.endsWith("/chat/completions")));
});

test("non-zero cost in the stream aborts and is not retried", async () => {
  const h = harness({ chunkCost: 0.01 });
  await assert.rejects(h.client.chat({ task: "t", messages: [{ role: "user", content: "hi" }] }), PriceGuardError);
  assert.equal(h.calls.filter((u) => u.endsWith("/chat/completions")).length, 1);
});

test("retries transient 5xx", async () => {
  const h = harness({ failFirst: 1 });
  const r = await h.client.chat({ task: "t", messages: [{ role: "user", content: "hi" }] }, 2);
  assert.equal(r.content, "Hello world");
});

test("mapLimit caps concurrency and keeps order", async () => {
  let live = 0, peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (x) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return x * 2; });
  assert.equal(peak, 2);
  assert.deepEqual(out.map((o) => (o.status === "fulfilled" ? o.value : null)), [2, 4, 6, 8, 10, 12]);
});
