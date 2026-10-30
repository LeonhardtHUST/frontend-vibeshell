import path from "node:path";
import { defineConfig } from "vitest/config";

const repository = path.resolve(import.meta.dirname, "../..");
export default defineConfig({
  root: import.meta.dirname,
  resolve: {alias: {
    "@hustradio/dev-shell-contract": path.join(repository, "packages/dev-shell-contract/src/index.ts"),
    "@shell": path.join(repository, "packages/dev-shell/src"),
  }},
  test: {environment: "jsdom", include: ["tests/unit/**/*.test.ts?(x)"], restoreMocks: true},
});
