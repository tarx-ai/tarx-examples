import { defineAgent } from "eve";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * Mode B: eve runs on the same host as the TARX runtime, so the model call is a loopback HTTP call
 * (no tunnel). ngrok only carries inbound provider webhooks. Set TARX_MODEL_BASE_URL to the local
 * OpenAI-compatible endpoint (".../v1"); verify with `npm run check:model`.
 */
const tarx = createOpenAICompatible({
  name: "tarx",
  baseURL: process.env.TARX_MODEL_BASE_URL ?? "http://127.0.0.1:0/v1", // placeholder; set via env
  apiKey: process.env.TARX_MODEL_API_KEY ?? "tarx-local",
});

export default defineAgent({
  model: tarx.chatModel(process.env.TARX_MODEL_ID ?? "tarx-default"),
  // Non-gateway models have no catalog metadata; eve needs the window to schedule compaction. VERIFY.
  modelContextWindowTokens: Number(process.env.TARX_MODEL_CONTEXT_TOKENS ?? 32768),
  // v0.1 is chat-only: no shell/file tools reachable from SMS/Slack/email. Add tools back deliberately.
  defaultTools: false,
});
