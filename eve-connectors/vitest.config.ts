import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["packages/**/*.test.ts", "connectors/**/__tests__/**/*.test.ts", "scripts/**/*.test.ts"] } });
