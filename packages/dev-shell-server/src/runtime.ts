import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import lockfile from "proper-lockfile";
import { canonicalWorkspace, workspaceKey, type ServerConfig } from "./config.js";
import type { Settings } from "@hustradio/dev-shell-contract";
import type { WorkbenchDatabase } from "./db/database.js";

export function acquireWorkbench(config: ServerConfig) {
  mkdirSync(config.dataDir, {recursive: true, mode: 0o700});
  mkdirSync(dirname(config.databasePath), {recursive: true, mode: 0o700});
  // Resolve parent junctions too, including when the SQLite file is not created yet.
  const database = existsSync(config.databasePath) ? realpathSync(config.databasePath)
    : join(realpathSync(dirname(config.databasePath)), basename(config.databasePath));
  config.databasePath = database;
  let release: () => void;
  try {
    release = lockfile.lockSync(database, {realpath: false, stale: 10_000, update: 2_000});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new Error("WORKBENCH_ALREADY_RUNNING: this database is locked by another Dev Shell; after an abnormal exit wait up to 10 seconds and retry");
    throw error;
  }
  try {
    // Read-only preflight precedes migrations and orphan-session recovery.
    if (existsSync(database)) {
      const reader = new DatabaseSync(database, {readOnly: true});
      try {
        const table = reader.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
        const row = table ? reader.prepare("SELECT valueJson FROM settings WHERE id=1").get() : undefined;
        if (row) {
          const stored = JSON.parse(String(row.valueJson)) as Settings;
          let matches = false;
          try { matches = workspaceKey(canonicalWorkspace(stored.workspace)) === workspaceKey(config.workspace); } catch { /* Report the old path without changing it. */ }
          if (!matches) throw new Error(`WORKSPACE_MISMATCH: this database belongs to ${JSON.stringify(stored.workspace)}. Restart with --workspace pointing there, or choose a different --data-dir.`);
        }
      } finally { reader.close(); }
    }
    const identityPath = `${database}.identity.json`;
    let workbenchId: string;
    if (existsSync(identityPath)) {
      workbenchId = JSON.parse(readFileSync(identityPath, "utf8")).workbenchId;
      if (!/^[0-9a-f-]{36}$/.test(workbenchId)) throw new Error("Invalid workbench identity file");
    } else {
      workbenchId = randomUUID();
      writeFileSync(identityPath, JSON.stringify({workbenchId}) + "\n", {flag: "wx", mode: 0o600});
    }
    let released = false;
    return {workbenchId, release() {if (!released) {released = true; release();}}};
  } catch (error) { release(); throw error; }
}

export function applyStartupSettings(store: WorkbenchDatabase, config: ServerConfig): void {
  const row = store.get("SELECT valueJson FROM settings WHERE id=1");
  if (!row) return;
  const previous = JSON.parse(String(row.valueJson)) as Settings;
  const next = {...previous, workspace: config.workspace, ...config.startupSettings};
  if (config.startupSettings.backend && config.startupSettings.backend !== (previous.backend ?? "codebuddy")) next.model = null;
  if (config.startupSettings.defaultTarget) next.allowedOrigins = [...new Set([...previous.allowedOrigins, new URL(config.startupSettings.defaultTarget).origin])];
  if (JSON.stringify(next) === JSON.stringify(previous)) return;
  store.transaction(() => {
    store.run("UPDATE settings SET valueJson=?,revision=revision+1 WHERE id=1", JSON.stringify(next));
    store.appendEvent("settings", null, "settings", next);
  });
}
