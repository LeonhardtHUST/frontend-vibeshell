import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
let identitySid: Promise<string> | undefined;

const windowsTool = (name: string) => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);

// Path and SID arrive as environment data, never executable PowerShell text.
// Construct a fresh DACL so creator-group or inherited grants cannot survive.
const PROTECT_FILE = String.raw`
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.SecurityIdentifier]::new($env:DEV_SHELL_ACL_SID)
$acl = [System.Security.AccessControl.FileSecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow))
[System.IO.File]::SetAccessControl($env:DEV_SHELL_ACL_PATH, $acl)
$actual = [System.IO.File]::GetAccessControl($env:DEV_SHELL_ACL_PATH)
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  @{sid=$_.IdentityReference.Value; type=$_.AccessControlType.ToString(); inherited=$_.IsInherited; fullControl=(($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)}
})
@{protected=$actual.AreAccessRulesProtected; rules=$rules} | ConvertTo-Json -Compress -Depth 4
`;

async function protectWindowsFile(file: string): Promise<void> {
  identitySid ??= execute(windowsTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true })
    .then(({ stdout }) => {
      const sid = stdout.match(/S-1-\d+(?:-\d+)+/i)?.[0];
      if (!sid) throw new Error("MCP_CONFIG_IDENTITY_FAILED");
      return sid;
    });
  const sid = await identitySid;
  const {stdout} = await execute(windowsTool("WindowsPowerShell/v1.0/powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PROTECT_FILE], {
    windowsHide: true,
    env: {...process.env, DEV_SHELL_ACL_PATH: file, DEV_SHELL_ACL_SID: sid},
  });
  const actual = JSON.parse(stdout) as {protected: boolean; rules: Array<{sid: string; type: string; inherited: boolean; fullControl: boolean}>};
  if (!actual.protected || actual.rules?.length !== 1 || actual.rules[0]?.sid !== sid || actual.rules[0].type !== "Allow" || actual.rules[0].inherited || !actual.rules[0].fullControl) {
    throw new Error("MCP_CONFIG_PERMISSIONS_INVALID");
  }
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
