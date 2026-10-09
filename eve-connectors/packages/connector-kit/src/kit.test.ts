import { describe, expect, it, vi } from "vitest";
import { FailureAlerter } from "./alert.js";
import { MemoryIdempotencyStore } from "./idempotency.js";
import { defineConnectorManifest } from "./manifest.js";
import { TokenBucket } from "./rate-limit.js";
import { ProviderHttpError, withRetry } from "./retry.js";

const noSleep = { sleep: async () => {}, random: () => 0.5 };

describe("connector-kit", () => {
  it("withRetry: retries 5xx then succeeds; does not retry 400", async () => {
    let n = 0;
    expect(await withRetry(async () => { if (n++ < 2) throw new ProviderHttpError(503); return "ok"; }, noSleep)).toBe("ok");
    await expect(withRetry(async () => { throw new ProviderHttpError(400); }, noSleep)).rejects.toThrow("400");
  });
  it("withRetry: honors Retry-After and refreshes once on 401", async () => {
    const sleeps: number[] = [];
    let n = 0;
    await withRetry(async () => { if (n++ === 0) throw new ProviderHttpError(429, 2); return 1; }, { sleep: async (ms) => { sleeps.push(ms); } });
    expect(sleeps).toEqual([2000]);
    const refresh = vi.fn();
    let m = 0;
    expect(await withRetry(async () => { if (m++ === 0) throw new ProviderHttpError(401); return "fresh"; }, { ...noSleep, onUnauthorized: refresh })).toBe("fresh");
    expect(refresh).toHaveBeenCalledOnce();
    await expect(withRetry(async () => { throw new ProviderHttpError(401); }, { ...noSleep, onUnauthorized: refresh })).rejects.toThrow("401");
  });
  it("parseRetryAfter: seconds and HTTP-date; Retry-After capped at maxMs", async () => {
    const { parseRetryAfter } = await import("./retry.js");
    expect(parseRetryAfter("7")).toBe(7);
    expect(parseRetryAfter("0")).toBeUndefined();
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10);
    expect(parseRetryAfter(new Date(-5_000).toUTCString(), 0)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
    const sleeps: number[] = [];
    let n = 0;
    await withRetry(async () => { if (n++ === 0) throw new ProviderHttpError(429, 3600); return 1; }, { maxMs: 8000, sleep: async (ms) => { sleeps.push(ms); } });
    expect(sleeps).toEqual([8000]);
  });
  it("withRetry: does not retry programming errors", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new RangeError("bug"); }, noSleep)).rejects.toThrow("bug");
    expect(n).toBe(1);
  });
  it("MemoryIdempotencyStore: bounded, keeps recent keys", async () => {
    const s = new MemoryIdempotencyStore(60_000, () => 0, 3);
    for (const k of ["a", "b", "c", "d"]) expect(await s.claim(k)).toBe(true);
    expect(await s.claim("d")).toBe(false);
    expect(await s.claim("c")).toBe(false);
  });
  it("FailureAlerter: a throwing alert hook does not break the caller", async () => {
    const a = new FailureAlerter(1, () => { throw new Error("hook down"); });
    await expect(a.failure("x", new Error("down"))).resolves.toBeUndefined();
  });
  it("TokenBucket: burst then refill", () => {
    let t = 0;
    const b = new TokenBucket(1, 2, () => t);
    expect([b.tryTake(), b.tryTake(), b.tryTake()]).toEqual([true, true, false]);
    expect(b.waitMs()).toBe(1000);
    t += 1000;
    expect(b.tryTake()).toBe(true);
  });
  it("MemoryIdempotencyStore: dedupes within TTL", async () => {
    let t = 0;
    const s = new MemoryIdempotencyStore(1000, () => t);
    expect(await s.claim("a")).toBe(true);
    expect(await s.claim("a")).toBe(false);
    t = 1001;
    expect(await s.claim("a")).toBe(true);
  });
  it("FailureAlerter: alerts once at threshold, re-arms after success", async () => {
    const onAlert = vi.fn();
    const a = new FailureAlerter(3, onAlert);
    for (const _ of [1, 2, 3, 4]) await a.failure("x", new Error("down"));
    expect(onAlert).toHaveBeenCalledOnce();
    a.success("x");
    for (const _ of [1, 2, 3]) await a.failure("x", new Error("down"));
    expect(onAlert).toHaveBeenCalledTimes(2);
  });
  it("manifest schema rejects bad ids", () => {
    expect(() => defineConnectorManifest({ id: "Bad Id" } as never)).toThrow();
  });
});
