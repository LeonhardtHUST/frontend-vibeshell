import { build } from "esbuild";
import { build as buildWeb } from "vite";
import { chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
if (path.dirname(output) !== path.resolve(root)) throw new Error("Invalid build output");
await rm(output, {recursive: true, force: true});
await mkdir(path.join(output, "server"), {recursive: true});
await build({
  absWorkingDir: root,
  entryPoints: ["packages/dev-shell-server/src/cli.ts"],
  outfile: "dist/server/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.13",
  packages: "external",
  alias: {"@hustradio/dev-shell-contract": path.join(root, "packages/dev-shell-contract/src/index.ts")},
  banner: {js: "#!/usr/bin/env node"},
  logLevel: "info",
});
await chmod(path.join(output, "server/cli.js"), 0o755);
await copyFile(path.join(root, "packages/dev-shell-server/src/proxy/bridge.js"), path.join(output, "server/bridge.js"));
await buildWeb({configFile: path.join(root, "packages/dev-shell/vite.config.ts")});
const uiRoot = path.join(root, "node_modules/@hustradio/unitary-ui");
const notices = ["LICENSE", "OFL-1.1.txt", "THIRD_PARTY_NOTICES.en.md"];
await mkdir(path.join(output, "licenses/unitary-ui"), {recursive: true});
for (const name of notices) await copyFile(path.join(uiRoot, name), path.join(output, "licenses/unitary-ui", name));
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
await readFile(path.join(output, "web/index.html"));
console.log(`Built ${manifest.name}@${manifest.version}`);
