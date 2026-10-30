import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentSession, EventEnvelope, FrameInfo, QueueItem, Visitor, WorkbenchSnapshot } from "@hustradio/dev-shell-contract";
import { loadConfig } from "../../src/config.js";
import { createDevShellServer, type DevShellServer } from "../../src/server.js";
import { startTargetFixture, type TargetFixture } from "../fixtures/target-fixture.js";

interface Credentials { visitor: Visitor; token: string; snapshot: WorkbenchSnapshot }
interface SpawnRecord { cliSessionId: string; prompt: string; pid: number }
interface FakeReport {
  argv: string[]; cwd: string; prompt: string; pid: number;
  config: { mcpServers: { "dev-shell": { type: string; url: string; headers: { Authorization: string } } } };
}

let directory: string;
let executable: string;
let reportPath: string;
let spawnPath: string;
const servers: DevShellServer[] = [];
const clients: Client[] = [];
const targets: TargetFixture[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dev-shell-lifecycle-"));
  const bin = join(directory, "bin"); mkdirSync(bin); mkdirSync(join(directory, "workspace"));
  const fixture = fileURLToPath(new URL("../fixtures/fake-codebuddy.js", import.meta.url));
  const copiedFixture = join(bin, "fake-codebuddy.js");
  copyFileSync(fixture, copiedFixture);
  copyFileSync(fileURLToPath(new URL("../fixtures/fake-codebuddy.cmd", import.meta.url)), join(bin, "fake-codebuddy.cmd"));
  chmodSync(copiedFixture, 0o700);
  executable = process.platform === "win32" ? join(bin, "fake-codebuddy.cmd") : copiedFixture;
  reportPath = join(directory, "report.json"); spawnPath = join(directory, "spawns.ndjson");
  vi.stubEnv("FAKE_CODEBUDDY_MODE", "browser");
  vi.stubEnv("FAKE_CODEBUDDY_REPORT", reportPath);
  vi.stubEnv("FAKE_CODEBUDDY_BROWSER_REPORT", spawnPath);
  for (const name of ["DEV_SHELL_HOST", "DEV_SHELL_PORT", "DEV_SHELL_TARGET", "DEV_SHELL_DATABASE", "DEV_SHELL_DATA_DIR"]) vi.stubEnv(name, undefined);
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(client => client.close()));
  await Promise.allSettled(servers.splice(0).map(server => server.close()));
  await Promise.allSettled(targets.splice(0).map(target => target.close()));
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

async function start() {
  const server = createDevShellServer({ config: {
    port: 0, dataDir: join(directory, "data"), databasePath: join(directory, "data", "workbench.sqlite"), workspace: join(directory, "workspace"),
  } });
  servers.push(server);
  await server.listen();
  return server;
}

const base = (server: DevShellServer) => `http://127.0.0.1:${server.config.port}`;
async function api<T>(server: DevShellServer, token: string, path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const response = await fetch(`${base(server)}/api${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "x-dev-shell-web": "1", "content-type": "application/json" },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  const value: unknown = response.status === 204 ? undefined : await response.json();
  expect(response.ok, JSON.stringify(value)).toBe(true);
  return value as T;
}
async function owner(server: DevShellServer) {
  const credentials = await api<Credentials>(server, "", "/bootstrap", { displayName: "Lifecycle owner" });
  await api(server, credentials.token, "/settings", { codebuddyExecutable: executable, timeoutMs: 15_000 }, "PATCH");
  return credentials;
}
function spawns(): SpawnRecord[] {
  return existsSync(spawnPath) ? readFileSync(spawnPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as SpawnRecord) : [];
}
const report = (): FakeReport => JSON.parse(readFileSync(reportPath, "utf8"));
const configPath = (value: FakeReport) => value.argv[value.argv.indexOf("--mcp-config") + 1];
const agentToken = (value: FakeReport) => value.config.mcpServers["dev-shell"].headers.Authorization.slice("Bearer ".length);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const mcpFiles = () => existsSync(join(directory, "data", "mcp")) ? readdirSync(join(directory, "data", "mcp")) : [];

describe("production server lifecycle with the fake CodeBuddy executable", () => {
  it("launches one process per idempotent request, keeps independent CLI UUIDs and exposes persisted output envelopes", async () => {
    const server = await start(); const credentials = await owner(server);
    const input = { prompt: "One new session", clientMessageId: "single" };
    const [first, repeated] = await Promise.all([
      api<AgentSession>(server, credentials.token, "/sessions", input),
      api<AgentSession>(server, credentials.token, "/sessions", input),
    ]);
    expect(repeated).toEqual(first);
    await server.supervisor.wait(first.id);
    expect(server.service.getSession(first.id).status).toBe("succeeded");
    expect(spawns()).toHaveLength(1);
    expect(spawns()[0]).toMatchObject({ cliSessionId: first.cliSessionId, prompt: input.prompt });
    expect(first.cliSessionId).not.toBe(first.id);
    const firstReport = report();
    expect(firstReport.cwd).toBe(join(directory, "workspace"));
    expect(firstReport.config.mcpServers["dev-shell"].url).toBe(`${base(server)}/mcp`);
    expect(existsSync(configPath(firstReport))).toBe(false);
    expect(() => server.service.authenticate(agentToken(firstReport))).toThrow(/Invalid or revoked/);
    const events = await api<{items: EventEnvelope[]}>(server, credentials.token, `/sessions/${first.id}/events`);
    expect(events.items.some(event => (event.data as {kind?: string}).kind === "assistant")).toBe(true);
    expect(events.items.some(event => (event.data as {raw?: {session_id?: string}}).raw?.session_id === first.cliSessionId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(agentToken(firstReport));
    await api(server, credentials.token, "/sessions", input);
    const second = await api<AgentSession>(server, credentials.token, "/sessions", { prompt: "Another new session", clientMessageId: "second" });
    await server.supervisor.wait(second.id);
    expect(second.cliSessionId).not.toBe(first.cliSessionId);
    expect(spawns()).toHaveLength(2);

    const a = await api<QueueItem>(server, credentials.token, "/queue", { clientMessageId: "a", body: "First queued task" });
    const b = await api<QueueItem>(server, credentials.token, "/queue", { clientMessageId: "b", body: "Second queued task" });
    const batchInput = { clientMessageId: "batch", queueItemIds: [a.id, b.id] };
    const batch = await api<AgentSession>(server, credentials.token, "/queue/dispatch", batchInput);
    expect(await api(server, credentials.token, "/queue/dispatch", batchInput)).toEqual(batch);
    await server.supervisor.wait(batch.id);
    expect(server.service.getSession(batch.id).status).toBe("succeeded");
    expect(spawns()).toHaveLength(3);
    expect(spawns()[2].prompt).toContain(a.body); expect(spawns()[2].prompt).toContain(b.body);
    expect(server.service.getQueue(a.id).status).toBe("sent"); expect(server.service.getQueue(b.id).status).toBe("sent");
    expect(mcpFiles()).toEqual([]);
    expect(JSON.stringify(server.store.all("SELECT responseJson FROM idempotency_keys"))).not.toContain(agentToken(firstReport));
  });

  it("cancels the actual process tree before returning and cleans its config and credentials", async () => {
    vi.stubEnv("FAKE_CODEBUDDY_MODE", "tree");
    const server = await start(); const credentials = await owner(server);
    const queued = await api<QueueItem>(server, credentials.token, "/queue", { clientMessageId: "tree", body: "Keep this child running" });
    const session = await api<AgentSession>(server, credentials.token, "/queue/dispatch", { clientMessageId: "tree-batch", queueItemIds: [queued.id] });
    await expect.poll(() => existsSync(`${reportPath}.child`), {timeout: 10_000}).toBe(true);
    const runningReport = report(); const childPid = Number(readFileSync(`${reportPath}.child`, "utf8"));
    expect(server.service.getSession(session.id).status).toBe("running");
    expect(existsSync(configPath(runningReport))).toBe(true);
    expect(server.service.authenticate(agentToken(runningReport)).visitor.id).toBe(session.agentVisitorId);
    const cancelled = await api<AgentSession>(server, credentials.token, `/sessions/${session.id}/cancel`, {}, "POST");
    expect(cancelled.status).toBe("cancelled");
    await expect.poll(() => alive(runningReport.pid) || alive(childPid)).toBe(false);
    expect(existsSync(configPath(runningReport))).toBe(false);
    expect(() => server.service.authenticate(agentToken(runningReport))).toThrow(/Invalid or revoked/);
    expect(server.service.getQueue(queued.id).status).toBe("cancelled");
    expect(spawns()).toHaveLength(1);
  });

  it("closes frame/MCP/CLI resources and does not automatically rerun persisted sessions after restart", async () => {
    const server = await start(); const credentials = await owner(server);
    const frame = await api<FrameInfo>(server, credentials.token, "/frames", { targetUrl: `${base(server)}/fixture` });
    const client = new Client({ name: "lifecycle", version: "1.0.0" }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base(server)}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${credentials.token}` } },
      reconnectionOptions: { initialReconnectionDelay: 10, maxReconnectionDelay: 10, reconnectionDelayGrowFactor: 1, maxRetries: 0 },
    }));
    const running = await api<AgentSession>(server, credentials.token, "/sessions", { prompt: "[[hang]] active until shutdown", clientMessageId: "running" });
    await expect.poll(() => existsSync(reportPath), {timeout: 10_000}).toBe(true);
    const runningReport = report();
    const pending = server.service.createSession(credentials.visitor.id, { prompt: "Must not auto-run", clientMessageId: "orphan", queueItemIds: [] }).session;
    expect(server.mcp.sessionCount).toBe(1);
    await server.close();
    expect(server.mcp.sessionCount).toBe(0);
    expect(server.frames.getFrame(frame.frameId)?.status).toBe("closed");
    await expect(fetch(frame.proxyOrigin)).rejects.toThrow();
    expect(alive(runningReport.pid)).toBe(false);
    expect(existsSync(configPath(runningReport))).toBe(false);
    const restarted = await start();
    expect(restarted.service.getSession(running.id).status).toBe("interrupted");
    expect(restarted.service.getSession(pending.id).status).toBe("interrupted");
    expect(() => restarted.service.authenticate(agentToken(runningReport))).toThrow(/Invalid or revoked/);
    expect(mcpFiles()).toEqual([]);
    const next = await api<AgentSession>(restarted, credentials.token, "/sessions", { prompt: "Explicit work after restart", clientMessageId: "explicit" });
    await restarted.supervisor.wait(next.id);
    expect(restarted.service.getSession(next.id).status).toBe("succeeded");
    expect(spawns().map(item => item.prompt)).toEqual(["[[hang]] active until shutdown", "Explicit work after restart"]);
  });

  it("keeps missing-executable failures synchronized with queue and agent credential state", async () => {
    const server = await start(); const credentials = await owner(server);
    await api(server, credentials.token, "/settings", { codebuddyExecutable: join(directory, "missing-codebuddy.exe") }, "PATCH");
    const queued = await api<QueueItem>(server, credentials.token, "/queue", { clientMessageId: "missing", body: "Cannot spawn" });
    const session = await api<AgentSession>(server, credentials.token, "/queue/dispatch", { clientMessageId: "missing-batch", queueItemIds: [queued.id] });
    await server.supervisor.wait(session.id);
    expect(server.service.getSession(session.id)).toMatchObject({status: "failed", error: "CODEBUDDY_NOT_FOUND"});
    expect(server.service.getQueue(queued.id).status).toBe("failed");
    expect(server.service.getVisitor(session.agentVisitorId).revokedAt).not.toBeNull();
    expect(server.store.all("SELECT * FROM visitor_tokens WHERE visitorId=? AND revokedAt IS NULL", session.agentVisitorId)).toEqual([]);
    expect(spawns()).toEqual([]); expect(mcpFiles()).toEqual([]);
    const events = await api<{items: EventEnvelope[]}>(server, credentials.token, `/sessions/${session.id}/events`);
    expect(events.items.some(event => (event.data as {raw?: string}).raw === "CODEBUDDY_NOT_FOUND")).toBe(true);
  });

  it("defaults the backend to 5274 and keeps registered target origins outside the shell API allowlist", async () => {
    const config = loadConfig({ dataDir: join(directory, "config-only") });
    expect(config.port).toBe(5274);
    expect(config.shellAllowedOrigins).toContain("http://127.0.0.1:5273");
    const target = await startTargetFixture(); targets.push(target);
    const server = await start(); const credentials = await owner(server);
    await api(server, credentials.token, "/settings", { allowedOrigins: [target.origin] }, "PATCH");
    const frame = await api<FrameInfo>(server, credentials.token, "/frames", { targetUrl: target.origin });
    expect(frame.targetUrl).toBe(`${target.origin}/`);
    expect(server.config.shellAllowedOrigins).not.toContain(target.origin);
    const denied = await fetch(`${base(server)}/api/settings`, { headers: { authorization: `Bearer ${credentials.token}`, origin: target.origin } });
    expect(denied.status).toBe(403);
    const shellOnlyTarget = await fetch(`${base(server)}/api/frames`, {
      method: "POST", headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" }, body: JSON.stringify({ targetUrl: "http://127.0.0.1:5273/" }),
    });
    expect(shellOnlyTarget.status).toBe(403);
  });

  it.each(["codex", "opencode-v2"] as const)("runs %s through the same production session service and persists its native identity", async backend => {
    const fake = join(directory, "bin", "fake-backend.js");
    copyFileSync(fileURLToPath(new URL("../fixtures/fake-backend.js", import.meta.url)), fake);
    chmodSync(fake, 0o700);
    const backendReport = join(directory, "backend-report.json");
    vi.stubEnv("FAKE_BACKEND_REPORT", backendReport);
    const server = await start(); const credentials = await owner(server);
    await api(server, credentials.token, "/settings", {codexExecutable: fake, opencodeExecutable: fake}, "PATCH");
    const session = await api<AgentSession>(server, credentials.token, "/sessions", {backend, prompt: "Shared workbench with a distinct backend", clientMessageId: backend});
    await server.supervisor.wait(session.id);
    const final = server.service.getSession(session.id);
    const result = JSON.parse(readFileSync(backendReport, "utf8"));
    expect(final).toMatchObject({backend, status: "succeeded", nativeSessionId: result.nativeSessionId});
    expect(result.prompt).toBe("Shared workbench with a distinct backend");
    expect(result.argv).not.toContain(result.env.agentToken);
    expect(() => server.service.authenticate(result.env.agentToken)).toThrow(/Invalid or revoked/);
    expect(JSON.stringify(server.service.sessionEvents(session.id))).not.toContain(result.env.agentToken);
    expect(server.service.getVisitor(session.agentVisitorId).displayName).toContain(backend);
  });

  it("expires idle resource leases and emits waiter-visible events without another API read", async () => {
    vi.useFakeTimers({toFake: ["Date", "setInterval", "clearInterval"]});
    const server = createDevShellServer({config: {port: 0, dataDir: join(directory, "idle")}}); servers.push(server);
    try {
      const credentials = server.service.bootstrapOwner();
      const lease = server.service.acquireLease(credentials.visitor.id, {resource: "idle", purpose: "work", mode: "exclusive", ttlMs: 30_000, wait: false}).lease!;
      await vi.advanceTimersByTimeAsync(30_001);
      expect(server.store.get("SELECT id FROM resource_leases WHERE id=?", lease.id)).toBeUndefined();
      expect(server.store.latestEvent()!.payload).toMatchObject({action: "expired", retryWaiters: true});
    } finally { await server.close(); vi.useRealTimers(); }
  });
});
