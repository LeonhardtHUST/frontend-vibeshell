import { createDevShellServer } from "./server.js";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentSmoke } from "./agent/smoke.js";
import type { AgentBackend } from "@hustradio/dev-shell-contract";
import { HELP, parseCli } from "./cli-options.js";
import { packageRoot } from "./config.js";

async function main() {
const parsed = parseCli(process.argv.slice(2));
if (parsed.help) { console.log(HELP); return; }
if (parsed.version) { console.log(JSON.parse(await readFile(path.join(packageRoot(), "package.json"), "utf8")).version); return; }
const command = parsed.command;
if (command === "dev" || command === "start") {
  const server = createDevShellServer({config: parsed.config});
  const shutdown = async () => { await server.close(); process.exit(0); };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  // IPC is available only to a parent that explicitly forks this process.
  process.on("message", message => {if (message === "dev-shell:shutdown") void shutdown();});
  try {
    const address = await server.listen();
    console.log(`Dev Shell listening on http://${server.config.host.includes(":") ? `[${server.config.host}]` : server.config.host}:${address.port}`);
    console.log(`Workspace: ${server.config.workspace}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Unable to start Dev Shell");
    await server.close(); process.exitCode = 1;
  }
} else if (command === "smoke:codebuddy" || command === "smoke:agents") {
  const scratch = path.join(tmpdir(), "dev-shell-smoke");
  await mkdir(scratch, {recursive: true});
  const backends: AgentBackend[] = command === "smoke:codebuddy" ? ["codebuddy"] : ["codebuddy", "codex", "opencode-v2"];
  for (const backend of backends) {
  const dataDir = await mkdtemp(path.join(scratch, `dev-shell-${backend}-smoke-`));
  const server = createDevShellServer({config: {port: 0, dataDir}});
  let visitorId: string | undefined;
  try {
    const address = await server.listen();
    const owner = server.service.bootstrapOwner("Smoke operator");
    const credentials = server.service.createVisitor(owner.visitor.id, "agent", "Read-only CLI smoke");
    visitorId = credentials.visitor.id;
    const result = {backend, ...await runAgentSmoke({backend, dataDir, mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
      agentToken: credentials.token, agentVisitorId: visitorId,
      timeoutMs: 60_000,
      wasVisitorMeCalled: () => (server.mcpVisitorReads.get(credentials.visitor.id) ?? 0) > 0})};
    await writeFile(path.join(dataDir, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch {
    const result = {backend, ok: false, error: "AGENT_SMOKE_FAILED", detail: "Unable to complete the local read-only protocol check"};
    await writeFile(path.join(dataDir, "result.json"), JSON.stringify(result, null, 2));
    console.error(JSON.stringify(result));
    process.exitCode = 1;
  } finally {
    if (visitorId) {
      const owner = server.service.listVisitors().find(visitor => visitor.kind === "human");
      if (owner) server.service.revokeVisitor(owner.id, visitorId);
    }
    await server.close();
  }
  }
} else {
  throw new Error(HELP);
}
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Unable to start Dev Shell"); process.exitCode = 1; });
