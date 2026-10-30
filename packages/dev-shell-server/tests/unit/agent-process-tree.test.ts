import { spawn, type ChildProcess } from "node:child_process";
import { expect, it, vi } from "vitest";
import { managedProcess, terminateProcessTree } from "../../src/agent/process-tree.js";

it("preserves argument boundaries and binary UTF-8 stdio through the managed launcher", async () => {
  const values = ["", 'a"b', "\\", "trailing\\", "spaces & % ()", "你好"];
  const launch = managedProcess(process.execPath, ["-e", "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(1),input}));process.stderr.write('错误 stderr')})", ...values], process.cwd(), process.env);
  const child = spawn(launch.command, launch.args, {env: launch.env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"]});
  const output: Buffer[] = []; const errors: Buffer[] = [];
  child.stdout.on("data", chunk => output.push(chunk)); child.stderr.on("data", chunk => errors.push(chunk));
  child.stdin.end('提示 "quoted" & %\n你好');
  const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  expect(Buffer.concat(errors).toString("utf8")).toBe("错误 stderr");
  expect(code).toBe(0);
  expect(JSON.parse(Buffer.concat(output).toString("utf8"))).toEqual({args: values, input: '提示 "quoted" & %\n你好'});
});

it.runIf(process.platform === "win32")("does not kill or look up an exited launcher's PID", async () => {
  // Deliberately reuse the current live PID as the stale child PID: the guard
  // must never target the unrelated process that now owns that number.
  const kill = vi.fn();
  await terminateProcessTree({pid: process.pid, exitCode: 0, signalCode: null, kill} as unknown as ChildProcess);
  expect(kill).not.toHaveBeenCalled();
});
