import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: import.meta.dirname,
  resolve: { alias: { "@hustradio/dev-shell-contract": path.resolve(import.meta.dirname, "../dev-shell-contract/src/index.ts") } },
  test: {
    environment: "node",
    include: ["tests/{unit,integration}/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    restoreMocks: true,
    // Each Windows CLI starts a native Job launcher through Add-Type. Bound
    // simultaneous compiler processes so lifecycle deadlines measure the CLI.
    maxWorkers: process.platform === "win32" ? 2 : undefined,
  },
});
