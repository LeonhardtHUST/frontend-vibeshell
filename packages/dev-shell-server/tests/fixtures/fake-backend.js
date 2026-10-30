#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
if (argv.includes("--version")) { console.log(process.env.FAKE_BACKEND_VERSION ?? "2.1.4"); process.exit(0); }
if (argv.includes("--help")) { console.log("fake backend CLI"); process.exit(0); }
const codex = argv[0] === "exec";
const option = key => argv[argv.indexOf(key) + 1];
const nativeSessionId = codex ? `thread-${randomUUID()}` : option("--session");
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const report = { argv, prompt, cwd: process.cwd(), pid: process.pid, nativeSessionId,
  env: { agentToken: process.env.DEV_SHELL_AGENT_TOKEN, configContent: process.env.OPENCODE_CONFIG_CONTENT,
    projectConfigDisabled: process.env.OPENCODE_CONFIG_PROJECT_DISABLE, home: process.env.HOME, codexHome: process.env.CODEX_HOME } };
if (process.env.FAKE_BACKEND_REPORT) writeFileSync(process.env.FAKE_BACKEND_REPORT, JSON.stringify(report));
if (process.env.FAKE_BACKEND_SPAWNS) appendFileSync(process.env.FAKE_BACKEND_SPAWNS, `${JSON.stringify({nativeSessionId, pid: process.pid})}\n`);
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const mode = process.env.FAKE_BACKEND_MODE ?? "success";
const reply = mode === "smoke" ? (prompt.includes("DEV_SHELL_PLAIN_OK") ? "DEV_SHELL_PLAIN_OK" : "DEV_SHELL_MCP_OK") : `hello ${process.env.DEV_SHELL_AGENT_TOKEN}`;
if (codex) write({ type: "thread.started", thread_id: nativeSessionId });
else write({ type: "step_start", sessionID: nativeSessionId, timestamp: 0, part: { type: "step-start" } });
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "failure") {
  if (codex) write({ type: "turn.failed", error: { message: "Provider error" } });
  else write({ type: "error", sessionID: nativeSessionId, error: { name: "ProviderError", data: { message: "Provider error" } } });
} else if (mode === "partial") {
  if (!codex) write({ type: "step_finish", sessionID: nativeSessionId, part: { type: "step-finish", reason: "tool-calls" } });
} else if (mode === "completed-text" || mode === "incomplete-text") {
  write({type: "text", sessionID: nativeSessionId, part: {type: "text", text: "A completed response", time: {start: 1, ...(mode === "completed-text" ? {end: 2} : {})}}});
} else {
  write({ type: "future_protocol_event", nested: { keep: 42, token: process.env.DEV_SHELL_AGENT_TOKEN } });
  if (codex) {
    write({ type: "item.completed", item: { id: "tool", type: "mcp_tool_call", server: "dev-shell", tool: "visitor_me", status: "completed" } });
    write({ type: "item.completed", item: { id: "text", type: "agent_message", text: reply } });
    write({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  } else {
    write({ type: "tool_use", sessionID: nativeSessionId, part: { type: "tool", tool: "dev-shell_visitor_me", state: { status: "completed", input: {}, output: "ok" } } });
    write({ type: "step_finish", sessionID: nativeSessionId, part: { type: "step-finish", reason: "tool-calls" } });
    write({ type: "text", sessionID: nativeSessionId, part: { type: "text", text: reply } });
    write({ type: "step_finish", sessionID: nativeSessionId, part: { type: "step-finish", reason: "stop", tokens: { input: 1, output: 1 } } });
  }
}
