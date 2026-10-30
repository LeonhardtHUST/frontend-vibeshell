import { expect, test, type Page, type TestInfo, type WebSocketRoute } from "@playwright/test";

const fixture = "http://127.0.0.1:5275";
const shell = "http://127.0.0.1:5273";
const desktop = (info: TestInfo) => (info.project.use.viewport?.width ?? 1280) >= 1024;
const target = (page: Page) => page.frameLocator("iframe[title='开发目标页面']");

async function auth(page: Page) { const health = await page.request.get(`${shell}/api/health`); const {workbenchId} = await health.json(); return {authorization: `Bearer ${await page.evaluate(key => localStorage.getItem(key), `dev-shell:owner-token:v2:${workbenchId}`)}`, "x-dev-shell-web": "1"}; }
async function snapshot(page: Page) { const response = await page.request.get(`${shell}/api/bootstrap`, {headers: await auth(page)}); expect(response.ok()).toBe(true); return (await response.json()).snapshot; }
async function controls(page: Page, info: TestInfo) {
  if (!desktop(info)) {
    const dock = page.locator('button[aria-controls="mobile-control-sheet"]');
    if (await dock.getAttribute("aria-expanded") === "false") await dock.click();
  }
  await expect(page.getByLabel("任务内容")).toBeVisible();
}
async function closeControls(page: Page, info: TestInfo) {
  if (!desktop(info) && await page.getByRole("dialog", {name: "协作控制面板"}).isVisible()) { await page.keyboard.press("Escape"); await expect(page.getByRole("dialog", {name: "协作控制面板"})).toBeHidden(); }
}

test.beforeEach(async ({page, request}, info) => {
  const response = await request.post(`${fixture}/__test/reset`, {data: {theme: info.project.use.colorScheme}});
  expect(response.ok()).toBe(true);
  await page.goto("/");
  await page.getByLabel("你的显示名称").fill(`Owner ${info.project.name}`);
  await page.getByRole("button", {name: "初始化工作台"}).click();
  await expect(page.locator(".workspace")).toBeVisible();
  await expect(target(page).getByRole("button", {name: "Choose target A"})).toBeVisible();
});

test("reconnecting feedback consumes the shared pulse without replacing its keyframes", async ({page}, info) => {
  let interrupted = false;
  const sockets = new Set<WebSocketRoute>();
  await page.routeWebSocket("**/api/events", socket => {
    if (interrupted) { socket.close({code: 1012}); return; }
    sockets.add(socket);
    socket.connectToServer();
  });
  await page.reload();
  await controls(page, info);
  await expect(page.locator(".connection--online")).toBeVisible();
  interrupted = true;
  for (const socket of sockets) socket.close({code: 1012});

  const dot = page.locator(".connection--reconnecting > .connection__dot");
  await expect(dot).toBeVisible();
  const original = await dot.evaluate(element => {
    const style = getComputedStyle(element);
    const animation = element.getAnimations()[0];
    return {
      token: style.getPropertyValue("--animate-pulse").trim(),
      name: style.animationName,
      duration: style.animationDuration,
      easing: style.animationTimingFunction,
      curve: style.getPropertyValue("--ease-in-out").trim(),
      direction: style.animationDirection,
      iterations: style.animationIterationCount,
      frames: animation?.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : [],
    };
  });
  await info.attach("reconnecting-motion", {body: JSON.stringify(original, null, 2), contentType: "application/json"});
  expect(original.token).toMatch(/^pulse 2s /);
  expect(original.name).toBe("pulse");
  expect(original.duration).toBe("2s");
  const normalizeTiming = (value: string) => value.replace(/\s/g, "").replace(/0\./g, ".");
  expect(normalizeTiming(original.easing)).toBe(normalizeTiming(original.curve));
  expect(original.direction).toBe("normal");
  expect(original.iterations).toBe("infinite");
  expect(original.frames.find(frame => frame.computedOffset === 0.5)?.opacity).toBe("0.5");

  // Runtime token writes must affect the real reconnecting indicator.
  await dot.evaluate(element => {
    const parent = element.parentElement!;
    parent.style.setProperty("--animate-pulse", "pulse 3s var(--ease-in-out) infinite");
    parent.style.setProperty("--ease-in-out", "cubic-bezier(0.3, 0, 0.7, 1)");
  });
  await expect(dot).toHaveCSS("animation-duration", "3s");
  await expect(dot).toHaveCSS("animation-timing-function", "cubic-bezier(0.3, 0, 0.7, 1)");

  await page.emulateMedia({reducedMotion: "reduce"});
  await expect(dot).toHaveCSS("animation-iteration-count", "1");
  expect(await dot.evaluate(element => parseFloat(getComputedStyle(element).animationDuration))).toBeLessThanOrEqual(0.00001);
  await expect.poll(() => dot.evaluate(element => element.getAnimations().filter(animation => animation.playState === "running").length)).toBe(0);

  await page.emulateMedia({reducedMotion: "no-preference"});
  await expect(dot).toHaveCSS("animation-duration", "3s");
  await expect(dot).toHaveCSS("animation-iteration-count", "infinite");
});

test("真实代理、主题、响应式边界和 frame 生命周期", async ({page}, info) => {
  await expect(page.locator(".workspace")).toHaveAttribute("data-desktop", String(desktop(info)));
  if (desktop(info)) await expect(page.getByRole("complementary", {name: "开发协作控制栏"})).toBeVisible();
  else { const dock = page.getByRole("button", {name: "打开控制面板", exact: true}); await expect(dock).toBeVisible(); expect(await dock.evaluate(element => Math.min(element.getBoundingClientRect().width, element.getBoundingClientRect().height))).toBe(44); }
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(info.project.use.colorScheme);
  const initialSrc = await page.locator("iframe").getAttribute("src");
  expect(new URL(initialSrc!).origin).not.toBe(shell);
  await target(page).locator("body").evaluate(element => { element.setAttribute("data-frame-only", "yes"); try { window.parent.document.body.setAttribute("data-escaped", "yes"); } catch { /* expected cross-origin denial */ } });
  expect(await page.locator("body").getAttribute("data-frame-only")).toBeNull();
  expect(await page.locator("body").getAttribute("data-escaped")).toBeNull();
  await target(page).getByRole("button", {name: "Choose target A"}).click();
  await expect(target(page).locator("#click-count")).toHaveText("1");
  await controls(page, info);
  const badge = (await page.locator(".connection__backend").boundingBox())!;
  expect(badge.width).toBeGreaterThanOrEqual(60);
  expect(badge.height).toBeGreaterThanOrEqual(20);
  const goColors = await page.getByRole("button", {name: "前往", exact: true}).evaluate(element => {const style = getComputedStyle(element); return {foreground: style.color, background: style.backgroundColor};});
  expect(goColors.foreground).not.toBe(goColors.background);
  expect((await page.getByLabel("预览地址").boundingBox())!.width).toBeGreaterThan((await page.locator(".preview").boundingBox())!.width * .6);
  await page.getByLabel("预览地址").fill(`${fixture}/target/b`);
  await page.getByLabel("预览地址").press("Enter");
  await expect(target(page).getByRole("heading", {name: "Target B", exact: true})).toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`${shell}/api/frames`, {headers: await auth(page)})).json()).items.filter((item: {status: string}) => item.status !== "closed").length).toBe(1);
  await page.getByRole("button", {name: "重新加载", exact: true}).click();
  await expect(target(page).getByRole("heading", {name: "Target B", exact: true})).toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`${shell}/api/frames`, {headers: await auth(page)})).json()).items.filter((item: {status: string}) => item.status !== "closed").length).toBe(1);
  await page.reload();
  await expect(page.locator(".workspace")).toBeVisible();
  await controls(page, info);
  await expect(page.getByRole("heading", {name: "共享队列"})).toBeVisible();
  await info.attach("workbench", {body: await page.screenshot(), contentType: "image/png"});
});

test("真实跨源 Ctrl picker、IME、换行、入队、复制与批次只创建一次 CLI", async ({page, context}, info) => {
  await closeControls(page, info);
  await target(page).getByRole("button", {name: "Choose target A"}).click({modifiers: ["Control"]});
  await controls(page, info);
  await expect(page.getByRole("button", {name: "移除选中元素", exact: true})).toBeVisible();
  await expect(target(page).locator("#click-count")).toHaveText("0");
  const composer = page.getByLabel("任务内容");
  await composer.fill("第一项");
  await composer.dispatchEvent("keydown", {key: "Enter", keyCode: 229, isComposing: true});
  expect((await snapshot(page)).queue).toHaveLength(0);
  expect((await snapshot(page)).sessions).toHaveLength(0);
  await composer.press("Shift+Enter");
  await composer.type("第二行");
  await expect(composer).toHaveValue("第一项\n第二行");
  await composer.press("Control+Enter");
  await expect(page.getByText("第一项\n第二行", {exact: true})).toBeVisible();
  await composer.fill("第二项"); await composer.press("Control+Enter");
  await expect(page.getByText("第二项", {exact: true})).toBeVisible();
  const before = await snapshot(page);
  expect(before.queue).toHaveLength(2);
  expect(before.queue[0].selection ?? before.queue[1].selection).toMatchObject({cssPath: "#primary-action", pageUrl: `${fixture}/target/a`});
  await page.getByRole("checkbox", {name: "选择", exact: true}).nth(0).check();
  await page.getByRole("checkbox", {name: "选择", exact: true}).nth(1).check();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", {name: "复制自行 steer", exact: true}).click();
  const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
  expect(copied).toContain("第一项\n第二行"); expect(copied).toContain("第二项"); expect(copied).toContain("#primary-action");
  expect((await snapshot(page)).sessions).toHaveLength(0);
  await page.getByRole("button", {name: "批量新建会话", exact: true}).click();
  await expect.poll(async () => (await snapshot(page)).sessions[0]?.status).toBe("succeeded");
  const launches = await (await page.request.get(`${fixture}/__test/launches`)).json();
  expect(launches).toHaveLength(1);
  expect(launches[0].prompt.replace(/\r\n/g, "\n")).toBe(copied);
  expect(launches[0].prompt).toContain("第一项"); expect(launches[0].prompt).toContain("第二项");
  expect((await snapshot(page)).queue.every((item: {status: string}) => item.status === "sent")).toBe(true);
  await page.getByRole("tab", {name: "会话", exact: true}).click();
  await page.getByRole("button", {name: "查看输出", exact: true}).click();
  await page.locator(".event-output details").filter({hasText: /#/}).first().locator("summary").click();
  expect((await snapshot(page)).sessions).toHaveLength(1);
  const events = await (await page.request.get(`${shell}/api/sessions/${(await snapshot(page)).sessions[0].id}/events`, {headers: await auth(page)})).json();
  expect(events.items.some((event: {data?: {kind?: string}}) => event.data?.kind === "assistant")).toBe(true);
});

test("Enter 创建独立会话、真实取消进程与设置 Modal", async ({page}, info) => {
  await controls(page, info);
  await page.getByLabel("任务内容").fill("普通会话"); await page.getByLabel("任务内容").press("Enter");
  await expect.poll(async () => (await snapshot(page)).sessions[0]?.status).toBe("succeeded");
  await page.getByLabel("任务内容").fill("[[hang]] 等待取消"); await page.getByLabel("任务内容").press("Enter");
  await expect.poll(async () => (await snapshot(page)).sessions.find((item: {status: string}) => item.status === "running")?.status).toBe("running");
  await page.getByRole("tab", {name: "会话", exact: true}).click();
  await page.getByRole("button", {name: "取消", exact: true}).click();
  await expect.poll(async () => (await snapshot(page)).sessions.some((item: {status: string}) => item.status === "cancelled")).toBe(true);
  const current = await snapshot(page); expect(new Set(current.sessions.map((item: {cliSessionId: string}) => item.cliSessionId)).size).toBe(2);
  await page.getByRole("button", {name: "设置", exact: true}).click();
  const modal = page.getByRole("dialog", {name: "开发环境设置"});
  await expect(modal).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  expect(await modal.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await modal.getByLabel("全局并发", {exact: true}).fill("1");
  await modal.getByLabel("Agent 后端", {exact: true}).selectOption("codex");
  await modal.getByRole("button", {name: "保存设置", exact: true}).click();
  await expect(modal).toBeHidden();
  await expect(page.getByRole("button", {name: "设置", exact: true})).toBeFocused();
  expect((await snapshot(page)).settings.maxConcurrent).toBe(1);
  expect((await snapshot(page)).settings.backend).toBe("codex");
  await controls(page, info);
  await page.getByRole("button", {name: "设置", exact: true}).click();
  await expect(modal.getByLabel("Agent 后端", {exact: true})).toHaveValue("codex");
  await modal.getByLabel("Agent 后端", {exact: true}).selectOption("opencode-v2");
  await modal.getByRole("button", {name: "保存设置", exact: true}).click();
  await expect(modal).toBeHidden();
  expect((await snapshot(page)).settings.backend).toBe("opencode-v2");
  await controls(page, info);
  await page.getByRole("button", {name: "设置", exact: true}).click();
  await expect(modal.getByLabel("Agent 后端", {exact: true})).toHaveValue("opencode-v2");
  await modal.getByLabel("Agent 后端", {exact: true}).selectOption("codebuddy");
  await modal.getByRole("button", {name: "保存设置", exact: true}).click();
});

test("桌面侧栏拖动或移动浮球、长按选择及取消手势", async ({page}, info) => {
  if (desktop(info)) {
    const separator = page.getByRole("separator", {name: "调整控制栏宽度"});
    const bounds = (await separator.boundingBox())!;
    await page.mouse.move(bounds.x + 2, bounds.y + 100); await page.mouse.down(); await page.mouse.move(bounds.x + 55, bounds.y + 100, {steps: 6}); await page.mouse.up();
    await expect.poll(() => page.evaluate(() => Number(localStorage.getItem("dev-shell:rail-width")))).toBeGreaterThan(380);
    await expect(page.getByLabel("任务内容")).toBeVisible();
    return;
  }
  const dock = page.getByRole("button", {name: "打开控制面板", exact: true});
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperties(viewport, {height: {configurable: true, value: 360}, offsetTop: {configurable: true, value: 100}});
    viewport.dispatchEvent(new Event("resize"));
  });
  await expect.poll(async () => {const bounds = (await dock.boundingBox())!; return bounds.y + bounds.height;}).toBeLessThanOrEqual(448);
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Reflect.deleteProperty(viewport, "height"); Reflect.deleteProperty(viewport, "offsetTop");
    viewport.dispatchEvent(new Event("resize"));
  });
  const box = (await dock.boundingBox())!;
  await page.mouse.move(box.x + 22, box.y + 22); await page.mouse.down(); await page.mouse.move(35, 240, {steps: 8}); await page.mouse.up();
  await expect(page.getByRole("dialog", {name: "协作控制面板"})).toBeHidden();
  expect((await dock.boundingBox())!.x).toBeLessThan(box.x);
  await dock.click(); await expect(page.getByRole("dialog", {name: "协作控制面板"})).toBeVisible();
  await closeControls(page, info);
  const button = target(page).getByRole("button", {name: "Choose target A"});
  await button.dispatchEvent("pointerdown", {pointerId: 71, pointerType: "touch", button: 0, clientX: 60, clientY: 140});
  await button.dispatchEvent("pointermove", {pointerId: 71, pointerType: "touch", button: 0, clientX: 90, clientY: 180});
  await button.dispatchEvent("pointerup", {pointerId: 71, pointerType: "touch", button: 0, clientX: 90, clientY: 180});
  await expect(page.getByRole("dialog", {name: "协作控制面板"})).toBeHidden();
  await button.evaluate(element => { const box = element.getBoundingClientRect(); element.dispatchEvent(new PointerEvent("pointerdown", {bubbles: true, pointerId: 72, pointerType: "touch", button: 0, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2})); });
  await expect(page.getByRole("dialog", {name: "协作控制面板"})).toBeVisible();
  await button.dispatchEvent("pointerup", {pointerId: 72, pointerType: "touch", button: 0});
  await expect(page.getByRole("button", {name: "移除选中元素", exact: true})).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", {name: "协作控制面板"})).toBeHidden();
});

test("两个真实 browser contexts 共享队列、消息、待办、租约与重连", async ({page, browser}, info) => {
  await controls(page, info);
  const credentials = await (await page.request.post(`${shell}/api/visitors`, {headers: await auth(page), data: {kind: "human", displayName: "Second human"}})).json();
  const context = await browser.newContext({viewport: {width: 1280, height: 800}, colorScheme: info.project.use.colorScheme});
  try {
    await context.addInitScript(({key, token}) => localStorage.setItem(key, token), {key: "dev-shell:owner-token:v1", token: credentials.token});
    const second = await context.newPage(); await second.goto(shell);
    await expect(second.locator(".workspace")).toBeVisible();
    await page.getByLabel("任务内容").fill("共享并发读取"); await page.getByLabel("任务内容").press("Control+Enter");
    await expect(second.getByText("共享并发读取", {exact: true})).toBeVisible();
    await second.getByRole("button", {name: "标为已读", exact: true}).click();
    await expect(page.getByText("共享并发读取", {exact: true})).toBeVisible();
    for (const current of [page, second]) await current.getByRole("tab", {name: "消息", exact: true}).click();
    await page.getByLabel("消息内容").fill("公开广播"); await page.getByRole("button", {name: "发送", exact: true}).click();
    await expect(second.getByText("公开广播", {exact: true})).toBeVisible();
    await page.getByLabel("消息类型").selectOption("direct"); await page.getByLabel("接收者").selectOption(credentials.visitor.id);
    await page.getByLabel("消息内容").fill("只给第二人"); await page.getByRole("button", {name: "发送", exact: true}).click();
    await expect(second.getByText("只给第二人", {exact: true})).toBeVisible();
    const outsider = await (await page.request.post(`${shell}/api/visitors`, {headers: await auth(page), data: {kind: "agent", displayName: "Unrelated agent"}})).json();
    const privateView = await (await page.request.get(`${shell}/api/messages`, {headers: {authorization: `Bearer ${outsider.token}`}})).json();
    expect(privateView.items.some((item: {body: string}) => item.body === "只给第二人")).toBe(false);
    for (const current of [page, second]) await current.getByRole("tab", {name: "待办", exact: true}).click();
    await page.getByLabel("新列表名称").fill("发布"); await page.getByRole("button", {name: "创建列表", exact: true}).click();
    await expect(second.getByRole("tab", {name: "发布", exact: true})).toBeVisible();
    await page.getByLabel("新待办内容").fill("检查代理"); await page.getByRole("button", {name: "添加待办", exact: true}).click();
    await expect(second.getByText("检查代理", {exact: true})).toBeVisible();
    await page.getByRole("checkbox", {name: "完成 检查代理", exact: true}).click();
    await expect(page.getByRole("checkbox", {name: "完成 检查代理", exact: true})).toBeChecked();
    await expect(second.getByRole("checkbox", {name: "完成 检查代理", exact: true})).toBeChecked();
    for (const current of [page, second]) await current.getByRole("tab", {name: "资源", exact: true}).click();
    await page.getByLabel("资源路径").fill("src/preview.tsx"); await page.getByLabel("用途", {exact: true}).fill("修改预览"); await page.getByRole("button", {name: "获取租约", exact: true}).click();
    await expect(second.getByText("src/preview.tsx", {exact: true})).toBeVisible();
    await second.getByLabel("资源路径").fill("src/preview.tsx"); await second.getByLabel("用途", {exact: true}).fill("稍后修改"); await second.getByRole("checkbox", {name: "冲突时等待", exact: true}).check(); await second.getByRole("button", {name: "获取租约", exact: true}).click();
    await expect(page.getByText("稍后修改", {exact: true})).toBeVisible();
    await page.getByRole("button", {name: "释放", exact: true}).click();
    await expect(second.getByText("修改预览", {exact: true})).toBeHidden();
    await context.setOffline(true);
    await page.getByRole("tab", {name: "队列", exact: true}).click();
    await page.getByLabel("任务内容").fill("离线期间任务"); await page.getByLabel("任务内容").press("Control+Enter");
    await context.setOffline(false);
    await second.getByRole("tab", {name: "队列", exact: true}).click();
    await expect(second.getByText("离线期间任务", {exact: true})).toBeVisible();
  } finally { await context.close(); }
});
