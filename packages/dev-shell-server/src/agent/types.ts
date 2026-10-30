import type { AgentBackend, AgentSession, Settings } from "@hustradio/dev-shell-contract";

export type AgentSessionState = AgentSession["status"];

export interface AgentOutputEvent {
  stream: "stdout" | "stderr" | "system";
  raw: unknown;
  kind: "system" | "assistant" | "tool" | "result" | "stdout" | "stderr" | "warning" | "error";
  normalized?: Record<string, unknown>;
  truncated?: boolean;
}

export interface StartAgentOptions {
  sessionId: string;
  /** Frozen from the workbench session; later settings edits cannot switch it. */
  backend?: AgentBackend;
  cliSessionId?: string;
  creatorId: string;
  agentVisitorId: string;
  agentToken: string;
  prompt: string;
  workspace: string;
  settings: Settings;
  /** Internal CLI smoke only; never accepted from public session request DTOs. */
  readOnlySmoke?: "plain" | "mcp";
}

export interface CodeBuddySupervisorOptions {
  dataDir: string;
  mcpUrl: string;
  onOutput: (sessionId: string, event: AgentOutputEvent) => void;
  onState: (sessionId: string, state: AgentSessionState) => void;
  maxConcurrent?: () => number;
}
