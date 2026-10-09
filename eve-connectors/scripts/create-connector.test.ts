import { expect, it } from "vitest";
import { renderConnector } from "./create-connector.js";
it("renders a connector skeleton and rejects bad ids", () => {
  const files = renderConnector("telegram-bot", "telegram", "hmac-sha256");
  expect(Object.keys(files)).toContain("connectors/telegram-bot/manifest.ts");
  expect(files["agent/channels/telegram-bot.ts"]).toContain("telegramBotChannel");
  expect(() => renderConnector("Bad Id", "x", "svix")).toThrow();
});
