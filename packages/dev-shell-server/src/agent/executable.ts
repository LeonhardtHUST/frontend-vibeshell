import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentBackend } from "@hustradio/dev-shell-contract";

export interface ResolvedExecutable {
  command: string;
  args: string[];
}

const WINDOWS_EXTENSIONS = [".exe", ".cmd", ".bat", ".js", ".mjs", ".cjs"];

export async function resolveCodeBuddyExecutable(configured: string): Promise<ResolvedExecutable> {
  if (!configured || configured.includes("\0")) throw new Error("CODEBUDDY_RESOLUTION_FAILED");
  const hasSeparator = /[\\/]/.test(configured);
  const candidates = hasSeparator || path.isAbsolute(configured)
    ? [path.resolve(configured)]
    : await pathCandidates(configured);
  for (const candidate of candidates) {
    if (!await isFile(candidate)) continue;
    return wrap(candidate);
  }
  throw new Error("CODEBUDDY_NOT_FOUND");
}

export async function resolveAgentExecutable(configured: string, backend: AgentBackend): Promise<ResolvedExecutable> {
  try { return await resolveCodeBuddyExecutable(configured); }
  catch (error) {
    const prefix = backend === "codex" ? "CODEX" : backend === "opencode-v2" ? "OPENCODE" : "CODEBUDDY";
    if (error instanceof Error && error.message.startsWith("CODEBUDDY_")) throw new Error(error.message.replace(/^CODEBUDDY_/, `${prefix}_`));
    throw error;
  }
}

async function pathCandidates(command: string): Promise<string[]> {
  const pathValue = process.env.PATH ?? "";
  const directories = pathValue.split(path.delimiter).filter(Boolean);
  if (directories.length === 0) return [];
  const extensions = process.platform === "win32" && !path.extname(command)
    ? [".exe", ".cmd", ".bat"]
    : [""];
  const candidates: string[] = [];
  for (const directory of directories) {
    for (const extension of extensions) candidates.push(path.resolve(directory, command + extension.toLowerCase()));
  }
  if (process.platform !== "win32") {
    for (const directory of directories) candidates.push(path.resolve(directory, command));
  }
  return candidates;
}

async function isFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    if (process.platform !== "win32") await access(file, (await import("node:fs")).constants.X_OK);
    return process.platform !== "win32" || WINDOWS_EXTENSIONS.includes(path.extname(file).toLowerCase());
  } catch {
    return false;
  }
}

async function wrap(executable: string): Promise<ResolvedExecutable> {
  if (/\.[cm]?js$/i.test(executable)) return { command: process.execPath, args: [await realpath(executable)] };
  if (process.platform === "win32" && [".cmd", ".bat"].includes(path.extname(executable).toLowerCase())) {
    // Read only the Node entry point from recognized npm/simple Node wrappers.
    // The batch text itself is never executed or interpolated into a command.
    const source = await readFile(executable, "utf8");
    const match = source.match(/(?:"%_prog%"|\bnode(?:\.exe)?)\s+"(%(?:~dp0|dp0%)[^"\r\n]+)"\s+%\*/i);
    if (!match) throw new Error("CODEBUDDY_RESOLUTION_FAILED");
    const relative = match[1].replace(/^%(?:~dp0|dp0%)/i, "").replace(/^[\\/]/, "");
    if (!relative || /[%\r\n\0]/.test(relative)) throw new Error("CODEBUDDY_RESOLUTION_FAILED");
    const target = path.resolve(path.dirname(executable), relative);
    const targetInfo = await stat(target).catch(() => undefined);
    if (!targetInfo?.isFile()) throw new Error("CODEBUDDY_RESOLUTION_FAILED");
    if (!/\.[cm]?js$/i.test(target)) {
      const header = (await readFile(target, "utf8")).slice(0, 256);
      if (!/^#![^\r\n]*\bnode\b/.test(header)) throw new Error("CODEBUDDY_RESOLUTION_FAILED");
    }
    return { command: process.execPath, args: [await realpath(target)] };
  }
  return { command: executable, args: [] };
}
