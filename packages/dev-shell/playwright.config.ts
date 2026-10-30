import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const repository = path.resolve(import.meta.dirname, "../..");

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: path.join(repository, ".scratch/dev-shell-browser/results"),
  fullyParallel: false,
  reporter: [["list"], ["json", {outputFile: path.join(repository, ".scratch/dev-shell-browser/report.json")}]],
  workers: 1,
  timeout: 40_000,
  expect: { timeout: 10_000 },
  use: {baseURL: "http://127.0.0.1:5273", browserName: "chromium", trace: "retain-on-failure", actionTimeout: 10_000, permissions: ["clipboard-read", "clipboard-write"]},
  projects: [1280, 1024, 1023, 390].flatMap(width => (["light", "dark"] as const).map(colorScheme => ({
    name: `${width}-${colorScheme}`,
    use: { ...(width === 390 ? devices["iPhone 13"] : devices["Desktop Chrome"]), browserName: "chromium" as const,
      viewport: {width, height: width === 390 ? 844 : 800}, colorScheme, hasTouch: width < 1024 },
  }))),
  webServer: [
    {command: "node --import tsx packages/dev-shell-server/tests/fixtures/browser-server.ts", cwd: repository, url: "http://127.0.0.1:5275/__test/health", reuseExistingServer: false, timeout: 60_000},
    {command: "node node_modules/vite/bin/vite.js --config packages/dev-shell/vite.config.ts", cwd: repository, url: "http://127.0.0.1:5273", reuseExistingServer: false, timeout: 60_000},
  ],
});
