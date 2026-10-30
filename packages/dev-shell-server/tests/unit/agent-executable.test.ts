import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { resolveCodeBuddyExecutable } from "../../src/agent/executable.js";
import { createMcpConfig, removeMcpConfig } from "../../src/agent/mcp-config.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), "codebuddy path &%()-"));
  directories.push(root);
  return root;
}

it("runs an explicit Node script with argv rather than a shell", async () => {
  const root = await directory();
  const script = path.join(root, "agent script.mjs");
  await writeFile(script, "process.stdout.write('ok');");
  await chmod(script, 0o700);
  expect(await resolveCodeBuddyExecutable(script)).toEqual({ command: process.execPath, args: [script] });
});

it.runIf(process.platform === "win32")("resolves a recognized Node shim in a path with shell metacharacters without executing cmd", async () => {
  const root = await directory();
  const script = path.join(root, "agent script.js");
  const shim = path.join(root, "codebuddy.cmd");
  await writeFile(script, "process.stdout.write('ok');");
  await writeFile(shim, '@echo off\r\nnode "%~dp0agent script.js" %*\r\n');
  expect(await resolveCodeBuddyExecutable(shim)).toEqual({ command: process.execPath, args: [script] });
});

it.runIf(process.platform === "win32")("fails closed on an arbitrary batch wrapper", async () => {
  const root = await directory();
  const shim = path.join(root, "codebuddy.cmd");
  await writeFile(shim, '@echo off\r\necho arbitrary %*\r\n');
  await expect(resolveCodeBuddyExecutable(shim)).rejects.toThrow("CODEBUDDY_RESOLUTION_FAILED");
});

it("creates a protected per-session MCP file, keeps the token out of its name and removes it", async () => {
  const root = await directory();
  const token = "test-token-for-config";
  const config = await createMcpConfig(root, "session-one", "http://127.0.0.1:4321/mcp", token);
  expect(config).not.toContain(token);
  expect(JSON.parse(await readFile(config, "utf8"))).toMatchObject({ mcpServers: { "dev-shell": { type: "http", headers: { Authorization: `Bearer ${token}` } } } });
  await removeMcpConfig(config);
  await expect(readFile(config)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects session path traversal and header injection before writing MCP credentials", async () => {
  const root = await directory();
  await expect(createMcpConfig(root, "../escape", "http://127.0.0.1/mcp", "token")).rejects.toThrow("MCP_CONFIG_INVALID");
  await expect(createMcpConfig(root, "session", "http://127.0.0.1/mcp", "token\r\nx: y")).rejects.toThrow("MCP_CONFIG_INVALID");
});
