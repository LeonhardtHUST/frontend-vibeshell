import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentBackendSchema, type Settings } from "@hustradio/dev-shell-contract";

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  webDistDir: string;
  workspace: string;
  defaultTarget: string;
  allowedOrigins: string[];
  shellAllowedOrigins: string[];
  targetAllowedOrigins: string[];
  startupSettings: Partial<Pick<Settings, "backend" | "defaultTarget">>;
}

export function packageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "@hustradio/dev-shell") return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Dev Shell package manifest not found");
    directory = parent;
  }
}

export function canonicalWorkspace(directory: string): string {
  return realpathSync(resolve(directory));
}

export function workspaceKey(workspace: string): string {
  const normalized = process.platform === "win32" ? workspace.toLowerCase() : workspace;
  return createHash("sha256").update(normalized).digest("hex");
}

export function defaultDataDirectory(workspace: string): string {
  const stateRoot = process.platform === "win32" ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local")
    : process.platform === "darwin" ? join(homedir(), "Library/Application Support")
      : process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state");
  return join(stateRoot, "dev-shell/workspaces", workspaceKey(workspace));
}

export function parsePort(value: string | undefined, fallback = 5274): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error("DEV_SHELL_PORT must be a valid port");
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error("DEV_SHELL_PORT must be a valid port");
  return parsed;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const host = overrides.host ?? process.env.DEV_SHELL_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("Dev Shell must listen on a loopback address");
  const port = overrides.port ?? parsePort(process.env.DEV_SHELL_PORT);
  const workspace = canonicalWorkspace(overrides.workspace ?? process.env.DEV_SHELL_WORKSPACE ?? process.cwd());
  const shellAllowedOrigins = overrides.shellAllowedOrigins ?? overrides.allowedOrigins ?? [`http://${host === "::1" ? "[::1]" : host}:${port}`, "http://127.0.0.1:5273"];
  const explicitTarget = overrides.defaultTarget ?? overrides.startupSettings?.defaultTarget ?? process.env.DEV_SHELL_TARGET;
  const defaultTarget = explicitTarget ?? `http://127.0.0.1:${port}/fixture`;
  const target = new URL(defaultTarget);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error("Target must be an HTTP(S) URL without credentials");
  const explicitBackend = overrides.startupSettings?.backend ?? process.env.DEV_SHELL_BACKEND;
  const dataDir = resolve(overrides.dataDir ?? process.env.DEV_SHELL_DATA_DIR ?? defaultDataDirectory(workspace));
  const config: ServerConfig = {
    host,
    port,
    dataDir,
    databasePath: resolve(overrides.databasePath ?? process.env.DEV_SHELL_DATABASE ?? resolve(dataDir, "workbench.sqlite")),
    webDistDir: resolve(overrides.webDistDir ?? join(packageRoot(), "dist/web")),
    workspace,
    defaultTarget,
    allowedOrigins: shellAllowedOrigins,
    shellAllowedOrigins,
    targetAllowedOrigins: overrides.targetAllowedOrigins ?? [new URL(defaultTarget).origin],
    startupSettings: {
      ...(explicitTarget ? {defaultTarget: target.href} : {}),
      ...(explicitBackend ? {backend: agentBackendSchema.parse(explicitBackend)} : {}),
    },
  };
  return config;
}
