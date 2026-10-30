import type { AgentBackend } from "@hustradio/dev-shell-contract";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { createMcpConfig } from "./mcp-config.js";
import { resolveAgentExecutable } from "./executable.js";
import type { ResolvedExecutable } from "./executable.js";
import type { StartAgentOptions } from "./types.js";
import { managedProcess } from "./process-tree.js";

export interface AgentLaunch {
  backend: AgentBackend;
  executable: ResolvedExecutable;
  args: string[];
  env: NodeJS.ProcessEnv;
  configFile?: string;
}

export const backendErrorPrefix = (backend: AgentBackend) => backend === "codex" ? "CODEX" : backend === "opencode-v2" ? "OPENCODE" : "CODEBUDDY";
const execute = promisify(execFile);
const versions = new Map<string, Promise<void>>();

async function requireOpenCodeV2(executable: ResolvedExecutable, workspace: string): Promise<void> {
  const entry = executable.args[0] ?? executable.command;
  const metadata = await stat(entry).catch(() => undefined);
  const key = JSON.stringify([executable.command, executable.args, metadata?.mtimeMs, metadata?.size]);
  let check = versions.get(key);
  if (!check) {
    const launch = managedProcess(executable.command, [...executable.args, "--version"], workspace, process.env);
    check = execute(launch.command, launch.args, { env: launch.env, cwd: workspace, windowsHide: true, killSignal: "SIGKILL", timeout: 10_000, maxBuffer: 32 * 1024 })
      .then(({stdout}) => {
        const version = stdout.trim().match(/(?:^|\s)v?(\d+)\.\d+\.\d+(?:[-+][\w.-]+)?(?:$|\s)/);
        if (!version) throw new Error("OPENCODE_VERSION_CHECK_FAILED");
        if (version[1] !== "2") throw new Error("OPENCODE_V2_REQUIRED");
      })
      .catch(error => { versions.delete(key); throw error instanceof Error && error.message.startsWith("OPENCODE_") ? error : new Error("OPENCODE_VERSION_CHECK_FAILED"); });
    versions.set(key, check);
  }
  await check;
}

export async function prepareAgentLaunch(options: StartAgentOptions, dataDir: string, mcpUrl: string): Promise<AgentLaunch> {
  const backend = options.backend ?? options.settings.backend ?? "codebuddy";
  if (!["codebuddy", "codex", "opencode-v2"].includes(backend)) throw new Error("AGENT_BACKEND_INVALID");
  const url = new URL(mcpUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !options.agentToken || /[\r\n\0]/.test(options.agentToken)) throw new Error("MCP_CONFIG_INVALID");
  const configured = backend === "codex" ? options.settings.codexExecutable ?? "codex" : backend === "opencode-v2" ? options.settings.opencodeExecutable ?? "opencode" : options.settings.codebuddyExecutable;
  const executable = await resolveAgentExecutable(configured, backend);
  const env = { ...process.env };
  if (backend === "codebuddy") {
    const configFile = await createMcpConfig(dataDir, options.sessionId, mcpUrl, options.agentToken);
    const args = [
      "--session-id", options.cliSessionId ?? options.sessionId, "--print",
      "--input-format", "text", "--output-format", "stream-json", "--mcp-config", configFile,
      "--strict-mcp-config", "--permission-mode", options.settings.permissionMode,
    ];
    if (options.readOnlySmoke) args.push("--no-session-persistence", "--tools", "", "--max-turns", options.readOnlySmoke === "mcp" ? "4" : "1");
    if (options.readOnlySmoke === "mcp") args.push("--allowedTools", "mcp__dev-shell__visitor_me");
    if (options.settings.model) args.push("--model", options.settings.model);
    return { backend, executable, args, env, configFile };
  }
  env.DEV_SHELL_AGENT_TOKEN = options.agentToken;
  if (backend === "codex") {
    // Inline TOML is CLI configuration, never shell text. Replace the complete
    // MCP table so project/user servers cannot inherit this visitor's identity.
    const mcp = options.readOnlySmoke === "plain" ? "mcp_servers={}"
      : `mcp_servers={dev-shell={url=${JSON.stringify(url.toString())},bearer_token_env_var="DEV_SHELL_AGENT_TOKEN",required=true${options.readOnlySmoke === "mcp" ? ',enabled_tools=["visitor_me"]' : ""}}}`;
    const args = ["exec", "--ignore-user-config", "--json", "--ephemeral", "--skip-git-repo-check",
      "--sandbox", options.settings.permissionMode === "acceptEdits" && !options.readOnlySmoke ? "workspace-write" : "read-only",
      "-c", 'approval_policy="never"', "-c", mcp];
    if (options.readOnlySmoke) {
      for (const feature of ["shell_tool", "unified_exec", "multi_agent", "apps", "view_image", "hooks"]) args.push("-c", `features.${feature}=false`);
      args.push("-c", 'web_search="disabled"');
    }
    if (options.settings.model) args.push("--model", options.settings.model);
    args.push("-");
    return { backend, executable, args, env };
  }
  await requireOpenCodeV2(executable, options.workspace);
  const canEdit = options.settings.permissionMode === "acceptEdits" && !options.readOnlySmoke;
  const permissions = options.readOnlySmoke ? [
    { action: "*", resource: "*", effect: "deny" },
    ...(options.readOnlySmoke === "mcp" ? [{ action: "dev-shell_visitor_me", resource: "*", effect: "allow" }] : []),
  ] : [
    { action: "*", resource: "*", effect: "ask" },
    ...["read", "glob", "grep"].map(action => ({ action, resource: "*", effect: "allow" })),
    { action: "edit", resource: "*", effect: canEdit ? "allow" : "deny" },
    { action: "shell", resource: "*", effect: "ask" },
    { action: "external_directory", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "dev-shell_*", resource: "*", effect: "allow" },
    { action: "opencode_list_mcp_resources", resource: "dev-shell", effect: "allow" },
    { action: "opencode_read_mcp_resource", resource: "dev-shell:*", effect: "allow" },
  ];
  // V2's headless run rejects permission requests unless --auto is supplied.
  // Keep provider/auth configuration available, but block other MCP servers and
  // arbitrary plugins from loading through the inline integration policy.
  env.OPENCODE_CONFIG_PROJECT_DISABLE = "1";
  env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    mcp: { servers: { "dev-shell": {
      type: "remote", url: url.toString(), oauth: false, protocol: "legacy", codemode: false,
      headers: { Authorization: "Bearer {env:DEV_SHELL_AGENT_TOKEN}" },
      ...(options.readOnlySmoke === "plain" ? { disabled: true } : {}),
    } } },
    permissions,
    agents: { build: { permissions }, plan: { permissions } },
    policies: [
      { action: "integration.use", resource: "mcp:*", effect: "deny" },
      { action: "integration.use", resource: "mcp:dev-shell", effect: "allow" },
      { action: "integration.use", resource: "plugin:*", effect: "deny" },
      { action: "integration.use", resource: "plugin:opencode.provider.*", effect: "allow" },
      { action: "integration.use", resource: "plugin:opencode.config.policy", effect: "allow" },
    ],
  });
  const nativeSessionId = `ses_${(options.cliSessionId ?? options.sessionId).replace(/-/g, "")}`;
  const args = ["run", "--standalone", "--format", "json", "--session", nativeSessionId,
    "--agent", options.settings.permissionMode === "plan" || options.readOnlySmoke ? "plan" : "build"];
  if (options.settings.model) args.push("--model", options.settings.model);
  // OpenCode reads non-TTY stdin itself. A positional '-' would become prompt text.
  return { backend, executable, args, env };
}
