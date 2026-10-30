import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { removeMcpConfig } from "./mcp-config.js";
import { backendErrorPrefix, prepareAgentLaunch } from "./backends.js";
import { NdjsonParser } from "./ndjson.js";
import { managedProcess, terminateProcessTree } from "./process-tree.js";
import { redactText, StreamRedactor } from "./sanitize.js";
import type {
  AgentOutputEvent,
  AgentSessionState,
  CodeBuddySupervisorOptions,
  StartAgentOptions,
} from "./types.js";

const STDERR_LIMIT = 64 * 1024;

type StopReason = "cancelled" | "interrupted" | "timeout";

interface Job {
  options: StartAgentOptions;
  state: AgentSessionState;
  child?: ChildProcessWithoutNullStreams;
  parser?: NdjsonParser;
  configFile?: string;
  stopReason?: StopReason;
  sawResult: boolean;
  sawCompletedText?: boolean;
  resultFailed: boolean;
  spawnError?: Error;
  settled: boolean;
  done: Promise<void>;
  finish: () => void;
  termination?: Promise<void>;
}

export class CodeBuddySupervisor {
  private readonly jobs = new Map<string, Job>();
  private readonly active = new Set<Job>();
  private readonly completed = new Map<string, Promise<void>>();
  private draining = false;
  private closing = false;

  constructor(private readonly options: CodeBuddySupervisorOptions) {}

  setMcpUrl(url: string): void {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("MCP_URL_INVALID");
    this.options.mcpUrl = parsed.toString();
  }

  async start(options: StartAgentOptions): Promise<void> {
    if (this.closing) throw new Error("SUPERVISOR_CLOSED");
    if (this.jobs.has(options.sessionId) || this.completed.has(options.sessionId)) throw new Error("SESSION_ALREADY_EXISTS");
    if (!options.prompt || !options.workspace) throw new Error("SESSION_INPUT_INVALID");
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.sessionId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(options.cliSessionId ?? options.sessionId)) throw new Error("SESSION_INPUT_INVALID");
    if (!["default", "acceptEdits", "plan"].includes(options.settings.permissionMode)
      || !Number.isInteger(options.settings.maxConcurrent) || options.settings.maxConcurrent < 1 || options.settings.maxConcurrent > 8
      || !Number.isFinite(options.settings.timeoutMs) || options.settings.timeoutMs <= 0
      || (options.settings.model !== null && !/^[\w./:@+-]{1,160}$/.test(options.settings.model))) throw new Error("SESSION_SETTINGS_INVALID");
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const job: Job = { options: { ...options, settings: { ...options.settings } }, state: "queued", sawResult: false, resultFailed: false, settled: false, done, finish };
    this.jobs.set(options.sessionId, job);
    this.state(job, "queued");
    void this.drain();
  }

  async cancel(sessionId: string): Promise<void> {
    const job = this.jobs.get(sessionId);
    if (!job || job.settled) return;
    if (job.state === "queued") {
      job.state = "cancelled";
      this.emitState(job, "cancelled");
      this.settle(job);
      void this.drain();
      return;
    }
    this.stop(job, "cancelled");
    await job.done;
  }

  wait(sessionId: string): Promise<void> { return this.jobs.get(sessionId)?.done ?? this.completed.get(sessionId) ?? Promise.resolve(); }

  async close(): Promise<void> {
    if (this.closing) return Promise.all([...this.jobs.values()].map((job) => job.done)).then(() => undefined);
    this.closing = true;
    for (const job of this.jobs.values()) {
      if (job.settled) continue;
      if (job.state === "queued") {
        job.state = "cancelled";
        this.emitState(job, "cancelled");
        this.settle(job);
      } else {
        this.stop(job, "interrupted");
      }
    }
    await Promise.all([...this.jobs.values()].map((job) => job.done));
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.closing) {
        const creators = new Set([...this.active].map((job) => job.options.creatorId));
        const job = [...this.jobs.values()].find((candidate) =>
          candidate.state === "queued" && !creators.has(candidate.options.creatorId)
          && this.active.size < (this.options.maxConcurrent?.() ?? candidate.options.settings.maxConcurrent));
        if (!job) break;
        this.jobs.delete(job.options.sessionId);
        this.jobs.set(job.options.sessionId, job);
        this.active.add(job);
        void this.run(job);
      }
    } finally {
      this.draining = false;
    }
  }

  private async run(job: Job): Promise<void> {
    const { options } = job;
    const prefix = backendErrorPrefix(options.backend ?? options.settings.backend ?? "codebuddy");
    const timer = setTimeout(() => {
      if (job.settled) return;
      this.stop(job, "timeout");
    }, options.settings.timeoutMs);
    timer.unref();
    try {
      this.state(job, "spawning");
      const workspace = await this.validateWorkspace(options.workspace);
      if (this.stoppedBeforeSpawn(job)) return;
      const launch = await prepareAgentLaunch(options, this.options.dataDir, this.options.mcpUrl);
      const {executable} = launch;
      job.configFile = launch.configFile;
      if (this.stoppedBeforeSpawn(job)) return;

      const args = [...executable.args, ...launch.args];
      const managed = managedProcess(executable.command, args, workspace, launch.env);
      const child = spawn(managed.command, managed.args, {
        cwd: workspace,
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        env: managed.env,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
      job.child = child;
      job.parser = new NdjsonParser((event) => {
        if (launch.backend === "opencode-v2" && event.kind === "assistant" && event.normalized?.completedText === true) job.sawCompletedText = true;
        if (event.kind === "result") {
          job.sawResult = true;
          const result = event.raw as Record<string, unknown>;
          job.resultFailed ||= event.normalized?.isError === true || result.is_error === true || (typeof result.subtype === "string" && result.subtype.startsWith("error"));
        }
        this.output(job, event);
      }, undefined, undefined, [options.agentToken], launch.backend);
      child.stdout.on("data", (chunk: Buffer) => job.parser?.write(chunk));
      const stderrRedactor = new StreamRedactor([options.agentToken]);
      const stderrDecoder = new StringDecoder("utf8");
      let stderrBytes = 0;
      let stderrTruncated = false;
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderrBytes >= STDERR_LIMIT) return;
        const allowed = Math.min(chunk.length, STDERR_LIMIT - stderrBytes);
        stderrBytes += allowed;
        const text = stderrRedactor.write(stderrDecoder.write(chunk.subarray(0, allowed)));
        if (text) this.output(job, { stream: "stderr", raw: text, kind: "stderr", truncated: allowed < chunk.length || undefined });
        if (allowed < chunk.length) stderrTruncated = true;
      });
      child.once("spawn", () => {
        if (job.settled) return;
        this.state(job, "running");
        if (job.stopReason) job.termination ??= terminateProcessTree(child);
        child.stdin.on("error", (error) => { job.spawnError ??= error; });
        child.stdin.end(options.prompt, "utf8");
      });
      child.once("error", (error) => { job.spawnError = error; });
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      const stderrRest = stderrRedactor.write(stderrDecoder.end()) + stderrRedactor.end();
      if (stderrRest) this.output(job, { stream: "stderr", raw: stderrRest, kind: "stderr" });
      if (stderrTruncated) this.output(job, { stream: "system", raw: "stderr exceeded size limit; output truncated", kind: "warning", truncated: true });
      job.parser.end();
      if (job.stopReason === "cancelled") this.finishState(job, "cancelled");
      else if (job.stopReason === "interrupted") this.finishState(job, "interrupted");
      else if (job.stopReason === "timeout") {
        this.output(job, { stream: "system", raw: `${prefix}_TIMEOUT`, kind: "error" });
        this.finishState(job, "failed");
      } else if (job.spawnError && exit.code !== 0) {
        this.output(job, { stream: "system", raw: `${prefix}_SPAWN_FAILED: ${redactText(job.spawnError.message, [options.agentToken])}`, kind: "error" });
        this.finishState(job, "failed");
      } else if (job.resultFailed) {
        this.output(job, { stream: "system", raw: `${prefix}_RESULT_ERROR`, kind: "error" });
        this.finishState(job, "failed");
      } else if (exit.code !== 0) {
        this.output(job, { stream: "system", raw: `${prefix}_EXIT_${exit.code ?? exit.signal ?? "UNKNOWN"}`, kind: "error" });
        this.finishState(job, "failed");
      } else if (!job.sawResult && launch.backend === "opencode-v2" && job.sawCompletedText) {
        // V2 run returns after session.execution.succeeded without necessarily
        // printing a final step_finish. Require both exit 0 and a text part
        // with a server-issued end timestamp; arbitrary stdout is insufficient.
        this.output(job, {stream: "system", kind: "result", raw: {type: "process.completed", backend: launch.backend, exitCode: 0, completion: "completed-text"}, normalized: {isError: false}});
        this.finishState(job, "succeeded");
      } else if (!job.sawResult) {
        this.output(job, { stream: "system", raw: `${prefix}_RESULT_MISSING`, kind: "warning" });
        this.finishState(job, "completed_with_warning");
      } else {
        this.finishState(job, "succeeded");
      }
    } catch (error) {
      if (!job.settled) {
        if (job.stopReason === "cancelled") this.finishState(job, "cancelled");
        else if (job.stopReason === "interrupted") this.finishState(job, "interrupted");
        else {
          const code = error instanceof Error ? error.message : `${prefix}_START_FAILED`;
          this.output(job, { stream: "system", raw: redactText(code, [options.agentToken]), kind: "error" });
          this.finishState(job, "failed");
        }
      }
    } finally {
      clearTimeout(timer);
      await job.termination;
      if (job.configFile) await removeMcpConfig(job.configFile).catch(() => undefined);
      this.settle(job);
    }
  }

  private stoppedBeforeSpawn(job: Job): boolean {
    if (!job.stopReason) return false;
    if (job.stopReason === "timeout") this.output(job, { stream: "system", raw: `${backendErrorPrefix(job.options.backend ?? job.options.settings.backend ?? "codebuddy")}_TIMEOUT`, kind: "error" });
    this.finishState(job, job.stopReason === "interrupted" ? "interrupted" : job.stopReason === "timeout" ? "failed" : "cancelled");
    return true;
  }

  private async validateWorkspace(workspace: string): Promise<string> {
    const info = await stat(workspace);
    if (!info.isDirectory()) throw new Error("WORKSPACE_NOT_DIRECTORY");
    return realpath(workspace);
  }

  private finishState(job: Job, state: AgentSessionState): void {
    if (job.settled || ["succeeded", "failed", "cancelled", "interrupted", "completed_with_warning"].includes(job.state)) return;
    job.state = state;
    this.emitState(job, state);
  }

  private state(job: Job, state: AgentSessionState): void {
    job.state = state;
    this.emitState(job, state);
  }

  private stop(job: Job, reason: StopReason): void {
    if (job.stopReason || job.settled) return;
    job.stopReason = reason;
    if (job.child) job.termination ??= terminateProcessTree(job.child);
  }

  private emitState(job: Job, state: AgentSessionState): void {
    try { this.options.onState(job.options.sessionId, state); } catch { /* consumer isolation */ }
  }

  private output(job: Job, event: AgentOutputEvent): void {
    try { this.options.onOutput(job.options.sessionId, event); } catch { /* consumer isolation */ }
  }

  private settle(job: Job): void {
    if (job.settled) return;
    job.settled = true;
    this.active.delete(job);
    this.jobs.delete(job.options.sessionId);
    this.completed.set(job.options.sessionId, job.done);
    if (this.completed.size > 4096) this.completed.delete(this.completed.keys().next().value!);
    job.finish();
    void this.drain();
  }
}

export { CodeBuddySupervisor as AgentSupervisor };
