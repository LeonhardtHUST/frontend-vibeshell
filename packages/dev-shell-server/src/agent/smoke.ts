import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentBackend, Settings } from "@hustradio/dev-shell-contract";
import { AgentSupervisor } from "./supervisor.js";
import { resolveAgentExecutable } from "./executable.js";
import { backendErrorPrefix } from "./backends.js";
import { managedProcess, terminateProcessTree } from "./process-tree.js";
import type { AgentSessionState } from "./types.js";

export interface CodeBuddySmokeOptions {
  backend?: AgentBackend;
  dataDir: string;
  mcpUrl: string;
  agentToken: string;
  agentVisitorId: string;
  executable?: string;
  codexExecutable?: string;
  opencodeExecutable?: string;
  model?: string | null;
  timeoutMs?: number;
  /** Counts actual visitor_me requests for this smoke identity at the MCP adapter. */
  wasVisitorMeCalled?: () => boolean;
}

export interface CodeBuddySmokeResult {
  ok: boolean;
  help: boolean;
  mcp: { state: AgentSessionState; toolObserved: boolean; outputKinds: string[]; error?: string; diagnostics?: SmokeDiagnostic[] };
  plain: { state: AgentSessionState; replyObserved: boolean; outputKinds: string[]; error?: string; diagnostics?: SmokeDiagnostic[] };
}

export interface SmokeDiagnostic {
  stream: string;
  kind: string;
  type?: string;
  subtype?: string;
  keys?: string[];
  part?: { type?: string; keys: string[]; finish?: string; tool?: string };
  info?: { type?: string; keys: string[]; finish?: string };
  item?: { type?: string; keys: string[]; tool?: string };
  finish?: string;
  errorCategory?: string;
}

export type AgentSmokeOptions = CodeBuddySmokeOptions;
export type AgentSmokeResult = CodeBuddySmokeResult;

const failureCode = (text: string, backend: AgentBackend) => {
  const prefix = backendErrorPrefix(backend);
  if (/429|quota|额度|余额|insufficient.{0,20}credit|credit.{0,20}(?:exhaust|insufficient)|resource_exhausted/i.test(text)) return `${prefix}_QUOTA_EXHAUSTED`;
  if (/401|403|not logged|unauthenticated|authentication|登录/i.test(text)) return `${prefix}_AUTH_REQUIRED`;
  if (/approval|permission to|not (?:available|exposed)|cannot.{0,50}(?:call|tool)|unable.{0,50}tool/i.test(text)) return `${prefix}_TOOL_UNAVAILABLE_OR_DENIED`;
  if (/timeout|timed out|network|fetch|ECONN|ENOTFOUND/i.test(text)) return `${prefix}_NETWORK_OR_TIMEOUT`;
  return text.match(/\b(?:CODEBUDDY|CODEX|OPENCODE|MCP_CONFIG|WORKSPACE)_[A-Z0-9_]+\b/)?.[0] ?? `${prefix}_SMOKE_FAILED`;
};

const failurePriority = (code: string) => /QUOTA|AUTH_REQUIRED|V2_REQUIRED|VERSION_CHECK/.test(code) ? 4 : /NETWORK_OR_TIMEOUT|TOOL_UNAVAILABLE_OR_DENIED/.test(code) ? 3 : /NOT_FOUND|RESOLUTION|CONFIG|WORKSPACE/.test(code) ? 2 : /RESULT_ERROR|EXIT_|SPAWN_FAILED|TIMEOUT/.test(code) ? 1 : 0;
const metadata = (value: unknown): string | undefined => typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,100}$/.test(value) ? value : undefined;
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const keys = (value: Record<string, unknown>) => Object.keys(value).map(metadata).filter((key): key is string => key !== undefined).slice(0, 24);

function diagnostic(event: import("./types.js").AgentOutputEvent, errorCategory?: string): SmokeDiagnostic {
  const raw = record(event.raw); const part = record(raw?.part); const info = record(raw?.info); const item = record(raw?.item);
  return {
    stream: event.stream, kind: event.kind,
    ...(raw ? { type: metadata(raw.type), subtype: metadata(raw.subtype), keys: keys(raw) } : {}),
    ...(part ? { part: { type: metadata(part.type), keys: keys(part), finish: metadata(part.reason ?? part.finish ?? part.finishReason), tool: metadata(part.tool) } } : {}),
    ...(info ? { info: { type: metadata(info.type), keys: keys(info), finish: metadata(info.finish ?? info.finishReason ?? info.reason) } } : {}),
    ...(item ? { item: { type: metadata(item.type), keys: keys(item), tool: metadata(item.tool) } } : {}),
    ...(metadata(raw?.finish ?? raw?.reason ?? raw?.finishReason) ? { finish: metadata(raw?.finish ?? raw?.reason ?? raw?.finishReason) } : {}),
    ...(errorCategory ? { errorCategory } : {}),
  };
}

export async function runAgentSmoke(options: AgentSmokeOptions): Promise<AgentSmokeResult> {
  const backend = options.backend ?? "codebuddy";
  const configured = options.executable ?? (backend === "codex" ? options.codexExecutable ?? "codex" : backend === "opencode-v2" ? options.opencodeExecutable ?? "opencode" : "codebuddy");
  const executable = await resolveAgentExecutable(configured, backend);
  const timeoutMs = options.timeoutMs ?? 90_000;
  const workspace = path.join(options.dataDir, "workspace");
  await mkdir(workspace, { recursive: true });
  const help = await new Promise<boolean>((resolve) => {
    const launch = managedProcess(executable.command, [...executable.args, "--help"], workspace, process.env);
    const child = spawn(launch.command, launch.args, { env: launch.env, shell: false, windowsHide: true, cwd: workspace, stdio: "ignore", detached: process.platform !== "win32" });
    const timer = setTimeout(() => { void terminateProcessTree(child); }, Math.min(timeoutMs, 15_000));
    child.once("error", () => { clearTimeout(timer); resolve(false); });
    child.once("close", code => { clearTimeout(timer); resolve(code === 0); });
  });
  const settings: Settings = {
    defaultTarget: "http://127.0.0.1:1", allowedOrigins: [], workspace,
    backend, codebuddyExecutable: backend === "codebuddy" ? configured : "codebuddy",
    codexExecutable: backend === "codex" ? configured : options.codexExecutable,
    opencodeExecutable: backend === "opencode-v2" ? configured : options.opencodeExecutable,
    model: options.model ?? null,
    permissionMode: "plan", timeoutMs, maxConcurrent: 1, theme: "system", longPressMs: 500,
  };
  const run = async (mode: "mcp" | "plain") => {
    const id = randomUUID();
    let state: AgentSessionState = "queued";
    let replyObserved = false;
    let error: string | undefined;
    const kinds = new Set<string>();
    const diagnostics: SmokeDiagnostic[] = [];
    const seenDiagnostics = new Set<string>();
    const supervisor = new AgentSupervisor({
      dataDir: options.dataDir, mcpUrl: options.mcpUrl,
      onState: (_id, next) => { state = next; },
      onOutput: (_id, event) => {
        kinds.add(event.kind);
        const text = JSON.stringify(event.raw);
        if (event.kind === "assistant" || event.kind === "tool") {
          replyObserved ||= /(?:DEV_SHELL_MCP_OK|DEV_SHELL_PLAIN_OK)/.test(text);
        }
        const candidate = failureCode(text, backend);
        const failed = event.kind === "error" || event.stream === "stderr" || event.normalized?.isError === true || /"is_error":true/.test(text);
        if ((failed || failurePriority(candidate) >= 3) && (!error || failurePriority(candidate) > failurePriority(error))) error = candidate;
        const shape = diagnostic(event, failed || failurePriority(candidate) >= 3 ? candidate : undefined);
        const signature = JSON.stringify(shape);
        if (diagnostics.length < 32 && !seenDiagnostics.has(signature)) { seenDiagnostics.add(signature); diagnostics.push(shape); }
      },
    });
    try {
      await supervisor.start({ sessionId: id, cliSessionId: randomUUID(), backend, creatorId: options.agentVisitorId,
        agentVisitorId: options.agentVisitorId, agentToken: options.agentToken, workspace, settings,
        readOnlySmoke: mode,
        prompt: mode === "mcp"
          ? "Use only the dev-shell MCP visitor_me tool once to read your identity, then reply DEV_SHELL_MCP_OK. Do not read files, modify files, execute commands, contact other tools or send any messages."
          : "Do not use any tools. Reply exactly DEV_SHELL_PLAIN_OK.",
      });
      await supervisor.wait(id);
      const finalState = state as AgentSessionState;
      if (finalState === "succeeded") error = undefined;
      return { state: finalState, toolObserved: false, replyObserved, outputKinds: [...kinds].sort(), diagnostics, ...(error ? { error } : {}) };
    } finally { await supervisor.close(); }
  };
  const mcp = await run("mcp");
  // A server-side observation is authoritative; stdout merely shows intent.
  mcp.toolObserved = options.wasVisitorMeCalled?.() ?? false;
  const plain = await run("plain");
  return { ok: help && mcp.state === "succeeded" && mcp.toolObserved && plain.state === "succeeded" && plain.replyObserved,
    help, mcp: { state: mcp.state, toolObserved: mcp.toolObserved, outputKinds: mcp.outputKinds, diagnostics: mcp.diagnostics, ...(mcp.error ? { error: mcp.error } : {}) },
    plain: { state: plain.state, replyObserved: plain.replyObserved, outputKinds: plain.outputKinds, diagnostics: plain.diagnostics, ...(plain.error ? { error: plain.error } : {}) } };
}

/** Backwards-compatible CodeBuddy entry point; omitted backend remains CodeBuddy. */
export const runCodeBuddySmoke = runAgentSmoke;
