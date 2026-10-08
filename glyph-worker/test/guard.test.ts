import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanText, assertPublic, isAllowedPath, readPublicFile, diffPaths, BoundaryError } from "../src/guard.ts";

const rules = (t: string, o = {}) => [...new Set(scanText(t, o).map((f) => f.rule))].sort();
// Fake secrets are assembled at runtime so this file itself never contains a token-shaped literal.
const fake = (prefix: string, body: string) => prefix + body;

test("blocks secret shapes", () => {
  assert.deepEqual(rules(fake("re_", "AbCd1234_QwErTyUiOpAsDfGh")), ["resend-key"]);
  assert.deepEqual(rules(fake("xoxb-", "1234567890-abcdefghij")), ["slack-token"]);
  assert.deepEqual(rules(fake("sk-", "proj-abcdefghijklmnop1234")), ["openai-like-key"]);
  assert.deepEqual(rules(fake("gh", "o_abcdefghijklmnopqrstuvwxyz0123")), ["github-token"]);
  assert.deepEqual(rules("AC" + "0123456789abcdef".repeat(2)), ["twilio-sid"]);
  assert.deepEqual(rules(fake("whsec_", "dGhpc2lzYXNlY3JldGtleTEyMw==")), ["svix-secret"]);
  assert.deepEqual(rules(fake("-----BEGIN RSA ", "PRIVATE KEY-----")), ["private-key"]);
  assert.deepEqual(rules(`apiKey = "${"Zz9".repeat(6)}"`), ["assigned-secret"]);
});

test("allows obvious placeholders used by public docs and tests", () => {
  assert.deepEqual(rules("RESEND_API_KEY=re_xxxxxxxxx SLACK_BOT_TOKEN=xoxb-placeholder whsec_test_secret_value_1234"), []);
  assert.deepEqual(rules("owner@example.com agent@in.example.com bot@users.noreply.github.com"), []);
  assert.deepEqual(rules("+15550000001 and (555) 010-2000 and 127.0.0.1:3000 and http://127.0.0.1:0/v1"), []);
});

test("blocks private infra, personal contact data, and deny terms", () => {
  // Negative fixtures are joined at runtime so this public file itself passes the guard.
  const j = (...p: string[]) => p.join("");
  assert.deepEqual(rules(j("ssh studio-", "PRIME")), ["private-host"]);
  assert.deepEqual(rules(j("ssh mac-mini", ".local now")), ["private-host"]);
  assert.deepEqual(rules("cp .env.example .env.local; ls config/.env.local"), []);
  assert.deepEqual(rules(j("http://192.", "168.1.20:8080")), ["private-ip"]);
  assert.deepEqual(rules(j("http://localhost:", "11500/v1")), ["local-port"]);
  assert.deepEqual(rules(j("/Use", "rs/someone/code")), ["home-path"]);
  assert.deepEqual(rules(j("https://abc123.ngrok", "-free.app/hook")), ["tunnel-host"]);
  assert.deepEqual(rules(j("write to someone", "@", "acme.io")), ["email"]);
  assert.deepEqual(rules(j("text me at +44 20 ", "7946 0123")), ["phone"]);
  assert.deepEqual(rules(j("call 312", "-867-", "5309")), ["phone"]);
  assert.deepEqual(rules("Project Nightjar launch", { denyTerms: ["nightjar"] }), ["deny-term"]);
});

test("assertPublic fails closed and never echoes the match", () => {
  const secret = fake("re_", "AbCd1234_QwErTyUiOpAsDfGh");
  assert.throws(() => assertPublic(`key ${secret}`, "prompt"), (e: unknown) => e instanceof BoundaryError && !e.message.includes(secret));
});

test("path allowlist and file reads", () => {
  const allow = ["eve-connectors/", "README.md"];
  assert.equal(isAllowedPath("eve-connectors/agent/agent.ts", allow), true);
  assert.equal(isAllowedPath("eve-connectors/.env.example", allow), true);
  assert.equal(isAllowedPath("eve-connectors/.env.local", allow), false);
  assert.equal(isAllowedPath("eve-connectors/.data/x.sqlite", allow), false);
  assert.equal(isAllowedPath("eve-connectors/node_modules/a.js", allow), false);
  assert.equal(isAllowedPath("../secrets.txt", allow), false);
  assert.equal(isAllowedPath("src/private.ts", allow), false);
  assert.equal(isAllowedPath("README.md", allow), true);

  const root = mkdtempSync(join(tmpdir(), "gw-root-"));
  const outside = mkdtempSync(join(tmpdir(), "gw-out-"));
  mkdirSync(join(root, "eve-connectors"));
  writeFileSync(join(root, "eve-connectors/ok.ts"), "export const x = 'owner@example.com';\n");
  writeFileSync(join(root, "eve-connectors/bad.ts"), "const host = 'box-" + "PRIME';\n");
  writeFileSync(join(outside, "secret.txt"), "nope");
  symlinkSync(join(outside, "secret.txt"), join(root, "eve-connectors/link.txt"));
  assert.equal(readPublicFile("eve-connectors/ok.ts", root, allow).rel, "eve-connectors/ok.ts");
  assert.throws(() => readPublicFile("eve-connectors/bad.ts", root, allow), BoundaryError);
  assert.throws(() => readPublicFile("eve-connectors/link.txt", root, allow), BoundaryError);
  assert.throws(() => readPublicFile("../" + outside.split("/").pop() + "/secret.txt", root, allow), BoundaryError);
});

test("diffPaths extracts both sides", () => {
  const d = "diff --git a/x/a.ts b/x/a.ts\n--- a/x/a.ts\n+++ b/x/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
  assert.deepEqual(diffPaths(d), ["x/a.ts"]);
});
