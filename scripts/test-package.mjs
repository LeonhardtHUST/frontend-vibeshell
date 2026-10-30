import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";
import { runManager } from "./package-manager.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = path.join(root, ".scratch/artifacts");
await mkdir(artifacts, {recursive: true});
runManager("pnpm", ["pack", "--pack-destination", artifacts], root);
const tarball = path.join(artifacts, "hustradio-dev-shell-0.1.0.tgz");
const consumer = await mkdtemp(path.join(realpathSync.native(tmpdir()), "dev-shell-consumer-"));
await writeFile(path.join(consumer, "package.json"), JSON.stringify({name: "independent-consumer", private: true}));
const consumerTarball = path.join(consumer, "dev-shell.tgz");
await copyFile(tarball, consumerTarball);
runManager("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", path.join(consumer, ".npm-cache"), consumerTarball], consumer);
const installed = path.join(consumer, "node_modules/@hustradio/dev-shell");
const cli = path.join(installed, "dist/server/cli.js");
const manifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
assert.equal(manifest.bin["dev-shell"], "dist/server/cli.js");
assert.ok(!JSON.stringify(manifest.dependencies).includes("workspace:"));
assert.ok(!(await readdir(installed)).includes("packages"));
assert.match(await readFile(cli, "utf8"), /^#!\/usr\/bin\/env node/);
await readFile(path.join(consumer, "node_modules/.bin", process.platform === "win32" ? "dev-shell.cmd" : "dev-shell"));
for (const flag of ["--help", "--version"]) {
  const result = spawnSync(process.execPath, [cli, flag], {cwd: consumer, encoding: "utf8"});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, flag === "--help" ? /Usage: dev-shell/ : /0\.1\.0/);
}
const workspaceA = path.join(consumer, "project A");
const workspaceB = path.join(consumer, "project B");
await mkdir(workspaceA); await mkdir(workspaceB);
const bin = path.join(consumer, "bin"); await mkdir(bin);
for (const name of ["fake-codebuddy.js", "fake-codebuddy.cmd"]) await copyFile(path.join(root, "packages/dev-shell-server/tests/fixtures", name), path.join(bin, name));
await chmod(path.join(bin, "fake-codebuddy.js"), 0o700);
const target = createServer((_req, res) => {res.setHeader("content-type", "text/html"); res.end('<!doctype html><html><head><title>Independent project</title></head><body><button id="target">Standalone target</button></body></html>');});
await new Promise(resolve => target.listen(0, "127.0.0.1", resolve));
const targetUrl = `http://127.0.0.1:${target.address().port}`;
const portProbe = createServer(); await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = {...process.env, FAKE_CODEBUDDY_MODE: "browser"};
for (const key of Object.keys(env)) if (key.startsWith("DEV_SHELL_")) delete env[key];
let child;
let output = "";
let browser;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {const value = await check(); if (value) return value; await sleep(100);}
  throw new Error(`Timed out waiting for installed workbench. ${output.slice(-3000)}`);
}
async function start(project, data) {
  output = "";
  child = fork(cli, ["--port", String(port), "--target", targetUrl, "--data-dir", path.join(consumer, data)], {cwd: project, env, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"]});
  child.stdout.on("data", value => {output = (output + value).slice(-10000);}); child.stderr.on("data", value => {output = (output + value).slice(-10000);});
  return waitFor(async () => {
    if (child.exitCode !== null) throw new Error(output);
    try {return await fetch(`${origin}/api/health`).then(response => response.ok ? response.json() : null);} catch {return null;}
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const previous = child;
  const exit = new Promise(resolve => previous.once("exit", resolve));
  previous.send("dev-shell:shutdown");
  let timer;
  const result = await Promise.race([exit, new Promise(resolve => {timer = setTimeout(() => resolve("timeout"), 20_000);})]);
  clearTimeout(timer);
  if (result === "timeout") {previous.kill(); throw new Error("Installed CLI did not shut down gracefully");}
  assert.equal(result, 0, output);
}
try {
  const healthA = await start(workspaceA, "data-A");
  browser = await chromium.launch(); const context = await browser.newContext(); const page = await context.newPage();
  const badRequests = [];
  page.on("response", response => {if (response.status() >= 400) badRequests.push(response.url());});
  await page.goto(origin);
  await page.getByLabel("你的显示名称").fill("Project A"); await page.getByRole("button", {name: "初始化工作台"}).click();
  await page.locator(".workspace").waitFor();
  const tokenA = await page.evaluate(key => localStorage.getItem(key), `dev-shell:owner-token:v2:${healthA.workbenchId}`);
  assert.ok(tokenA);
  async function api(route, body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(`${origin}/api${route}`, {method, headers: {authorization: `Bearer ${tokenA}`, "x-dev-shell-web": "1", "content-type": "application/json"}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    const value = response.status === 204 ? null : await response.json();
    assert.ok(response.ok, JSON.stringify(value)); return value;
  }
  const snapshot = (await api("/bootstrap")).snapshot;
  assert.equal(snapshot.settings.workspace, workspaceA);
  await page.frameLocator("iframe").getByRole("button", {name: "Standalone target"}).waitFor();
  await page.frameLocator("iframe").getByRole("button", {name: "Standalone target"}).click({modifiers: ["Control"]});
  await page.locator(".selection-chip").waitFor();
  const html = await fetch(origin).then(response => response.text());
  const cssPath = html.match(/href="([^\"]+\.css)"/)[1];
  const css = await fetch(new URL(cssPath, origin)).then(response => response.text());
  const fonts = [...new Set([...css.matchAll(/url\(([^)]+\.woff2)\)/g)].map(match => match[1].replaceAll(/["']/g, "")))];
  assert.equal(fonts.length, 16);
  for (const font of fonts) assert.equal((await fetch(new URL(font, new URL(cssPath, origin)))).status, 200);
  for (const name of ["LICENSE", "OFL-1.1.txt", "THIRD_PARTY_NOTICES.en.md"]) await readFile(path.join(installed, "dist/licenses/unitary-ui", name));
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace("http", "ws")}/api/events`);
    const timer = setTimeout(() => {socket.terminate(); reject(new Error("WS hello timeout"));}, 10_000);
    socket.once("error", reject);
    socket.on("open", () => socket.send(JSON.stringify({type: "hello", protocolVersion: 2, token: tokenA})));
    socket.on("message", data => {if (JSON.parse(String(data)).type === "hello.ok") {clearTimeout(timer); socket.close(); resolve();}});
  });
  const visitor = await api("/visitors", {kind: "agent", displayName: "Installed MCP client"});
  const mcp = new Client({name: "installed-package-test", version: "1.0.0"});
  try {
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {requestInit: {headers: {authorization: `Bearer ${visitor.token}`}}}));
    assert.ok((await mcp.listTools()).tools.some(tool => tool.name === "visitor_me"));
    assert.ok(!(await mcp.callTool({name: "visitor_me", arguments: {}})).isError);
  } finally {await mcp.close();}
  await api("/settings", {codebuddyExecutable: path.join(bin, "fake-codebuddy.js")}, "PATCH");
  const item = await api("/queue", {body: "Installed package queue", clientMessageId: "pack-queue"});
  const session = await api("/queue/dispatch", {queueItemIds: [item.id], clientMessageId: "pack-dispatch"});
  await waitFor(async () => {const current = (await api("/sessions")).items.find(value => value.id === session.id); assert.ok(current); assert.notEqual(current.status, "failed", JSON.stringify(current)); return current.status === "succeeded";});
  const duplicate = fork(cli, ["--data-dir", path.join(consumer, "data-A"), "--port", "0"], {cwd: workspaceA, env, execArgv: [], silent: true});
  let duplicateError = ""; duplicate.stderr.on("data", value => {duplicateError += value;});
  const duplicateCode = await new Promise(resolve => duplicate.once("exit", resolve));
  assert.equal(duplicateCode, 1); assert.match(duplicateError, /WORKBENCH_ALREADY_RUNNING/);
  await page.screenshot({path: path.join(root, ".scratch/installed-package.png"), fullPage: true});
  assert.deepEqual(badRequests, []);
  await stop();
  const healthB = await start(workspaceB, "data-B"); assert.notEqual(healthB.workbenchId, healthA.workbenchId);
  await page.goto(origin); await page.getByLabel("你的显示名称").fill("Project B"); await page.getByRole("button", {name: "初始化工作台"}).click(); await page.locator(".workspace").waitFor();
  await stop();
  assert.equal((await start(workspaceA, "data-A")).workbenchId, healthA.workbenchId);
  await page.goto(origin); await page.locator(".workspace").waitFor();
  assert.equal(await page.evaluate(key => localStorage.getItem(key), `dev-shell:owner-token:v2:${healthA.workbenchId}`), tokenA);
  await stop();
  const summary = {ok: true, version: manifest.version, fonts: fonts.length, rest: true, websocket: true, mcp: true, picker: true, cliSession: true, duplicateLock: true, projectSwitch: "A-B-A", independentInstall: true};
  await writeFile(path.join(root, ".scratch/package-acceptance.json"), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary));
} finally {await browser?.close(); await stop(); await new Promise(resolve => target.close(resolve));}
