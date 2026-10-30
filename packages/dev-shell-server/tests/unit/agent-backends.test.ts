import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBackend, Settings } from "@hustradio/dev-shell-contract";
import { AgentSupervisor, NdjsonParser, runAgentSmoke, runCodeBuddySmoke } from "../../src/agent/index.js";
import type { AgentOutputEvent, AgentSessionState, StartAgentOptions } from "../../src/agent/types.js";
import { prepareAgentLaunch } from "../../src/agent/backends.js";

interface Report {
  argv: string[]; prompt: string; cwd: string; pid: number; nativeSessionId: string;
  env: { agentToken: string; configContent?: string; projectConfigDisabled?: string; home?: string; codexHome?: string };
}
let directory: string;
let executable: string;
let reportPath: string;
const supervisors: AgentSupervisor[] = [];
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "dev-shell-backends-"));
  const bin = path.join(directory, "bin"); mkdirSync(bin); mkdirSync(path.join(directory, "workspace"));
  const script = path.join(bin, "fake-backend.js");
  copyFileSync(fileURLToPath(new URL("../fixtures/fake-backend.js", import.meta.url)), script);
  copyFileSync(fileURLToPath(new URL("../fixtures/fake-backend.cmd", import.meta.url)), path.join(bin, "fake-backend.cmd"));
  chmodSync(script, 0o700);
  executable = process.platform === "win32" ? path.join(bin, "fake-backend.cmd") : script;
  reportPath = path.join(directory, "report.json");
  vi.stubEnv("FAKE_BACKEND_REPORT", reportPath);
  vi.stubEnv("FAKE_BACKEND_SPAWNS", path.join(directory, "spawns.ndjson"));
  vi.stubEnv("FAKE_BACKEND_MODE", "success");
});
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map(supervisor => supervisor.close()));
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function settings(backend: AgentBackend, permissionMode: Settings["permissionMode"] = "default"): Settings {
  return { backend, codebuddyExecutable: executable, codexExecutable: executable, opencodeExecutable: executable,
    defaultTarget: "http://127.0.0.1:3000", allowedOrigins: [], workspace: path.join(directory, "workspace"), model: null,
    permissionMode, timeoutMs: 15_000, maxConcurrent: 2, theme: "system", longPressMs: 500 };
}
function options(backend: AgentBackend, overrides: Partial<StartAgentOptions> = {}): StartAgentOptions {
  return { sessionId: randomUUID(), cliSessionId: randomUUID(), backend, creatorId: randomUUID(), agentVisitorId: randomUUID(),
    agentToken: `secret-${randomUUID()}`, prompt: "line one\n中文 line two $`&", workspace: path.join(directory, "workspace"), settings: settings(backend), ...overrides };
}
function harness() {
  const outputs = new Map<string, AgentOutputEvent[]>(); const states = new Map<string, AgentSessionState[]>();
  const supervisor = new AgentSupervisor({ dataDir: path.join(directory, "data"), mcpUrl: "http://127.0.0.1:4321/mcp",
    onOutput: (id, event) => outputs.set(id, [...(outputs.get(id) ?? []), event]),
    onState: (id, state) => states.set(id, [...(states.get(id) ?? []), state]),
  });
  supervisors.push(supervisor);
  return {supervisor, outputs, states};
}
const readReport = (): Report => JSON.parse(readFileSync(reportPath, "utf8"));

describe("provider-specific agent backends", () => {
  it("runs a fresh ephemeral Codex exec with stdin, isolated MCP config and a token only in the child environment", async () => {
    const originalHome = process.env.HOME; const originalCodexHome = process.env.CODEX_HOME;
    const h = harness(); const input = options("codex");
    await h.supervisor.start(input); await h.supervisor.wait(input.sessionId);
    const report = readReport();
    expect(report.argv.slice(0, 5)).toEqual(["exec", "--ignore-user-config", "--json", "--ephemeral", "--skip-git-repo-check"]);
    expect(report.argv).toContain("read-only"); expect(report.argv.at(-1)).toBe("-");
    expect(report.argv).not.toContain("resume"); expect(report.argv).not.toContain("--session-id");
    expect(report.argv).not.toContain("--mcp-config"); expect(report.argv).not.toContain("--print");
    expect(report.argv.join(" ")).toContain('bearer_token_env_var="DEV_SHELL_AGENT_TOKEN"');
    expect(report.argv.join(" ")).toContain('approval_policy="never"');
    expect(report.argv.join(" ")).not.toContain(input.agentToken);
    expect(report.env.agentToken).toBe(input.agentToken);
    expect(report.env.home).toBe(originalHome); expect(report.env.codexHome).toBe(originalCodexHome);
    expect(process.env.DEV_SHELL_AGENT_TOKEN).not.toBe(input.agentToken);
    expect(report.prompt).toBe(input.prompt); expect(report.cwd).toBe(input.workspace);
    expect(h.states.get(input.sessionId)?.at(-1)).toBe("succeeded");
    expect(h.outputs.get(input.sessionId)?.some(event => event.normalized?.nativeSessionId === report.nativeSessionId)).toBe(true);
    expect(h.outputs.get(input.sessionId)?.map(event => event.kind)).toEqual(expect.arrayContaining(["system", "assistant", "tool", "result"]));
    expect(JSON.stringify(h.outputs.get(input.sessionId))).not.toContain(input.agentToken);
    expect(existsSync(path.join(directory, "data", "mcp"))).toBe(false);
  });

  it("uses OpenCode v2 standalone, a fresh ses_ ID, real v2 MCP/permissions and stdin without a positional dash", async () => {
    const h = harness(); const input = options("opencode-v2");
    await h.supervisor.start(input); await h.supervisor.wait(input.sessionId);
    const report = readReport();
    expect(report.argv).toEqual(["run", "--standalone", "--format", "json", "--session", `ses_${input.cliSessionId!.replace(/-/g, "")}`, "--agent", "build"]);
    expect(report.argv).not.toContain("-"); expect(report.argv).not.toContain("--continue"); expect(report.argv).not.toContain("--auto");
    expect(report.argv).not.toContain("--print"); expect(report.argv).not.toContain("stream-json");
    expect(report.prompt).toBe(input.prompt);
    const config = JSON.parse(report.env.configContent!);
    expect(config.mcp.servers["dev-shell"]).toEqual({ type: "remote", url: "http://127.0.0.1:4321/mcp", oauth: false,
      protocol: "legacy", codemode: false, headers: { Authorization: "Bearer {env:DEV_SHELL_AGENT_TOKEN}" } });
    expect(config.mcp).not.toHaveProperty("dev-shell");
    expect(config.permissions).toContainEqual({ action: "edit", resource: "*", effect: "deny" });
    expect(config.permissions).toContainEqual({ action: "external_directory", resource: "*", effect: "deny" });
    expect(config.policies).toContainEqual({ action: "integration.use", resource: "mcp:*", effect: "deny" });
    expect(config.policies).toContainEqual({ action: "integration.use", resource: "mcp:dev-shell", effect: "allow" });
    expect(report.env.projectConfigDisabled).toBe("1");
    expect(report.env.configContent).not.toContain(input.agentToken);
    expect(report.env.agentToken).toBe(input.agentToken);
    expect(h.states.get(input.sessionId)?.at(-1)).toBe("succeeded");
    expect(h.outputs.get(input.sessionId)?.filter(event => event.kind === "result")).toHaveLength(1);
    expect(h.outputs.get(input.sessionId)?.some(event => event.normalized?.nativeSessionId === report.nativeSessionId)).toBe(true);
    expect(JSON.stringify(h.outputs.get(input.sessionId))).not.toContain(input.agentToken);
  });

  it.each(["codex", "opencode-v2"] as const)("maps %s plan and acceptEdits permissions without a bypass mode", async backend => {
    const plan = options(backend, {settings: settings(backend, "plan")});
    const planLaunch = await prepareAgentLaunch(plan, directory, "http://127.0.0.1:4321/mcp");
    const editing = await prepareAgentLaunch({...plan, settings: settings(backend, "acceptEdits")}, directory, "http://127.0.0.1:4321/mcp");
    if (backend === "codex") { expect(planLaunch.args).toContain("read-only"); expect(editing.args).toContain("workspace-write"); }
    else {
      expect(planLaunch.args.at(-1)).toBe("plan"); expect(editing.args.at(-1)).toBe("build");
      expect(JSON.parse(editing.env.OPENCODE_CONFIG_CONTENT!).permissions).toContainEqual({ action: "edit", resource: "*", effect: "allow" });
    }
    expect([...planLaunch.args, ...editing.args].join(" ")).not.toMatch(/danger|bypass|--auto/);
  });

  it.each(["codex", "opencode-v2"] as const)("treats %s error results as failure even on exit zero", async backend => {
    vi.stubEnv("FAKE_BACKEND_MODE", "failure");
    const h = harness(); const input = options(backend);
    await h.supervisor.start(input); await h.supervisor.wait(input.sessionId);
    expect(h.states.get(input.sessionId)?.at(-1)).toBe("failed");
    expect(h.outputs.get(input.sessionId)?.some(event => event.normalized?.isError === true)).toBe(true);
  });

  it.each(["codex", "opencode-v2"] as const)("cancels the %s process before resolving", async backend => {
    vi.stubEnv("FAKE_BACKEND_MODE", "hang");
    const h = harness(); const input = options(backend);
    await h.supervisor.start(input);
    await expect.poll(() => existsSync(reportPath), {timeout: 10_000}).toBe(true);
    const pid = readReport().pid;
    await h.supervisor.cancel(input.sessionId);
    expect(h.states.get(input.sessionId)?.at(-1)).toBe("cancelled");
    await expect.poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } }).toBe(true);
  });

  it("does not treat an intermediate OpenCode tool-calls step as successful completion", async () => {
    vi.stubEnv("FAKE_BACKEND_MODE", "partial");
    const h = harness(); const input = options("opencode-v2");
    await h.supervisor.start(input); await h.supervisor.wait(input.sessionId);
    expect(h.states.get(input.sessionId)?.at(-1)).toBe("completed_with_warning");
    expect(h.outputs.get(input.sessionId)?.some(event => event.raw === "OPENCODE_RESULT_MISSING")).toBe(true);
  });
  it.each(["completed-text", "incomplete-text"])("uses the real v2 run exit contract for %s without inventing a missing step_finish", async mode => {
    vi.stubEnv("FAKE_BACKEND_MODE", mode);
    const h = harness(); const input = options("opencode-v2");
    await h.supervisor.start(input); await h.supervisor.wait(input.sessionId);
    expect(h.states.get(input.sessionId)?.at(-1)).toBe(mode === "completed-text" ? "succeeded" : "completed_with_warning");
    expect(h.outputs.get(input.sessionId)?.some(event => event.kind === "result")).toBe(mode === "completed-text");
  });

  it("freezes the session backend independently from later settings and never reuses a native session", async () => {
    const h = harness(); const first = options("codex", {settings: settings("opencode-v2")});
    await h.supervisor.start(first); await h.supervisor.wait(first.sessionId);
    const firstNative = readReport().nativeSessionId;
    const second = options("codex"); await h.supervisor.start(second); await h.supervisor.wait(second.sessionId);
    expect(readReport().argv[0]).toBe("exec"); expect(readReport().nativeSessionId).not.toBe(firstNative);
    await expect(h.supervisor.start(first)).rejects.toThrow("SESSION_ALREADY_EXISTS");
    expect(readFileSync(path.join(directory, "spawns.ndjson"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("preserves unknown protocol envelopes while sanitizing raw and normalized native identifiers", () => {
    const outputs: AgentOutputEvent[] = [];
    const parser = new NdjsonParser(event => outputs.push(event), undefined, undefined, ["native-secret"], "codex");
    parser.write(Buffer.from('{"type":"thread.started","thread_id":"native-secret"}\n{"type":"future_event","nested":{"keep":42,"token":"native-secret"}}\n'));
    parser.end();
    expect(outputs[1].raw).toEqual({type: "future_event", nested: {keep: 42, token: "[REDACTED]"}});
    expect(JSON.stringify(outputs)).not.toContain("native-secret");
  });

  it("does not create a secret config file or spawn on an invalid MCP environment token", async () => {
    const input = options("codex", {agentToken: "bad\nheader"});
    await expect(prepareAgentLaunch(input, directory, "http://127.0.0.1:4321/mcp")).rejects.toThrow("MCP_CONFIG_INVALID");
    expect(existsSync(reportPath)).toBe(false);
    expect(readdirSync(directory)).not.toContain("mcp");
  });

  it("rejects OpenCode v1 before sending any prompt or agent credential to it", async () => {
    vi.stubEnv("FAKE_BACKEND_VERSION", "1.3.2");
    const h = harness(); const input = options("opencode-v2");
    await h.supervisor.start(input); await h.supervisor.wait(input.sessionId);
    expect(h.states.get(input.sessionId)?.at(-1)).toBe("failed");
    expect(h.outputs.get(input.sessionId)?.some(event => event.raw === "OPENCODE_V2_REQUIRED")).toBe(true);
    expect(existsSync(reportPath)).toBe(false);
    expect(existsSync(path.join(directory, "spawns.ndjson"))).toBe(false);
  });

  it.each(["codex", "opencode-v2"] as const)("runs the generic %s smoke and treats server-side tool observation as authoritative", async backend => {
    vi.stubEnv("FAKE_BACKEND_MODE", "smoke");
    const result = await runAgentSmoke({ backend, executable, dataDir: path.join(directory, "smoke"), mcpUrl: "http://127.0.0.1:4321/mcp",
      agentToken: "temporary-smoke-token", agentVisitorId: randomUUID(), timeoutMs: 15_000, wasVisitorMeCalled: () => true });
    expect(result).toMatchObject({ ok: true, help: true, mcp: {state: "succeeded", toolObserved: true}, plain: {state: "succeeded", replyObserved: true} });
    const plain = readReport();
    expect(plain.prompt).toContain("DEV_SHELL_PLAIN_OK");
    if (backend === "codex") {
      expect(plain.argv).toContain("read-only");
      expect(plain.argv).toContain("features.shell_tool=false");
      expect(plain.argv).toContain("mcp_servers={}");
    } else {
      expect(plain.argv.at(-1)).toBe("plan");
      const config = JSON.parse(plain.env.configContent!);
      expect(config.agents.plan.permissions).toEqual([{action: "*", resource: "*", effect: "deny"}]);
      expect(config.mcp.servers["dev-shell"].disabled).toBe(true);
    }
  });

  it("does not claim MCP success from a provider's stdout alone", async () => {
    vi.stubEnv("FAKE_BACKEND_MODE", "smoke");
    const result = await runAgentSmoke({ backend: "codex", executable, dataDir: path.join(directory, "smoke"), mcpUrl: "http://127.0.0.1:4321/mcp",
      agentToken: "temporary-smoke-token", agentVisitorId: randomUUID(), timeoutMs: 15_000, wasVisitorMeCalled: () => false });
    expect(result.mcp.state).toBe("succeeded"); expect(result.mcp.toolObserved).toBe(false); expect(result.ok).toBe(false);
    expect(runCodeBuddySmoke).toBe(runAgentSmoke);
  });
});
