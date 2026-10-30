#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const read = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const configPath = read("--mcp-config");
const config = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : undefined;
const report = {
  argv: args,
  cwd: process.cwd(),
  prompt,
  config,
  pid: process.pid,
};
if (process.env.FAKE_CODEBUDDY_REPORT) writeFileSync(process.env.FAKE_CODEBUDDY_REPORT, JSON.stringify(report));
if (process.env.FAKE_CODEBUDDY_BROWSER_REPORT) appendFileSync(process.env.FAKE_CODEBUDDY_BROWSER_REPORT, `${JSON.stringify({ cliSessionId: read("--session-id"), prompt, pid: process.pid })}\n`);

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const result = () => write({ type: "result", subtype: "success", result: "ok", session_id: read("--session-id") });
const configuredMode = process.env.FAKE_CODEBUDDY_MODE ?? "success";
const mode = configuredMode === "browser" ? (prompt.includes("[[hang]]") ? "hang" : "success") : configuredMode;

if (mode === "hang") {
  write({ type: "system", subtype: "init", session_id: read("--session-id") });
  setInterval(() => {}, 1000);
} else if (mode === "tree") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(`${process.env.FAKE_CODEBUDDY_REPORT}.child`, String(child.pid));
  write({ type: "system", subtype: "init" });
  setInterval(() => {}, 1000);
} else if (mode === "orphan-pipes") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", process.stdout, process.stderr] });
  writeFileSync(`${process.env.FAKE_CODEBUDDY_REPORT}.child`, String(child.pid));
  result();
  process.exit(0);
} else {
  if (mode === "stderr") process.stderr.write("warning Authorization: Bearer fixture-secret\n");
  if (mode === "split-stderr") {
    process.stderr.write("警告 Authorization: Bear");
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.stderr.write("er fixture-secret continuation\n");
  }
  if (mode === "bad-lines") {
    process.stdout.write('{"type":"system","subtyp');
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.stdout.write('e":"init","session_id":"fixture-session"}\n');
    write({ type: "future_type", nested: { keep: 42 }, Authorization: "Bearer fixture-secret" });
    process.stdout.write("not-json Bearer fixture-secret\n");
  } else {
    write({ type: "system", subtype: "init", session_id: read("--session-id") });
  }
  if (mode !== "missing-result") {
    write({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] }, extra: { retained: true } });
    if (mode === "tool") write({ type: "tool_result", tool_use_id: "tool-1", content: "done" });
    if (mode === "result-error") write({ type: "result", subtype: "error_during_execution", is_error: true, result: "not successful" });
    else result();
  }
  process.exitCode = mode === "nonzero" ? 7 : 0;
}
