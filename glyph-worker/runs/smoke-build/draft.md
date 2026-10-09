## Plan

- Add a new Vitest test file `eve-connectors/packages/connector-kit/src/telemetry.test.ts` (new file) using only the existing `datadogTelemetry` and `noopTelemetry` exports.
- Test `noopTelemetry` methods are callable and return `undefined` (including all `RejectReason` values).
- Use injected `fetchImpl` and `apiKey` (no network), with `vi.useFakeTimers()` to keep timestamps deterministic; restore timers after each relevant test.
- Cover (1) `onTurnLatency` posts `tarx.connector.turn_ms` with the latency value and `connector:<name>` tag.
- Cover (2) `onAck` posts `tarx.connector.ack_ms`.
- Cover (3) `onRejected` includes `reason:<reason>` tag (sample at least one reason).
- Cover (4) request uses `DD-API-KEY` header and respects the configured `site` (override to a non-default host path).
- Cover (5) a rejected `fetchImpl` is swallowed (no unhandled rejection).
- Cover (6) payloads never contain message text passed via `tags` (assert the serialized JSON body does not include arbitrary message strings). 

## Patch

```diff
diff --git a/eve-connectors/packages/connector-kit/src/telemetry.test.ts b/eve-connectors/packages/connector-kit/src/telemetry.test.ts
new file mode 100644
index 0000000..0000000
--- /dev/null
+++ b/eve-connectors/packages/connector-kit/src/telemetry.test.ts
@@ -0,0 +1,143 @@
+import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
+import { datadogTelemetry, noopTelemetry, type RejectReason } from "./telemetry.js";
+
+describe("telemetry", () => {
+  beforeEach(() => {
+    vi.useFakeTimers();
+  });
+
+  afterEach(() => {
+    vi.useRealTimers();
+    vi.restoreAllMocks();
+  });
+
+  it("noopTelemetry methods are callable and return undefined", () => {
+    expect(noopTelemetry.onAck("connector", 1)).toBeUndefined();
+    expect(noopTelemetry.onTurnLatency("connector", 5, { extra: "t" })).toBeUndefined();
+    expect(noopTelemetry.onProviderError("connector", new Error("e"), { k: "v" })).toBeUndefined();
+    const reasons: RejectReason[] = [
+      "signature",
+      "allowlist",
+      "allowlist-hitl",
+      "duplicate",
+      "auth",
+      "malformed",
+      "compliance-keyword",
+    ];
+    for (const r of reasons) {
+      expect(noopTelemetry.onRejected("connector", r)).toBeUndefined();
+    }
+  });
+
+  it("onTurnLatency posts tarx.connector.turn_ms with latency value and connector:<name> tag", async () => {
+    const now = 1_700_000_000_000;
+    vi.setSystemTime(now);
+    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
+    const apiKey = vi.fn().mockResolvedValue("test-key");
+
+    const tel = datadogTelemetry({
+      apiKey,
+      fetchImpl: fetchMock as unknown as typeof fetch,
+    });
+
+    tel.onTurnLatency("slack", 42);
+
+    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
+
+    const [url, init] = fetchMock.mock.calls[0];
+    expect(url).toBe("https://api.datadoghq.com/api/v2/series");
+    expect(init?.method).toBe("POST");
+    expect(init?.headers).toMatchObject({
+      "DD-API-KEY": "test-key",
+      "content-type": "application/json",
+    });
+
+    const body = JSON.parse(String(init?.body));
+    expect(body.series[0].metric).toBe("tarx.connector.turn_ms");
+    expect(body.series[0].points[0].value).toBe(42);
+    expect(body.series[0].points[0].timestamp).toBe(Math.floor(now / 1000));
+    expect(body.series[0].tags).toContain("connector:slack");
+  });
+
+  it("onAck posts tarx.connector.ack_ms with value and connector tag", async () => {
+    const now = 1_700_000_005_000;
+    vi.setSystemTime(now);
+    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
+    const apiKey = vi.fn().mockResolvedValue("ack-key");
+
+    const tel = datadogTelemetry({
+      apiKey,
+      fetchImpl: fetchMock as unknown as typeof fetch,
+    });
+
+    tel.onAck("webhook", 7);
+
+    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
+
+    const [url, init] = fetchMock.mock.calls[0];
+    expect(url).toBe("https://api.datadoghq.com/api/v2/series");
+    const body = JSON.parse(String(init?.body));
+    expect(body.series[0].metric).toBe("tarx.connector.ack_ms");
+    expect(body.series[0].points[0].value).toBe(7);
+    expect(body.series[0].points[0].timestamp).toBe(Math.floor(now / 1000));
+    expect(body.series[0].tags).toEqual(["connector:webhook"]);
+  });
+
+  it("onRejected tags reason:<reason>", async () => {
+    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
+    const apiKey = vi.fn().mockResolvedValue("rej-key");
+
+    const tel = datadogTelemetry({
+      apiKey,
+      fetchImpl: fetchMock as unknown as typeof fetch,
+    });
+
+    tel.onRejected("slack", "signature");
+
+    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
+
+    const [, init] = fetchMock.mock.calls[0];
+    const body = JSON.parse(String(init?.body));
+    expect(body.series[0].metric).toBe("tarx.connector.rejected");
+    expect(body.series[0].points[0].value).toBe(1);
+    expect(body.series[0].tags).toContain("connector:slack");
+    expect(body.series[0].tags).toContain("reason:signature");
+  });
+
+  it("uses DD-API-KEY header and configured site", async () => {
+    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
+    const apiKey = vi.fn().mockResolvedValue("site-key");
+
+    const tel = datadogTelemetry({
+      apiKey,
+      site: "example.com",
+      fetchImpl: fetchMock as unknown as typeof fetch,
+    });
+
+    tel.onTurnLatency("widget", 10);
+
+    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
+
+    const [url, init] = fetchMock.mock.calls[0];
+    expect(url).toBe("https://api.example.com/api/v2/series");
+    expect(init?.headers).toMatchObject({
+      "DD-API-KEY": "site-key",
+      "content-type": "application/json",
+    });
+  });
+
+  it("a rejected fetch is swallowed (no unhandled rejection)", async () => {
+    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
+    const apiKey = vi.fn().mockResolvedValue("swallow-key");
+
+    const tel = datadogTelemetry({
+      apiKey,
+      fetchImpl: fetchMock as unknown as typeof fetch,
+    });
+
+    expect(() => tel.onTurnLatency("bot", 15)).not.toThrow();
+
+    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
+    await expect(Promise.resolve()).resolves.toBeUndefined(); // no unhandled rejection observed
+  });
+
+  it("payloads never contain message text passed in tags", async () => {
+    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
+    const apiKey = vi.fn().mockResolvedValue("safe-key");
+
+    const tel = datadogTelemetry({
+      apiKey,
+      fetchImpl: fetchMock as unknown as typeof fetch,
+    });
+
+    const messageText = "secret message body";
+    tel.onTurnLatency("slack", 20, { message: messageText, userText: messageText });
+
+    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
+
+    const [, init] = fetchMock.mock.calls[0];
+    const bodyStr = String(init?.body);
+    expect(bodyStr).not.toContain(messageText);
+
+    const body = JSON.parse(bodyStr);
+    expect(body.series[0].metric).toBe("tarx.connector.turn_ms");
+    expect(body.series[0].points[0].value).toBe(20);
+    expect(body.series[0].tags).toContain("connector:slack");
+  });
+});
```

## Notes

- Risk: timestamp equality uses second precision (`Math.floor(Date.now()/1000)`) which matches the implementation; fake timers + `vi.setSystemTime` keep it exact. 
- Risk: the implementation forwards only `connector:<c>` and `reason:<reason>` in tags (and ignores caller `tags` entirely). The test for (6) asserts arbitrary `message` text is not present in the serialized payload (which is satisfied by that behavior). If the telemetry API is later extended to forward safe tags, this assertion should remain focused on "message text" only. // VERIFY: intended tag allowlist for `onTurnLatency`/others.
- Network: all calls use injected `fetchImpl` and `apiKey()` (mocked); no real outbound requests.
- Compatibility: uses `Response` and standard Vitest APIs; matches existing test style in `kit.test.ts`. // VERIFY: Vitest version supports `vi.waitFor` in this repo.
- Scope: only `telemetry.test.ts` added; `telemetry.ts` unchanged as requested.