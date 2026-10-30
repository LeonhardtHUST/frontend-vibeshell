import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { WINDOWS_JOB_LAUNCHER } from "./windows-job.js";

export function managedProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform !== "win32") return {command, args, env};
  return {
    command: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_JOB_LAUNCHER],
    env: {...env, DEV_SHELL_JOB_LAUNCH: JSON.stringify({command, args, cwd})},
  };
}

export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // The managed launcher owns a KILL_ON_JOB_CLOSE job. Terminate its original
    // process handle rather than looking up a PID that may already be reused.
    if (child.exitCode === null && child.signalCode === null) { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    if (child.exitCode === null) { try { child.kill("SIGTERM"); } catch { /* already exited */ } }
  }
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch {
        if (child.exitCode === null) { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
      }
      resolve();
    }, 1_000);
    // Keep the group kill scheduled even if the parent exits first: descendants
    // may ignore SIGTERM and hold inherited pipes open.
  });
}
