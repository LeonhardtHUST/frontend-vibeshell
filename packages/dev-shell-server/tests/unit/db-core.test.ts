import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchDatabase } from "../../src/db/database.js";
import { initialMigration } from "../../src/db/schema.js";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
const database = () => { const path = mkdtempSync(join(tmpdir(), "dev-shell-db-")); paths.push(path); return new WorkbenchDatabase(join(path, "test.sqlite")); };

describe("WorkbenchDatabase", () => {
  it("migrates, survives restart and enforces append-only events", () => {
    const pathDir = mkdtempSync(join(tmpdir(), "dev-shell-restart-")); paths.push(pathDir);
    const path = join(pathDir, "workbench.sqlite");
    const first = new WorkbenchDatabase(path);
    expect(first.get("PRAGMA foreign_keys")!.foreign_keys).toBe(1);
    expect(first.get("PRAGMA journal_mode")!.journal_mode).toBe("wal");
    first.transaction(() => first.appendEvent("settings", null, "settings", { ok: true }));
    expect(first.latestEvent()!.sequence).toBe(1);
    expect(() => first.run("DELETE FROM events WHERE sequence=1")).toThrow(/append-only/);
    expect(() => first.run("UPDATE events SET entityId='x' WHERE sequence=1")).toThrow(/append-only/);
    first.close();
    const second = new WorkbenchDatabase(path); expect(second.latestEvent()!.eventId).toBeDefined(); second.close();
  });

  it("rolls back entities and events together", () => {
    const store = database();
    expect(() => store.transaction(() => { store.appendEvent("activity", null, "a", {}); throw new Error("abort"); })).toThrow("abort");
    expect(store.latestEvent()).toBeUndefined(); store.close();
  });

  it("migrates legacy session replay data without retaining a plaintext agent token", () => {
    const directory = mkdtempSync(join(tmpdir(), "dev-shell-legacy-")); paths.push(directory);
    const path = join(directory, "workbench.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(initialMigration); legacy.exec("PRAGMA user_version=1");
    const timestamp = new Date().toISOString();
    legacy.prepare("INSERT INTO visitors(id,kind,displayName,createdAt,lastSeenAt) VALUES('owner','human','Owner',?,?),('agent','agent','Agent',?,?)").run(timestamp, timestamp, timestamp, timestamp);
    legacy.prepare("INSERT INTO agent_sessions(id,creatorId,agentVisitorId,workspace,status,cliSessionId,queueItemIdsJson,createdAt) VALUES('session','owner','agent','workspace','queued','cli','[]',?)").run(timestamp);
    legacy.prepare("INSERT INTO idempotency_keys VALUES('owner','workbench','legacy','hash',?,?)").run(JSON.stringify({ session: { id: "session" }, prompt: "Keep business data", agentToken: "legacy-secret", agentVisitor: { id: "agent" } }), timestamp);
    legacy.close();
    const upgraded = new WorkbenchDatabase(path);
    expect(upgraded.get("PRAGMA user_version")!.user_version).toBe(3);
    expect(upgraded.get("SELECT promptText FROM agent_sessions")!.promptText).toBe("Keep business data");
    expect(JSON.parse(String(upgraded.get("SELECT responseJson FROM idempotency_keys")!.responseJson))).toEqual({ session: { id: "session" } });
    upgraded.close();
  });

  it("isolates notification failures after a successful commit", () => {
    const store = database();
    store.subscribe(() => { throw new Error("disconnected observer"); });
    const delivered: string[] = [];
    store.subscribe(event => delivered.push(event.eventId));
    expect(() => store.transaction(() => store.appendEvent("activity", null, "a", {}))).not.toThrow();
    expect(store.latestEvent()!.eventId).toBe(delivered[0]);
    store.close();
  });

  it("publishes the whole committed batch before writes triggered by an observer", () => {
    const store = database();
    store.subscribe(event => {
      if (event.entityId === "first") store.transaction(() => store.appendEvent("activity", null, "nested", {}));
    });
    const observed: string[] = [];
    store.subscribe(event => observed.push(event.entityId));
    store.transaction(() => {
      store.appendEvent("activity", null, "first", {});
      store.appendEvent("activity", null, "second", {});
    });
    expect(observed).toEqual(["first", "second", "nested"]);
    store.close();
  });
});
