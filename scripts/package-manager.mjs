import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Run package managers without a shell, including npm.cmd installations on Windows.
export function runManager(name, args, cwd) {
  let command;
  let prefix = [];
  for (const folder of (process.env.PATH ?? "").split(path.delimiter)) {
    const native = path.join(folder, process.platform === "win32" ? `${name}.exe` : name);
    if (existsSync(native)) {command = native; break;}
    if (process.platform !== "win32" || !existsSync(path.join(folder, `${name}.cmd`))) continue;
    const entry = name === "npm" ? "npm/bin/npm-cli.js" : "pnpm/bin/pnpm.cjs";
    const candidate = [path.join(folder, "node_modules", entry), path.join(folder, "..", entry)].find(existsSync);
    if (candidate) {command = process.execPath; prefix = [candidate]; break;}
  }
  if (!command) throw new Error(`Cannot locate a shell-free ${name} executable`);
  const result = spawnSync(command, [...prefix, ...args], {cwd, stdio: "inherit", env: process.env});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} exited with ${result.status}`);
}
