import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
let identitySid: Promise<string> | undefined;

const windowsTool = (name: string) => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);

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
    const acl = (await readFile(aclFile)).toString("utf16le");
    const permissions = [...acl.matchAll(/\((A|D);[^)]*;;;([^;)]+)\)/g)];
    if (!permissions.length || permissions.some((entry) => entry[1] !== "A" || entry[2] !== sid)) {
      throw new Error("MCP_CONFIG_PERMISSIONS_INVALID");
    }
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
