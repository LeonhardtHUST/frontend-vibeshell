import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { runInNewContext } from "node:vm";
import { request as httpRequest } from "node:http";
import type { FrameInfo } from "@hustradio/dev-shell-contract";
import { FrameManager, ProxyError } from "../../src/proxy/index.js";
import { startTargetFixture, type TargetFixture } from "../fixtures/target-fixture.js";
import { createTargetLookup, isAllowedTargetIp } from "../../src/proxy/target-policy.js";

async function bootstrap(frame: FrameInfo): Promise<string> {
  const response = await fetch(frame.bootstrapUrl, { redirect: "manual" });
  expect(response.status).toBe(302);
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("SameSite=Strict");
  expect(setCookie).toContain("Path=/");
  return setCookie?.split(";", 1)[0] ?? "";
}

function proxyUrl(frame: FrameInfo, path: string): string {
  return `${frame.proxyOrigin}${path}`;
}

describe("FrameManager proxy", () => {
  let primary: TargetFixture;
  let secondary: TargetFixture;
  let manager: FrameManager;
  let allowed: Set<string>;

  beforeEach(async () => {
    secondary = await startTargetFixture();
    primary = await startTargetFixture(() => secondary.origin);
    allowed = new Set([primary.origin]);
    manager = new FrameManager({ allowOrigin: (origin) => allowed.has(origin), parentOrigin: "http://127.0.0.1:5273" });
  });

  afterEach(async () => {
    await manager.closeAll();
    await Promise.all([primary.close(), secondary.close()]);
  });

  it("validates target URLs and explicit origins", async () => {
    await expect(manager.createFrame("file:///tmp/page")).rejects.toMatchObject({ statusCode: 403 });
    await expect(manager.createFrame("http://user:pass@127.0.0.1/")).rejects.toMatchObject({ statusCode: 403 });
    await expect(manager.createFrame(secondary.origin)).rejects.toMatchObject({ code: "TARGET_ORIGIN_FORBIDDEN" });
    await expect(manager.createFrame("not a URL")).rejects.toMatchObject({ statusCode: 400 });
    await expect(manager.createFrame("http://[::ffff:169.254.169.254]/")).rejects.toMatchObject({ code: "TARGET_ORIGIN_FORBIDDEN" });
    expect(isAllowedTargetIp("::ffff:a9fe:a9fe")).toBe(false);
  });

  it("does not connect when DNS no longer resolves to a frame's approved addresses", async () => {
    const lookup = createTargetLookup(["192.0.2.55"]);
    await expect(new Promise((resolve, reject) => {
      lookup("localhost", {}, (error, address) => error ? reject(error) : resolve(address));
    })).rejects.toMatchObject({ code: "TARGET_IP_FORBIDDEN" });
  });

  it("uses one-time tickets, authenticated dynamic origins, and isolated frame cookies", async () => {
    const first = await manager.createFrame(`${primary.origin}/start?value=1`);
    const second = await manager.createFrame(primary.origin);
    expect(first.frameId).not.toBe(second.frameId);
    expect(first.proxyOrigin).not.toBe(second.proxyOrigin);
    expect(new URL(first.proxyOrigin).hostname).toBe("127.0.0.1");

    const cookie = await bootstrap(first);
    expect(cookie).toMatch(/^__dev_shell_/);
    expect((await fetch(first.bootstrapUrl, { redirect: "manual" })).status).toBe(403);
    expect((await fetch(proxyUrl(first, "/"))).status).toBe(403);
    expect((await fetch(proxyUrl(second, "/"), { headers: { cookie } })).status).toBe(403);

    const bridge = await fetch(proxyUrl(first, "/__dev_shell_bridge.js"), { headers: { cookie } });
    expect(bridge.status).toBe(200);
    expect(await bridge.text()).toContain(first.frameId);
  });

  it("proxies root-relative assets and transforms only the HTML proxy copy", async () => {
    const frame = await manager.createFrame(primary.origin);
    const cookie = await bootstrap(frame);
    const direct = await fetch(primary.origin);
    expect(direct.headers.get("x-frame-options")).toBe("DENY");
    expect(direct.headers.get("content-security-policy")).toContain("default-src");

    const response = await fetch(proxyUrl(frame, "/"), { headers: { cookie } });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(response.headers.get("content-security-policy-report-only")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(body).toContain('src="/__dev_shell_bridge.js"');
    expect(body).not.toContain('http-equiv="Content-Security-Policy"');
    expect(body).toContain('href="/assets/root.css"');

    const css = await fetch(proxyUrl(frame, "/assets/root.css"), { headers: { cookie } });
    const js = await fetch(proxyUrl(frame, "/assets/root.js"), { headers: { cookie } });
    expect(await css.text()).toContain("rgb(1, 2, 3)");
    expect(await js.text()).toContain("rootFixture");
  });

  it("keeps each upstream cookie jar separate and never forwards browser cookies", async () => {
    const first = await manager.createFrame(primary.origin);
    const second = await manager.createFrame(primary.origin);
    const firstCookie = await bootstrap(first);
    const secondCookie = await bootstrap(second);
    const sharedBrowserCookies = `${firstCookie}; ${secondCookie}; browserLogin=private`;
    for (const [frame, value] of [[first, "alpha"], [second, "beta"]] as const) {
      const response = await fetch(proxyUrl(frame, `/cookie?value=${value}`), { headers: { cookie: sharedBrowserCookies } });
      expect(response.headers.get("set-cookie")).toBeNull();
      const echo = await fetch(proxyUrl(frame, "/echo"), { headers: { cookie: sharedBrowserCookies } });
      expect((await echo.json()).cookie).toBe(`upstream=${value}`);
    }
    const scoped = await fetch(proxyUrl(first, "/private/echo"), { headers: { cookie: sharedBrowserCookies } });
    expect((await scoped.json()).cookie).toBe("scoped=private; upstream=alpha");
    await fetch(proxyUrl(first, "/cookie-clear"), { headers: { cookie: sharedBrowserCookies } });
    const cleared = await fetch(proxyUrl(first, "/echo"), { headers: { cookie: sharedBrowserCookies } });
    expect((await cleared.json()).cookie).toBeNull();
    const unchanged = await fetch(proxyUrl(second, "/echo"), { headers: { cookie: sharedBrowserCookies } });
    expect((await unchanged.json()).cookie).toBe("upstream=beta");
  });

  it("blocks foreign Host/Origin and removes bootstrap or shell referrers upstream", async () => {
    const frame = await manager.createFrame(primary.origin);
    const cookie = await bootstrap(frame);
    const foreignHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(proxyUrl(frame, "/echo"), { headers: { cookie, host: "attacker.example" } }, response => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      request.once("error", reject);
      request.end();
    });
    expect(foreignHost).toBe(403);
    const foreignOrigin = await fetch(proxyUrl(frame, "/echo"), { headers: { cookie, origin: secondary.origin } });
    expect(foreignOrigin.status).toBe(403);
    for (const referer of [frame.bootstrapUrl, "http://127.0.0.1:5273/?secret=shell"]) {
      const echo = await fetch(proxyUrl(frame, "/echo"), { headers: { cookie, referer } });
      expect((await echo.json()).referer).toBeNull();
    }
    const echo = await fetch(proxyUrl(frame, "/echo"), { headers: { cookie, referer: `${frame.proxyOrigin}/page?route=1` } });
    expect((await echo.json()).referer).toBe(`${primary.origin}/page?route=1`);
  });

  it("addresses bridge messages to the configured parent after an iframe reload", async () => {
    manager = new FrameManager({ allowOrigin: origin => allowed.has(origin), longPressMs: () => 750 });
    const frame = await manager.createFrame(primary.origin, "http://127.0.0.1:5273");
    const cookie = await bootstrap(frame);
    const response = await fetch(proxyUrl(frame, "/__dev_shell_bridge.js"), { headers: { cookie } });
    const messages: { payload: { type: string }; origin: string }[] = [];
    const listeners = new Map<string, (event: unknown) => void>();
    const delays: number[] = [];
    const element = { setAttribute() {}, appendChild() {}, contains: () => false, style: { cssText: "" } };
    const parent = { postMessage: (payload: { type: string }, origin: string) => messages.push({ payload, origin }) };
    const window = {
      parent, location: { pathname: "/", search: "", hash: "" }, history: {},
      innerWidth: 800, innerHeight: 600, addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn),
    };
    runInNewContext(await response.text(), {
      URL, window, document: {
        referrer: `${frame.proxyOrigin}/previous-page`, title: "Reloaded preview", documentElement: element,
        querySelectorAll: () => [],
        createElement: () => ({ ...element }), addEventListener: (name: string, fn: (event: unknown) => void) => listeners.set(name, fn),
      },
      setTimeout: (_fn: () => void, delay: number) => { delays.push(delay); return 1; }, clearTimeout() {},
    });
    expect(messages[0]).toMatchObject({ payload: { type: "bridge.ready" }, origin: "http://127.0.0.1:5273" });
    const before = messages.length;
    listeners.get("message")?.({ source: parent, origin: secondary.origin, data: { type: "frame.ping", frameId: frame.frameId, protocolVersion: 1 } });
    expect(messages).toHaveLength(before);
    listeners.get("message")?.({ source: parent, origin: "http://127.0.0.1:5273", data: { type: "frame.ping", frameId: frame.frameId, protocolVersion: 1 } });
    expect(messages).toHaveLength(before + 1);
    listeners.get("pointerdown")?.({ pointerType: "touch", button: 0, clientX: 20, clientY: 20, target: element });
    expect(delays).toEqual([750]);
    let prevented = false;
    const picked = {
      nodeType: 1, tagName: "BUTTON", id: "target", classList: [], getAttribute: () => null, closest: () => null,
      getBoundingClientRect: () => ({ x: 1, y: 2, width: 30, height: 40 }),
      cloneNode: () => ({ tagName: "BUTTON", textContent: "Pick me", outerHTML: "<button>Pick me</button>", attributes: [], querySelectorAll: () => [] }),
    };
    listeners.get("click")?.({ ctrlKey: true, target: picked, clientX: 5, clientY: 8, preventDefault: () => { prevented = true; }, stopImmediatePropagation() {} });
    expect(prevented).toBe(true);
    expect(messages.some(message => message.payload.type === "picker.selected")).toBe(true);
  });

  it("streams all HTTP methods and strips proxy credentials", async () => {
    const frame = await manager.createFrame(primary.origin);
    const cookie = await bootstrap(frame);
    for (const [method, body] of [["POST", "post-body"], ["PATCH", "patch-body"]] as const) {
      const response = await fetch(proxyUrl(frame, "/echo"), {
        method,
        headers: {
          cookie,
          authorization: "Bearer shell-secret",
          "proxy-authorization": "Basic proxy-secret",
          origin: frame.proxyOrigin,
          "content-type": "text/plain",
        },
        body,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        method,
        body,
        authorization: null,
        proxyAuthorization: null,
        origin: primary.origin,
      });
    }
  });

  it("decodes gzip, deflate, and Brotli HTML before injection", async () => {
    const frame = await manager.createFrame(primary.origin);
    const cookie = await bootstrap(frame);
    for (const encoding of ["gzip", "deflate", "br"]) {
      const response = await fetch(proxyUrl(frame, `/${encoding}`), {
        headers: { cookie, "accept-encoding": encoding },
      });
      expect(response.status, encoding).toBe(200);
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(await response.text()).toContain("/__dev_shell_bridge.js");
    }
  });

  it("rewrites same-origin redirects and rejects cross-origin or non-HTTP redirects", async () => {
    allowed.add(secondary.origin);
    const frame = await manager.createFrame(primary.origin);
    const cookie = await bootstrap(frame);
    const same = await fetch(proxyUrl(frame, "/redirect-same"), {
      headers: { cookie },
      redirect: "manual",
    });
    expect(same.status).toBe(302);
    expect(same.headers.get("location")).toBe(`${frame.proxyOrigin}/final?from=redirect`);
    const relative = await fetch(proxyUrl(frame, "/nested/redirect-relative"), { headers: { cookie }, redirect: "manual" });
    expect(relative.headers.get("location")).toBe(`${frame.proxyOrigin}/nested/final`);

    for (const path of ["/redirect-cross", "/redirect-file"]) {
      const response = await fetch(proxyUrl(frame, path), { headers: { cookie }, redirect: "manual" });
      expect(response.status, path).toBe(403);
      expect((await response.json()).error.code).toMatch(/REDIRECT|FORBIDDEN/);
    }
  });

  it("supports authenticated WebSocket echo without leaking shell credentials", async () => {
    const frame = await manager.createFrame(primary.origin);
    const cookie = await bootstrap(frame);
    await fetch(proxyUrl(frame, "/cookie"), { headers: { cookie } });
    const socket = new WebSocket(`${frame.proxyOrigin.replace("http:", "ws:")}/socket`, {
      headers: { cookie: `${cookie}; browserLogin=private`, authorization: "Bearer shell-secret", origin: frame.proxyOrigin },
    });
    let upgradeCookies: string[] | undefined;
    socket.once("upgrade", response => { upgradeCookies = response.headers["set-cookie"]; });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const message = new Promise<string>((resolve) => socket.once("message", (data) => resolve(data.toString())));
    socket.send("echo-me");
    expect(await message).toBe("echo-me");
    expect(primary.lastWebSocketHeaders?.authorization).toBeUndefined();
    expect(primary.lastWebSocketHeaders?.cookie ?? "").not.toContain("__dev_shell_");
    expect(primary.lastWebSocketHeaders?.cookie).toBe("upstream=alpha");
    expect(primary.lastWebSocketHeaders?.origin).toBe(primary.origin);
    expect(upgradeCookies).toBeUndefined();
    const echo = await fetch(proxyUrl(frame, "/echo"), { headers: { cookie } });
    expect((await echo.json()).cookie).toBe("upstream=alpha; handshake=ok");
    socket.close();

    const unauthenticated = new WebSocket(`${frame.proxyOrigin.replace("http:", "ws:")}/socket`);
    await expect(new Promise((resolve, reject) => {
      unauthenticated.once("open", resolve);
      unauthenticated.once("error", reject);
    })).rejects.toThrow();
  });

  it("keeps non-HTML streaming intact and reports oversized HTML", async () => {
    const frame = await manager.createFrame(primary.origin);
    const cookie = await bootstrap(frame);
    const stream = await fetch(proxyUrl(frame, "/stream"), { headers: { cookie } });
    expect(new Uint8Array(await stream.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3, 4, 5]));

    const large = await fetch(proxyUrl(frame, "/large"), { headers: { cookie } });
    expect(large.status).toBe(413);
    expect((await large.json()).error.code).toBe("HTML_TOO_LARGE");
  });

  it("updates bridge lifecycle and fully closes servers and sockets", async () => {
    const changes: FrameInfo[] = [];
    manager = new FrameManager({ allowOrigin: (origin) => allowed.has(origin), onChange: (frame) => changes.push(frame) });
    const frame = await manager.createFrame(primary.origin);
    const ready = manager.handleBridgeMessage({
      type: "bridge.ready",
      protocolVersion: 1,
      frameId: frame.frameId,
      url: primary.origin,
      title: "Ready fixture",
    });
    expect(ready).toMatchObject({ status: "ready", bridgeReady: true, title: "Ready fixture" });
    expect(changes.at(-1)?.status).toBe("ready");

    await manager.closeFrame(frame.frameId);
    expect(manager.getFrame(frame.frameId)).toMatchObject({ status: "closed", bridgeReady: false });
    await expect(fetch(proxyUrl(frame, "/"))).rejects.toThrow();
    await expect(manager.closeFrame(frame.frameId)).resolves.toBeUndefined();
  });

  it("propagates operational proxy errors with a safe shape", async () => {
    const frame = await manager.createFrame(primary.origin);
    const cookie = await bootstrap(frame);
    await primary.close();
    const response = await fetch(proxyUrl(frame, "/"), { headers: { cookie } });
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("UPSTREAM_ERROR");
    expect(new ProxyError(400, "TEST", "test").statusCode).toBe(400);
  });
});
