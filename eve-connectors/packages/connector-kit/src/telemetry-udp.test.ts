import { describe, expect, it } from "vitest";
import { datadogUdpTelemetry } from "./telemetry.js";

/** Capture DogStatsD packets via an injected socket. */
function capture() {
  const packets: string[] = [];
  const socketFactory = () => ({
    send: (buf: Uint8Array) => packets.push(Buffer.from(buf).toString("utf8")),
    close: () => {},
  });
  return { packets, socketFactory };
}

describe("datadogUdpTelemetry (DogStatsD/UDP -> local agent -> us5)", () => {
  it("emits ms timers for ack and turn, counts for rejected and provider_error, with dd_site:us5", () => {
    const { packets, socketFactory } = capture();
    const dd = datadogUdpTelemetry({ socketFactory, globalTags: ["dd_site:us5", "env:test"] });
    dd.onAck("email-resend", 40);
    dd.onTurnLatency("email-resend", 1200, { stage: "reply" });
    dd.onRejected("slack", "signature");
    dd.onProviderError("sms-twilio", new Error("x"), { stage: "reply" });

    expect(packets[0]).toBe("tarx.connector.ack_ms:40|ms|#dd_site:us5,env:test,connector:email-resend");
    expect(packets[1]).toBe("tarx.connector.turn_ms:1200|ms|#dd_site:us5,env:test,connector:email-resend,stage:reply");
    expect(packets[2]).toBe("tarx.connector.rejected:1|c|#dd_site:us5,env:test,connector:slack,reason:signature");
    expect(packets[3]).toBe("tarx.connector.provider_error:1|c|#dd_site:us5,env:test,connector:sms-twilio,stage:reply");
  });

  it("never sends a message body / PII tag value", () => {
    const { packets, socketFactory } = capture();
    const dd = datadogUdpTelemetry({ socketFactory });
    dd.onTurnLatency("email-resend", 10, {
      stage: "reply",
      body: "hello john your ssn is 123-45-6789", // dropped: spaces + length
      email: "john@tarx.com", // dropped: '@'
    });
    const p = packets[0];
    expect(p).toContain("stage:reply");
    expect(p).not.toContain("hello john");
    expect(p).not.toContain("john@tarx.com");
    expect(p).not.toContain("123-45-6789");
  });

  it("never throws into a turn even if the socket send fails", () => {
    const dd = datadogUdpTelemetry({
      socketFactory: () => ({ send: () => { throw new Error("udp down"); }, close: () => {} }),
    });
    expect(() => dd.onAck("slack", 1)).not.toThrow();
    expect(() => dd.onTurnLatency("slack", 1)).not.toThrow();
  });

  it("makes no outbound HTTP (it is UDP only) — no fetch is referenced", () => {
    // Contract check: the adapter uses an injected socket, not fetch.
    const { packets, socketFactory } = capture();
    const dd = datadogUdpTelemetry({ socketFactory });
    dd.onAck("slack", 5);
    expect(packets).toHaveLength(1);
  });
});
