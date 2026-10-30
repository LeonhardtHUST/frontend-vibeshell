import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { resolveCodeBuddyExecutable } from "../../src/agent/executable.js";
import { assertRestrictedAcl, createMcpConfig, decodeAcl, removeMcpConfig } from "../../src/agent/mcp-config.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

// Windows runners expose tmpdir as an 8.3 short path while the implementation
// resolves real paths, so expectations are built from the canonical directory.
async function directory() {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "codebuddy path &%()-"));
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

it("accepts a saved Windows ACL whatever encoding icacls used", () => {
  const sid = "S-1-5-21-1-2-3-1001";
  const text = `acl.json\nD:PAI(A;OICI;FA;;;${sid})`;
  expect(decodeAcl(Buffer.from(`\ufeff${text}`, "utf16le"))).toContain("A;OICI;FA");
  expect(decodeAcl(Buffer.from(text, "utf8"))).toContain("A;OICI;FA");
  expect(decodeAcl(Buffer.from(text, "latin1"))).toContain("A;OICI;FA");
});

it("rejects a saved Windows ACL that grants a deny or a foreign principal", () => {
  const sid = "S-1-5-21-1-2-3-1001";
  expect(() => assertRestrictedAcl(`acl.json\nD:PAI(A;OICI;FA;;;${sid})`, sid)).not.toThrow();
  expect(() => assertRestrictedAcl(`acl.json\nD:PAI(A;OICI;FA;;;${sid})(A;OICI;FA;;;S-1-3-4)`, sid)).not.toThrow();
  expect(() => assertRestrictedAcl(`acl.json\nD:PAI(A;OICI;FA;;;${sid})(A;OICI;FA;;;S-1-5-32-545)`, sid)).toThrow("MCP_CONFIG_PERMISSIONS_INVALID");
  expect(() => assertRestrictedAcl(`acl.json\nD:PAI(A;OICI;FA;;;${sid})(D;;FA;;;S-1-5-32-545)`, sid)).toThrow("MCP_CONFIG_PERMISSIONS_INVALID");
  expect(() => assertRestrictedAcl("", sid)).toThrow("MCP_CONFIG_PERMISSIONS_INVALID");
});
