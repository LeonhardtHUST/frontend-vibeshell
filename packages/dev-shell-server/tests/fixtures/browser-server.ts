// This harness is a test-only process. No setup endpoints are mounted in the product server.
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDevShellServer, type DevShellServer } from "../../src/server.js";

const repository = path.resolve(import.meta.dirname, "../../../..");
const scratchRoot = path.join(repository, ".scratch", "dev-shell-browser");
await mkdir(scratchRoot, { recursive: true });
const runRoot = await mkdtemp(path.join(scratchRoot, "run-"));
const fixtureOrigin = "http://127.0.0.1:5275";
const shellOrigin = "http://127.0.0.1:5273";
let workbench: DevShellServer | undefined;
let report = "";
let generation = 0;

async function reset(theme: "light" | "dark") {
  await workbench?.close();
  const dataDir = path.join(runRoot, String(++generation));
  const workspace = path.join(dataDir, "workspace");
  await mkdir(workspace, { recursive: true });
  report = path.join(dataDir, "launches.ndjson");
  process.env.FAKE_CODEBUDDY_MODE = "browser";
  process.env.FAKE_CODEBUDDY_BROWSER_REPORT = report;
  workbench = createDevShellServer({
    config: { port: 5274, dataDir, workspace, defaultTarget: `${fixtureOrigin}/target/a`,
      shellAllowedOrigins: [shellOrigin, "http://127.0.0.1:5274"], targetAllowedOrigins: [fixtureOrigin] },
    settings: { defaultTarget: `${fixtureOrigin}/target/a`, allowedOrigins: [fixtureOrigin], workspace,
      codebuddyExecutable: fileURLToPath(new URL("./fake-codebuddy.js", import.meta.url)),
      model: null, permissionMode: "plan", timeoutMs: 30_000, maxConcurrent: 2, theme, longPressMs: 300 },
  });
  await workbench.listen();
}

function document(name: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Target ${name}</title><link rel="stylesheet" href="/target.css"></head><body><main><h1>Target ${name}</h1><p>Independent development page.</p><button id="primary-action" data-testid="primary-action">Choose target ${name}</button><output id="click-count">0</output><p id="target-text">Target content ${name}</p><form><label>Project name<input name="project" value="public fixture"></label></form><div style="height:900px"></div><button id="bottom-action">Bottom action</button></main><script src="/target.js"></script></body></html>`;
}

const fixture = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", fixtureOrigin);
  try {
    if (url.pathname === "/__test/health") { response.writeHead(200, {"content-type": "application/json"}); response.end(JSON.stringify({ok: !!workbench})); return; }
    if (url.pathname === "/__test/reset" && request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body || "{}");
      await reset(input.theme === "light" ? "light" : "dark");
      response.writeHead(200, {"content-type": "application/json"}); response.end(JSON.stringify({ok: true})); return;
    }
    if (url.pathname === "/__test/launches") {
      const lines = await readFile(report, "utf8").catch(() => "");
      response.writeHead(200, {"content-type": "application/json"}); response.end(JSON.stringify(lines.split("\n").filter(Boolean).map(line => JSON.parse(line)))); return;
    }
    if (url.pathname === "/target/a" || url.pathname === "/target/b") { response.writeHead(200, {"content-type": "text/html", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'"}); response.end(document(url.pathname.endsWith("b") ? "B" : "A")); return; }
    if (url.pathname === "/target.css") { response.writeHead(200, {"content-type": "text/css"}); response.end("body{margin:0;background:#f6f7fa;color:#162033;font:16px system-ui}main{padding:24px}button{font:inherit;padding:16px;border:0;border-radius:8px;background:#3456cb;color:white}output{display:block;margin:20px}label{display:grid;gap:8px;margin-top:20px}input{padding:12px}"); return; }
    if (url.pathname === "/target.js") { response.writeHead(200, {"content-type": "text/javascript"}); response.end("document.getElementById('primary-action').addEventListener('click',()=>{const output=document.getElementById('click-count');output.textContent=String(Number(output.textContent)+1)});"); return; }
    response.writeHead(404); response.end();
  } catch (error) { response.writeHead(500, {"content-type": "application/json"}); response.end(JSON.stringify({error: error instanceof Error ? error.message : "fixture failed"})); }
});
await reset("dark");
await new Promise<void>((resolve, reject) => { fixture.once("error", reject); fixture.listen(5275, "127.0.0.1", resolve); });
console.log("Dev Shell browser fixtures ready on 5274 / 5275");
let closing = false;
async function close() { if (closing) return; closing = true; await workbench?.close(); await new Promise<void>(resolve => fixture.close(() => resolve())); }
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
