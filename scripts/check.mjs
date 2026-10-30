import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2];
const steps = mode === "typecheck"
  ? ["dev-shell-contract", "dev-shell-server", "dev-shell"].map(name => ["typescript/bin/tsc", "--noEmit", "-p", `packages/${name}/tsconfig.json`])
  : mode === "test"
    ? ["dev-shell-server", "dev-shell"].map(name => ["vitest/vitest.mjs", "run", "-c", `packages/${name}/vitest.config.ts`, "--reporter=default", "--reporter=json", `--outputFile=${path.join(root, ".scratch", `${name}-unit.json`)}`])
    : null;
if (!steps) throw new Error("Usage: check.mjs [typecheck|test]");
for (const [entry, ...args] of steps) {
  const result = spawnSync(process.execPath, [path.join(root, "node_modules", entry), ...args], {cwd: root, stdio: "inherit"});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
