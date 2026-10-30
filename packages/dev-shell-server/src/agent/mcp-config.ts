import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
let identitySid: Promise<string> | undefined;

const windowsTool = (name: string) => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);

// Principals that never widen read access beyond the current user: OWNER RIGHTS
// resolves to the file owner and LOCAL SYSTEM already bypasses DACLs machine-wide.
const ALLOWED_EXTRA_PRINCIPALS = new Set(["S-1-3-4", "S-1-5-18"]);

/** icacls /save writes Unicode, but some Windows builds fall back to the ANSI code page. */
export function decodeAcl(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const rest = bytes.subarray(2);
    return Buffer.from(rest.subarray(0, rest.length - rest.length % 2)).swap16().toString("utf16le");
  }
  const sample = bytes.subarray(0, Math.min(bytes.length, 512));
  let zeros = 0;
  for (let index = 1; index < sample.length; index += 2) if (sample[index] === 0) zeros += 1;
  return sample.length >= 4 && zeros >= sample.length / 4 ? bytes.toString("utf16le") : bytes.toString("utf8");
}

export function assertRestrictedAcl(acl: string, sid: string): void {
  const entries = [...acl.matchAll(/\(([AD]);([^)]*)\)/g)].map((match) => ({
    type: match[1]!,
    principal: (match[2]!.split(";").at(-1) ?? "").toUpperCase(),
  }));
  const denied = entries.filter((entry) => entry.type !== "A");
  const foreign = entries.filter((entry) => entry.principal !== sid.toUpperCase() && !ALLOWED_EXTRA_PRINCIPALS.has(entry.principal));
  if (entries.length === 0 || denied.length > 0 || foreign.length > 0) {
    const summary = entries.map((entry) => `${entry.type}:${entry.principal === sid.toUpperCase() ? "self" : entry.principal.startsWith("S-1-") ? entry.principal : "malformed"}`).join(",");
    throw new Error(`MCP_CONFIG_PERMISSIONS_INVALID (chars=${acl.length}, entries=${entries.length}, acl=[${summary}])`);
  }
}

async function protectWindowsFile(file: string): Promise<void> {
  identitySid ??= execute(windowsTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true })
    .then(({ stdout }) => {
      const sid = stdout.match(/S-1-\d+(?:-\d+)+/i)?.[0];
      if (!sid) throw new Error("MCP_CONFIG_IDENTITY_FAILED");
      return sid;
    });
  const sid = await identitySid;
  await execute(windowsTool("icacls.exe"), [file, "/inheritance:r", "/grant:r", `*${sid}:(F)`], { windowsHide: true });
  const aclFile = `${file}.acl`;
  try {
    await execute(windowsTool("icacls.exe"), [file, "/save", aclFile, "/q"], { windowsHide: true });
    const acl = decodeAcl(await readFile(aclFile));
    assertRestrictedAcl(acl, sid);
  } finally { await rm(aclFile, { force: true }); }
}

export async function createMcpConfig(dataDir: string, sessionId: string, mcpUrl: string, token: string): Promise<string> {
  const url = new URL(mcpUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("MCP_URL_INVALID");
  if (url.username || url.password || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || !token || /[\r\n]/.test(token)) throw new Error("MCP_CONFIG_INVALID");
  const directory = path.join(dataDir, "mcp");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${sessionId}-${randomUUID()}.json`);
  const handle = await open(file, "wx", 0o600);
  try {
    // The file is empty until the Windows DACL is restricted and verified.
    if (process.platform === "win32") await protectWindowsFile(file);
    await handle.writeFile(JSON.stringify({
      mcpServers: {
        "dev-shell": {
          type: "http",
          url: url.toString(),
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    }), "utf8");
  } catch (error) {
    await handle.close();
    await rm(file, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  return file;
}

export async function removeMcpConfig(file: string): Promise<void> {
  await rm(file, { force: true });
}
