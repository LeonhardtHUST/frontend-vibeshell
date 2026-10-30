import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Settings } from "@hustradio/dev-shell-contract";
import { CodeBuddySupervisor } from "../../src/agent/index.js";
import type { AgentOutputEvent, AgentSessionState, StartAgentOptions } from "../../src/agent/index.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-codebuddy.js", import.meta.url));
const executable = process.platform === "win32" ? `${fixture.slice(0, -3)}.cmd` : fixture;
const terminals = new Set<AgentSessionState>(["succeeded", "failed", "cancelled", "interrupted", "completed_with_warning"]);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe("CodeBuddySupervisor", () => {
  it("uses fixed argv, explicit cwd, stdin prompt, an isolated config and a fresh UUID", async () => {
    const h = await harness();
    const sessionId = randomUUID();
    const done = h.waitTerminal(sessionId);
    await h.supervisor.start(h.options(sessionId, { prompt: "line one\nline two", settings: settings({ model: "fixture-model" }) }));
    await done;
    await h.supervisor.close();

    const report = JSON.parse(await readFile(h.report, "utf8"));
    expect(report.argv).toEqual([
      "--session-id", sessionId,
      "--print",
      "--input-format", "text",
      "--output-format", "stream-json",
      "--mcp-config", expect.any(String),
      "--strict-mcp-config",
      "--permission-mode", "acceptEdits",
      "--model", "fixture-model",
    ]);
    expect(report.cwd).toBe(h.workspace);
    expect(report.prompt).toBe("line one\nline two");
    expect(report.argv[1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(report.argv).not.toContain("--cwd");
    expect(report.argv).not.toContain("--continue");
    expect(report.argv.join(" ")).not.toContain("bypass");
    expect(report.config).toEqual({
      mcpServers: {
        "dev-shell": {
          type: "http",
          url: "http://127.0.0.1:4321/mcp",
          headers: { Authorization: `Bearer ${h.token}` },
        },
      },
    });
    const configPath = report.argv[report.argv.indexOf("--mcp-config") + 1];
    expect(path.dirname(configPath)).toBe(path.join(h.dataDir, "mcp"));
    await expect(stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(h.states.get(sessionId)).toEqual(["queued", "spawning", "running", "succeeded"]);
  });

  it("treats nonempty stderr as redacted output rather than failure", async () => {
    const h = await harness("stderr");
    const id = randomUUID();
    const done = h.waitTerminal(id);
    await h.supervisor.start(h.options(id));
    await done;
    const events = h.outputs.get(id)!;
    const stderr = events.find((event) => event.stream === "stderr");
    expect(stderr?.raw).toContain("Bearer [REDACTED]");
    expect(stderr?.raw).not.toContain("fixture-secret");
    expect(h.lastState(id)).toBe("succeeded");
  });

  it("uses the CLI UUID independently from the workbench session ID", async () => {
    const h = await harness();
    const id = randomUUID();
    const cliSessionId = randomUUID();
    await h.supervisor.start(h.options(id, { cliSessionId }));
    await h.supervisor.wait(id);
    const report = JSON.parse(await readFile(h.report, "utf8"));
    expect(report.argv[1]).toBe(cliSessionId);
    expect(h.lastState(id)).toBe("succeeded");
    await expect(h.supervisor.start(h.options(id))).rejects.toThrow("SESSION_ALREADY_EXISTS");
  });

  it("keeps split stderr credentials redacted and preserves UTF-8", async () => {
    const h = await harness("split-stderr");
    const id = randomUUID();
    await h.supervisor.start(h.options(id));
    await h.supervisor.wait(id);
    const output = JSON.stringify(h.outputs.get(id));
    expect(output).toContain("警告");
    expect(output).toContain("Bearer [REDACTED]");
    expect(output).not.toContain("fixture-secret");
  });

  it("treats an error result as failure even when the CLI exits zero", async () => {
    const h = await harness("result-error");
    const id = randomUUID();
    await h.supervisor.start(h.options(id));
    await h.supervisor.wait(id);
    expect(h.lastState(id)).toBe("failed");
    expect(h.outputs.get(id)?.some(event => event.raw === "CODEBUDDY_RESULT_ERROR")).toBe(true);
  });

  it("preserves sanitized unknown envelopes, known normalization and malformed stdout", async () => {
    const h = await harness("bad-lines");
    const id = randomUUID();
    const done = h.waitTerminal(id);
    await h.supervisor.start(h.options(id));
    await done;
    const events = h.outputs.get(id)!;
    const system = events.find((event) => event.kind === "system" && event.stream === "stdout");
    expect(system?.normalized).toMatchObject({ type: "system", subtype: "init", sessionId: "fixture-session" });
    const unknown = events.find((event) => (event.raw as { type?: string })?.type === "future_type");
    expect(unknown?.raw).toEqual({ type: "future_type", nested: { keep: 42 }, Authorization: "[REDACTED]" });
    const malformed = events.find((event) => event.kind === "stdout" && typeof event.raw === "string");
    expect(malformed?.raw).toBe("not-json Bearer [REDACTED]");
    expect(events.some((event) => event.kind === "assistant")).toBe(true);
    expect(h.lastState(id)).toBe("succeeded");
  });

  it("marks exit zero without a result as completed_with_warning", async () => {
    const h = await harness("missing-result");
    const id = randomUUID();
    const done = h.waitTerminal(id);
    await h.supervisor.start(h.options(id));
    await done;
    expect(h.lastState(id)).toBe("completed_with_warning");
    expect(h.outputs.get(id)!.some((event) => event.raw === "CODEBUDDY_RESULT_MISSING")).toBe(true);
  });

  it("retains output on a nonzero exit and fails", async () => {
    const h = await harness("nonzero");
    const id = randomUUID();
    const done = h.waitTerminal(id);
    await h.supervisor.start(h.options(id));
    await done;
    expect(h.lastState(id)).toBe("failed");
    expect(h.outputs.get(id)!.some((event) => event.kind === "assistant")).toBe(true);
    expect(h.outputs.get(id)!.some((event) => event.raw === "CODEBUDDY_EXIT_7")).toBe(true);
  });

  it("times out a hung process", async () => {
    const h = await harness("hang");
    const id = randomUUID();
    const done = h.waitTerminal(id);
    await h.supervisor.start(h.options(id, { settings: settings({ timeoutMs: 100 }) }));
    await done;
    expect(h.lastState(id)).toBe("failed");
    expect(h.outputs.get(id)!.some((event) => event.raw === "CODEBUDDY_TIMEOUT")).toBe(true);
  });

  it("cancels a running process", async () => {
    const h = await harness("hang");
    const id = randomUUID();
    const running = h.waitState(id, "running");
    const done = h.waitTerminal(id);
    await h.supervisor.start(h.options(id));
    await running;
    h.supervisor.cancel(id);
    await done;
    expect(h.lastState(id)).toBe("cancelled");
  });

  it("enforces global concurrency two and one process per creator", async () => {
    const h = await harness("hang");
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const running = Promise.all(ids.slice(0, 2).map((id) => h.waitState(id, "running")));
    await h.supervisor.start(h.options(ids[0]));
    await h.supervisor.start(h.options(ids[1], { creatorId: "00000000-0000-4000-8000-000000000002" }));
    await h.supervisor.start(h.options(ids[2], { creatorId: "00000000-0000-4000-8000-000000000003" }));
    await h.supervisor.start(h.options(ids[3]));
    await running;
    expect(h.lastState(ids[2])).toBe("queued");
    expect(h.lastState(ids[3])).toBe("queued");
    h.supervisor.cancel(ids[0]);
    await h.waitState(ids[2], "running");
    expect(h.lastState(ids[3])).toBe("queued");
    for (const id of ids) h.supervisor.cancel(id);
    await Promise.all(ids.map((id) => h.waitTerminal(id)));
  });

  it("honors a configured global concurrency of one", async () => {
    const h = await harness("hang");
    const first = randomUUID();
    const second = randomUUID();
    await h.supervisor.start(h.options(first, { settings: settings({ maxConcurrent: 1 }) }));
    await h.supervisor.start(h.options(second, { creatorId: randomUUID(), settings: settings({ maxConcurrent: 1 }) }));
    await h.waitState(first, "running");
    expect(h.lastState(second)).toBe("queued");
    await h.supervisor.cancel(first);
    await h.waitState(second, "running");
    await h.supervisor.cancel(second);
  });

  it("interrupts active work and cancels queued work on close", async () => {
    const h = await harness("hang");
    const first = randomUUID();
    const second = randomUUID();
    const running = h.waitState(first, "running");
    const firstDone = h.waitTerminal(first);
    const secondDone = h.waitTerminal(second);
    await h.supervisor.start(h.options(first));
    await h.supervisor.start(h.options(second));
    await running;
    await h.supervisor.close();
    await Promise.all([firstDone, secondDone]);
    expect(h.lastState(first)).toBe("interrupted");
    expect(h.lastState(second)).toBe("cancelled");
  });

  it("returns an actionable failure for a missing executable", async () => {
    const h = await harness();
    const id = randomUUID();
    const done = h.waitTerminal(id);
    await h.supervisor.start(h.options(id, { settings: settings({ codebuddyExecutable: path.join(h.workspace, "missing-codebuddy") }) }));
    await done;
    expect(h.lastState(id)).toBe("failed");
    expect(h.outputs.get(id)!.some((event) => event.raw === "CODEBUDDY_NOT_FOUND")).toBe(true);
  });

  it("terminates the descendant process on cancellation", async () => {
    const h = await harness("tree");
    const id = randomUUID();
    const running = h.waitState(id, "running");
    const done = h.waitTerminal(id);
    await h.supervisor.start(h.options(id));
    await running;
    await expect.poll(async () => { try { return (await readFile(`${h.report}.child`, "utf8")).length > 0; } catch { return false; } }, {timeout: 8_000}).toBe(true);
    await h.supervisor.cancel(id);
    await done;
    const childPid = Number(await readFile(`${h.report}.child`, "utf8"));
    await expect.poll(() => {
      try { process.kill(childPid, 0); return false; } catch { return true; }
    }).toBe(true);
  });

  it("reaps inherited-pipe descendants after the CLI parent exits, without hanging wait or close", async () => {
    const h = await harness("orphan-pipes");
    const id = randomUUID();
    let childPid: number | undefined;
    try {
      await h.supervisor.start(h.options(id, { settings: settings({ timeoutMs: 5_000 }) }));
      await expect.poll(async () => {
        try { childPid = Number(await readFile(`${h.report}.child`, "utf8")); return childPid > 0; } catch { return false; }
      }, {timeout: 8_000}).toBe(true);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([h.supervisor.wait(id), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("inherited pipes did not close")), 8_000); })]);
      } finally { clearTimeout(timer); }
      await expect.poll(() => { try { process.kill(childPid!, 0); return false; } catch { return true; } }).toBe(true);
      expect(h.lastState(id)).toBe(process.platform === "win32" ? "succeeded" : "failed");
      await h.supervisor.close();
    } finally {
      if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch { /* already reaped */ } }
    }
  });
});

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    defaultTarget: "http://127.0.0.1:3000",
    allowedOrigins: ["http://127.0.0.1:3000"],
    workspace: ".",
    codebuddyExecutable: executable,
    model: null,
    permissionMode: "acceptEdits",
    timeoutMs: 10_000,
    maxConcurrent: 2,
    theme: "system",
    longPressMs: 500,
    ...overrides,
  };
}

async function harness(mode = "success") {
  const root = await mkdtemp(path.join(tmpdir(), "codebuddy-supervisor-"));
  const dataDir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  const report = path.join(root, "report.json");
  const token = `token-${randomUUID()}`;
  const { mkdir } = await import("node:fs/promises");
  await mkdir(workspace);
  await chmod(fixture, 0o700);
  const old = { mode: process.env.FAKE_CODEBUDDY_MODE, report: process.env.FAKE_CODEBUDDY_REPORT };
  process.env.FAKE_CODEBUDDY_MODE = mode;
  process.env.FAKE_CODEBUDDY_REPORT = report;
  const outputs = new Map<string, AgentOutputEvent[]>();
  const states = new Map<string, AgentSessionState[]>();
  const waiters: Array<{ id: string; accept: (state: AgentSessionState) => boolean; resolve: () => void }> = [];
  const supervisor = new CodeBuddySupervisor({
    dataDir,
    mcpUrl: "http://127.0.0.1:4321/mcp",
    onOutput: (id, event) => {
      const events = outputs.get(id) ?? [];
      events.push(event);
      outputs.set(id, events);
    },
    onState: (id, state) => {
      const history = states.get(id) ?? [];
      history.push(state);
      states.set(id, history);
      for (const waiter of waiters.slice()) {
        if (waiter.id === id && waiter.accept(state)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    },
  });
  const restore = async () => {
    await supervisor.close();
    if (old.mode === undefined) delete process.env.FAKE_CODEBUDDY_MODE; else process.env.FAKE_CODEBUDDY_MODE = old.mode;
    if (old.report === undefined) delete process.env.FAKE_CODEBUDDY_REPORT; else process.env.FAKE_CODEBUDDY_REPORT = old.report;
    await rm(root, { recursive: true, force: true });
  };
  cleanups.push(restore);
  const options = (sessionId: string, overrides: Partial<StartAgentOptions> = {}): StartAgentOptions => ({
    sessionId,
    creatorId: "00000000-0000-4000-8000-000000000001",
    agentVisitorId: randomUUID(),
    agentToken: token,
    prompt: "test prompt",
    workspace,
    settings: settings(),
    ...overrides,
  });
  return {
    supervisor, dataDir, workspace, report, token, outputs, states, options,
    lastState: (id: string) => states.get(id)?.at(-1),
    waitState: (id: string, wanted: AgentSessionState) => {
      if (states.get(id)?.includes(wanted)) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push({ id, accept: (state) => state === wanted, resolve }));
    },
    waitTerminal: (id: string) => {
      const last = states.get(id)?.at(-1);
      if (last && terminals.has(last)) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push({ id, accept: (state) => terminals.has(state), resolve }));
    },
  };
}
