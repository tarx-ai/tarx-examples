## Verdict
REQUEST_CHANGES

## Findings

1. [high] file: telemetry.test.ts:134-168 — **Tests a security claim the SUT never enforces**
   - The 6th test calls `tel.onTurnLatency("slack", 20, { message: messageText, userText: messageText })` but `datadogTelemetry.onTurnLatency` in `telemetry.ts` ignores the `tags?: Record<string, string>` argument and only posts `["connector:${c}"]`. So the assertion "payloads never contain message text passed in tags" is currently vacuously true and does *not* verify that arbitrary tags are stripped/sanitized (and cannot fail if that behavior changes). Also the task states "payloads never contain message text passed in tags" as a requirement on the telemetry payloads, not just that leakage didn't happen by coincidence.
   - Fix: test the structure, not a string grep. For the call above, assert the exact `tags` array sent (e.g. only `["connector:slack"]`) and/or assert no unexpected tag keys. Also consider extending this to `onProviderError` (which also accepts tags but drops them). Avoid searching the entire JSON string for user-supplied literals (brittle to formatting/serialization). Example:
     ```ts
     const [, init] = fetchMock.mock.calls[0];
     const body = JSON.parse(String(init?.body));
     expect(body.series[0].tags).toEqual(["connector:slack"]);
     // or expect(body.series[0].tags).toContain("connector:slack") and length 1
     ```

2. [high] file: telemetry.test.ts:126-131 — **"No unhandled rejection" test is untestable as written**
   - After `expect(() => tel.onTurnLatency("bot", 15)).not.toThrow()` and `await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));` the line `await expect(Promise.resolve()).resolves.toBeUndefined(); // no unhandled rejection observed` proves nothing about the rejected `opts.apiKey().then(...).catch(...)` chain. With Vitest, unhandled rejections are global; this is a no-op and can be flaky or give false confidence.
   - Fix: flush pending microtasks/timers and assert the rejection was handled (e.g. `await vi.runAllMicrotasksAsync()` or `await vi.flushAllMicrotasks()`), and explicitly assert no unhandled rejection events fired in that scope (or use `vi.spyOn(process, 'on'/'emitWarning')` not necessary). Also consider advancing fake timers if any timers exist. At least replace the trailing assertion with microtask flush: `await vi.runAllMicrotasksAsync();` and/or `await Promise.allSettled(fetchMock.mock.results.map(r=>r.value));` if needed. Also you can assert `apiKey` was called and the fetch call completed with the rejection caught by the SUT.

3. [med] file: telemetry.test.ts:96-123 — **Covers site+header but misses required behavior for onProviderError and the tags param on it**
   - The datadog adapter implements `onProviderError(c, err, tags?)` (interface includes tags) but the draft only tests `onAck`, `onTurnLatency`, `onRejected`. The task requires testing (1)-(5) and the leakage (6); (5) is "a rejected fetch is swallowed" (tested once for `onTurnLatency`). Also `onProviderError` posts `tarx.connector.provider_error` with value `1` and only `connector:${c}` (tags ignored). Not exercising it is a coverage gap relative to the new telemetry surface.
   - Fix: add a test that `onProviderError("svc", new Error("x"), { reqId: "r" })` posts metric `tarx.connector.provider_error`, value `1`, uses `connector:svc` and does not leak `reqId`/error details in the serialized payload (and uses DD-API-KEY+site). Also reuse the "rejected fetch swallowed" case for at least one other method (e.g. `onAck`) to avoid single-method flakiness assumptions.

4. [med] file: telemetry.test.ts:21-38 — **noopTelemetry coverage is good but consider asserting arity/side effects explicitly**
   - Looping all `RejectReason` values is solid. However, to match existing conventions in `kit.test.ts` (which prefer explicit expectations), also assert each call is side-effect free (no network, no timers) and that they do not throw for any string in that union. This is minor.
   - Fix (optional but concrete): also call with `onProviderError` once including `tags` and `err` to ensure it accepts those params without throwing.

5. [med] file: telemetry.test.ts:13-18, 40-72 — **Timer/microtask determinism with fire-and-forget sends**
   - Using `vi.useFakeTimers()` + `vi.setSystemTime(now)` is correct to fix the `Date.now()/1000` timestamp. However the implementation uses `void opts.apiKey().then(...).then(() => f(...)).catch(...)` with no `await` inside `send`, so the POST is enqueued on microtasks after the method returns. `vi.waitFor` is acceptable here, but it's order-dependent and can be sensitive to timer advancement. Also after setting fake timers, prefer `await vi.runAllMicrotasksAsync()` after the call when you only need microtask completion (cheaper and less timing-dependent) before inspecting `fetchMock.mock.calls[0]`. 
   - Fix: for each call that should trigger a single send, do `tel.onTurnLatency(...); await vi.runAllMicrotasksAsync();` (or `await Promise.resolve(); await Promise.resolve();`) instead of relying on `vi.waitFor` for the first call, or pair with `expect(fetchMock).toHaveBeenCalledTimes(1)` after flushing microtasks. This avoids arbitrary polling and is deterministic with fake timers.

6. [low] file: telemetry.test.ts:47-56, 82-91, 117-125 — **Header assertion is permissive**
   - `expect(init?.headers).toMatchObject({ "DD-API-KEY": "test-key", "content-type": "application/json" })` allows additional headers. The SUT only sets those two, but the test doesn't catch unexpected headers. Not required, but to lock the "never sends message bodies or identifiers" contract to the request metadata, consider asserting the header shape more strictly or that no `x-` correlation headers leaking PII were added. 
   - Fix: `expect(init?.headers).toEqual(expect.objectContaining({ "DD-API-KEY": "test-key", "content-type": "application/json" }));` or explicitly check it's a headers object with those values. Also note `content-type` case-insensitive in practice, but this matches the SUT's lowercase.

7. [low] file: telemetry.test.ts:72-76, 91-95, 123-125 — **Timestamp equality is fine; also assert metric type and series shape**
   - You assert `metric`, `value`, `timestamp` and `tags`. The SUT hardcodes `type: 3` and the Datadog v2 series shape. Adding `expect(body.series[0].type).toBe(3)` would catch accidental regressions without over-coupling to unrelated fields.
   - Fix: add a small shape check in one of the positive cases.

8. [med] file: telemetry.test.ts:1-1 — **Import style matches existing tests**
   - Using `./telemetry.js` extension is consistent with `kit.test.ts` (e.g. `./retry.js`, `./alert.js`). Type-only import `type RejectReason` is fine under TypeScript strict. No compile blockers apparent if the package uses ESM and `moduleResolution: bundler`/NodeNext, but ensure this new file is picked up by the existing `vitest.config.ts` include (`packages/**/*.test.ts`) — it is. Also `git apply --check: OK` matches applyability.

---

Notes on the stated task scope: "Only add the test file; do not modify telemetry.ts." The above requests changes to the *test* (not the implementation). In particular (1) and (3) adjust the tests to actually verify the payload structure/tags and cover `onProviderError` rather than relying on a vacuous string-based leak test. (2) makes the "swallowed rejection" assertion deterministic and meaningful. If the instruction is to keep the test file exactly as written, (1) is the strongest correctness issue relative to "actually test the stated behavior".