import { existsSync, mkdirSync, mkdtempSync, rmSync, realpathSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevShellServer, type DevShellServer } from "../../src/server.js";
import { loadConfig } from "../../src/config.js";
import { parseCli } from "../../src/cli-options.js";

let root: string;
const servers: DevShellServer[] = [];
beforeEach(() => {
  root = mkdtempSync(join(realpathSync.native(tmpdir()), "dev-shell-standalone-"));
  mkdirSync(join(root, "A")); mkdirSync(join(root, "B"));
  for (const key of ["DEV_SHELL_HOST", "DEV_SHELL_PORT", "DEV_SHELL_WORKSPACE", "DEV_SHELL_DATA_DIR", "DEV_SHELL_DATABASE", "DEV_SHELL_TARGET", "DEV_SHELL_BACKEND"]) vi.stubEnv(key, undefined);
});
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); vi.unstubAllEnvs(); rmSync(root, {recursive: true, force: true}); });
const config = () => ({port: 0, workspace: join(root, "A"), dataDir: join(root, "data")});
function create(extra = {}) {const server = createDevShellServer({config: {...config(), ...extra}}); servers.push(server); return server;}

describe("standalone CLI and workbench lifecycle", () => {
  it("parses explicit CLI values ahead of environment and isolates default data by canonical workspace", () => {
    vi.stubEnv("DEV_SHELL_WORKSPACE", join(root, "B")); vi.stubEnv("DEV_SHELL_PORT", "1234"); vi.stubEnv("DEV_SHELL_BACKEND", "codebuddy");
    const parsed = parseCli(["--workspace", join(root, "A"), "--port", "5678", "--backend", "codex"]);
    const next = loadConfig(parsed.config);
    expect(next).toMatchObject({workspace: join(root, "A"), port: 5678, startupSettings: {backend: "codex"}});
    expect(loadConfig({workspace: join(root, "A")}).dataDir).not.toBe(loadConfig({workspace: join(root, "B")}).dataDir);
    expect(existsSync(next.dataDir)).toBe(false);
    expect(() => parseCli(["--port", "NaN"])).toThrow();
    expect(() => parseCli(["--backend", "unknown"])).toThrow();
    expect(() => parseCli(["--unknown"])).toThrow();
    expect(parseCli(["--help"]).help).toBe(true);
    expect(parseCli(["--version"]).version).toBe(true);
  });

  it("locks before recovery, rejects a second port on the same DB, and releases on close", async () => {
    const first = create(); const owner = first.service.bootstrapOwner("A");
    const session = first.service.createSession(owner.visitor.id, {prompt: "Keep queued", queueItemIds: [], clientMessageId: "one"});
    expect(() => createDevShellServer({config: {...config(), port: 54321}})).toThrow(/WORKBENCH_ALREADY_RUNNING/);
    expect(first.service.getSession(session.session.id).status).toBe("queued");
    await first.close();
    const next = create();
    expect(next.service.getSession(session.session.id).status).toBe("interrupted");
    expect(next.service.authenticate(owner.token).visitor.id).toBe(owner.visitor.id);
  });

  it("rejects another workspace before changing sessions or settings in an existing v3 DB", async () => {
    const first = create(); const owner = first.service.bootstrapOwner();
    const session = first.service.createSession(owner.visitor.id, {prompt: "Preserve", queueItemIds: [], clientMessageId: "one"});
    await first.close();
    expect(() => createDevShellServer({config: {...config(), workspace: join(root, "B")}})).toThrow(/WORKSPACE_MISMATCH/);
    const reader = new DatabaseSync(join(root, "data/workbench.sqlite"), {readOnly: true});
    try {
      expect(reader.prepare("SELECT status FROM agent_sessions WHERE id=?").get(session.session.id)?.status).toBe("queued");
      expect(reader.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    } finally {reader.close();}
  });

  it("applies explicit target/backend to persisted settings and keeps identity and credentials", async () => {
    const first = create(); const owner = first.service.bootstrapOwner();
    first.service.updateSettings(owner.visitor.id, {backend: "codebuddy", model: "old-model"});
    const identity = first.workbenchId; await first.close();
    vi.stubEnv("DEV_SHELL_TARGET", "http://127.0.0.1:5555/env"); vi.stubEnv("DEV_SHELL_BACKEND", "codebuddy");
    const parsed = parseCli(["--target", "http://127.0.0.1:6666/page", "--backend", "codex"]);
    const next = create(parsed.config);
    expect(next.service.getSettings()).toMatchObject({backend: "codex", model: null, defaultTarget: "http://127.0.0.1:6666/page"});
    expect(next.service.getSettings().allowedOrigins).toContain("http://127.0.0.1:6666");
    expect(next.workbenchId).toBe(identity);
    expect(next.service.authenticate(owner.token).visitor.id).toBe(owner.visitor.id);
    await next.listen();
    const health = await fetch(`http://127.0.0.1:${next.config.port}/api/health`).then(response => response.json());
    expect(health).toMatchObject({workbenchId: identity, ownerBootstrapped: true, protocolVersion: 2});
    vi.stubEnv("DEV_SHELL_TARGET", undefined); vi.stubEnv("DEV_SHELL_BACKEND", undefined);
    await next.close();
    expect(create().service.getSettings()).toMatchObject({backend: "codex", defaultTarget: "http://127.0.0.1:6666/page"});
  });

  it("keeps the workspace fixed through settings and per-session requests", () => {
    const server = create(); const owner = server.service.bootstrapOwner();
    expect(() => server.service.updateSettings(owner.visitor.id, {workspace: join(root, "B")})).toThrow(/Workspace is fixed/);
    expect(() => server.service.createSession(owner.visitor.id, {workspace: join(root, "B"), prompt: "No", queueItemIds: [], clientMessageId: "no"})).toThrow(/Workspace is fixed/);
    expect(server.service.listSessions()).toHaveLength(0);
  });

  it("recovers a stale lock after abnormal termination", () => {
    mkdirSync(join(root, "data"));
    const lock = join(root, "data/workbench.sqlite.lock"); mkdirSync(lock);
    const stale = new Date(Date.now() - 15_000); utimesSync(lock, stale, stale);
    expect(create().workbenchId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("cleans up its lock when listening on an occupied port fails", async () => {
    const first = create(); await first.listen();
    const second = create({dataDir: join(root, "other-data"), port: first.config.port});
    await expect(second.listen()).rejects.toMatchObject({code: "EADDRINUSE"});
    await second.close();
    const third = create({dataDir: join(root, "other-data"), port: 0});
    await expect(third.listen()).resolves.toMatchObject({address: "127.0.0.1"});
  });
});
