#!/usr/bin/env node
/**
 * Scaffold a new conversational connector:
 *   npx tsx scripts/create-connector.ts <id> --provider <name> --verification <twilio-signature|slack-v0|svix|vercel-oidc|hmac-sha256>
 * Writes connectors/<id>/{manifest.ts,handlers.ts,channel.ts,__tests__/gate.test.ts,README.md}
 * and agent/channels/<id>.ts. New connectors start at status "source"; the launch gate
 * (runConnectorContract) must pass before "typechecked", and a recorded live round trip before "live-verified".
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function renderConnector(id: string, provider: string, verification: string): Record<string, string> {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) throw new Error(`invalid connector id: ${id}`);
  const route = `/connectors/${id}/inbound`;
  const camel = id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  const ENV = id.toUpperCase().replace(/-/g, "_");
  return {
    [`connectors/${id}/manifest.ts`]: `import { defineConnectorManifest } from "../../packages/connector-kit/src/manifest.js";

export const manifest = defineConnectorManifest({
  id: "${id}",
  version: "0.1.0",
  status: "source",
  provider: "${provider}",
  kind: "conversational",
  auth: { outbound: "connect-or-portable" },
  inbound: { route: "${route}", verification: "${verification}", dedupeKey: "TODO provider message id", events: ["TODO"] },
  outbound: { actions: ["reply"], threading: "TODO" },
  allowlist: { kind: "TODO", configKey: "TARX_${ENV}_ALLOW_FROM" },
  env: ["${ENV}_API_KEY", "${ENV}_WEBHOOK_SECRET", "TARX_${ENV}_ALLOW_FROM"],
});
`,
    [`connectors/${id}/handlers.ts`]: `// Pure, provider-specific helpers (parse, sender check, threading). Keep them side-effect free and unit-tested.
export function parseInbound(_body: unknown): { messageId: string; sender: string; text: string; threadToken: string } | null {
  throw new Error("TODO: parse ${provider} webhook payload");
}
`,
    [`connectors/${id}/channel.ts`]: `import { defineChannel, POST } from "eve/channels";
import type { ConnectorRuntime } from "../../packages/connector-kit/src/runtime.js";

export const ${camel.toUpperCase()}_ROUTE = "${route}";

/** Copy the shape of connectors/email-resend/channel.ts: verify -> dedupe -> ack 200 -> waitUntil(turn). */
export function ${camel}Channel(_o: { runtime: ConnectorRuntime }) {
  return defineChannel({
    turnPolicy: "queue",
    routes: [POST(${camel.toUpperCase()}_ROUTE, async () => new Response("not implemented", { status: 501 }))],
  });
}
`,
    [`connectors/${id}/__tests__/gate.test.ts`]: `import { it } from "vitest";
// Implement a ConnectorHarness (see connectors/email-resend/__tests__/gate.test.ts) and call
// runConnectorContract("${id}", harness) to enable the launch gate.
it.todo("${id}: launch gate");
`,
    [`connectors/${id}/README.md`]: `# ${id}\n\nProvider: ${provider}\nInbound route: \`${route}\` (verification: ${verification})\nStatus: source\n`,
    [`agent/channels/${id}.ts`]: `import { ${camel}Channel } from "../../connectors/${id}/channel.js";
import { runtime } from "../runtime.js";

export default ${camel}Channel({ runtime });
`,
  };
}

function main(argv: string[]) {
  const [id, ...rest] = argv;
  const flag = (k: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
  if (!id) { console.error("usage: create-connector <id> --provider <name> --verification <kind>"); process.exit(1); }
  const files = renderConnector(id, flag("provider") ?? id, flag("verification") ?? "hmac-sha256");
  for (const [path, body] of Object.entries(files)) {
    if (existsSync(path)) throw new Error(`refusing to overwrite ${path}`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
    console.log("created", path);
  }
}

if (process.argv[1]?.endsWith("create-connector.ts")) main(process.argv.slice(2));
