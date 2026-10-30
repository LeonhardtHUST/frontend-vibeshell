import { parseArgs } from "node:util";
import { agentBackendSchema } from "@leonhardthust/frontend-vibeshell-contract";
import { parsePort, type ServerConfig } from "./config.js";

export const HELP = `Usage: frontend-vibeshell [start|dev] [options]
       frontend-vibeshell smoke:agents

The dev-shell command is a compatibility alias.

Options:
  --workspace <path>   Project directory (default: current directory)
  --target <url>       Preview URL; registers its exact origin
  --backend <name>     codebuddy | codex | opencode-v2
  --port <number>      Loopback HTTP port (default: 5274)
  --data-dir <path>    Existing or new workbench data directory
  --help              Show usage
  --version           Show version

CLI values override DEV_SHELL_* environment values and saved settings.
Model credentials remain managed by each installed coding CLI.
`;

export function parseCli(argv: string[]) {
  const {values, positionals} = parseArgs({args: argv, allowPositionals: true, options: {
    workspace: {type: "string"}, target: {type: "string"}, backend: {type: "string"},
    port: {type: "string"}, "data-dir": {type: "string"}, help: {type: "boolean", short: "h"}, version: {type: "boolean", short: "v"},
  }});
  const command = positionals[0] ?? "start";
  if (positionals.length > 1 || !["start", "dev", "smoke:agents", "smoke:codebuddy"].includes(command)) throw new Error(HELP);
  const config: Partial<ServerConfig> = {};
  if (values.workspace !== undefined) config.workspace = values.workspace;
  if (values.target !== undefined) config.defaultTarget = values.target;
  if (values.port !== undefined) config.port = parsePort(values.port);
  if (values["data-dir"] !== undefined) config.dataDir = values["data-dir"];
  if (values.backend !== undefined) config.startupSettings = {backend: agentBackendSchema.parse(values.backend)};
  return {command, config, help: values.help ?? false, version: values.version ?? false};
}
