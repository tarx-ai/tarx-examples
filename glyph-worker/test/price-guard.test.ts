import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPricing, scanCost, PriceGuard, PriceGuardError } from "../src/price-guard.ts";

const free = { id: "m", pricing: { input: "0", output: "0" } };
const ep = [{ pricing: { prompt: "0", completion: "0", request: "0", discount: 0.5 } }];

test("checkPricing: all-zero passes; missing model, missing fields, any non-zero (incl. tiers) abort", () => {
  checkPricing("m", free, ep);
  assert.throws(() => checkPricing("m", undefined, ep), PriceGuardError);
  assert.throws(() => checkPricing("m", { id: "m", pricing: { input: "0" } }, ep), /lacks output/);
  assert.throws(() => checkPricing("m", { id: "m", pricing: { input: "0", output: "0.000001" } }, ep), /output/);
  assert.throws(() => checkPricing("m", { id: "m", pricing: { input: "0", output: "0", input_tiers: [{ cost: "0" }, { cost: "0.2" }] } }, ep), /input_tiers/);
  assert.throws(() => checkPricing("m", free, [{ pricing: { completion: "1" } }]), /endpoint/);
  assert.throws(() => checkPricing("m", free, []), /no endpoints/);
});

test("scanCost finds non-zero cost-like fields anywhere", () => {
  scanCost({ usage: { cost: 0, market_cost: 0, cost_details: { upstream_inference_cost: null } } }, "x");
  assert.throws(() => scanCost({ usage: { cost: 0.0001 } }, "x"), PriceGuardError);
  assert.throws(() => scanCost({ a: [{ market_cost: "0.3" }] }, "x"), PriceGuardError);
});

test("strict spend guard aborts if team total_used moves", async () => {
  let used = 10;
  const f = (async (url: string) => {
    if (url.endsWith("/credits")) return new Response(JSON.stringify({ balance: "1", total_used: String(used) }));
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [free] }));
    return new Response(JSON.stringify({ data: { endpoints: ep } }));
  }) as typeof fetch;
  const g = new PriceGuard({ baseUrl: "https://gw.example.com/v1", apiKey: "k", model: "m", spendGuard: "strict", fetch: f });
  await g.check();
  await g.check();
  used = 10.01;
  await assert.rejects(g.check(), /total_used rose/);
});
