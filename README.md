# Frontend VibeShell

A reusable, local development workbench for **CodeBuddy, Codex and OpenCode v2**.
Preview your application, select page elements, queue tasks, and coordinate humans
and agents through authenticated REST, WebSocket and MCP interfaces.

## 安装与使用

需要 Node.js **22.13+**（建议 Node 24），以及至少一个已安装、已登录的后端 CLI。
项目仍由自己的开发服务器运行；Frontend VibeShell 接收其 URL，不接管项目构建。

安装 npm 包并运行：

```sh
npm install --save-dev @leonhardthust/frontend-vibeshell
npx frontend-vibeshell --workspace . --target http://127.0.0.1:5173 --backend codex
```

打开终端打印的本机地址，默认为 `http://127.0.0.1:5274`。首次输入显示名称初始化工作台。
浏览器保存当前工作台的 token；不同项目的凭据互不覆盖。换浏览器时使用已有 token 登录，
或由已登录的人类访问者签发新的凭据。不要分享浏览器存储或数据目录。

```text
frontend-vibeshell [start|dev] [options]
frontend-vibeshell smoke:agents

--workspace <path>   工作目录，默认当前目录；运行期间固定
--target <url>       预览 URL，并登记它的精确 origin
--backend <name>     codebuddy | codex | opencode-v2
--port <number>      本机监听端口，默认 5274
--data-dir <path>    指定新数据目录或复用旧工作台
--help              查看帮助
--version           查看版本
```

`dev-shell` 命令继续作为兼容别名。现有 `DEV_SHELL_*` 环境变量、MCP 的 `dev-shell` 标识、
浏览器凭据键和数据目录均保持兼容。

新工作台默认 CodeBuddy 后端，未提供目标时显示内置示例页，可在设置中更改目标。
显式参数优先于对应环境变量、已保存设置和默认值。显式更换后端会清除旧模型选择；
未提供的选项继续使用保存值。工作目录与数据绑定，不能在界面中切换到另一个项目。

## 数据与旧工作台

默认数据按规范化工作目录的 SHA256 隔离：

| 系统 | 位置 |
| --- | --- |
| Windows | `%LOCALAPPDATA%/dev-shell/workspaces/<hash>/` |
| macOS | `~/Library/Application Support/dev-shell/workspaces/<hash>/` |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/dev-shell/workspaces/<hash>/` |

SQLite、工作台身份文件和短期 MCP 配置属于本机私有数据。同一数据库只允许一个服务进程。
异常终止后锁在最多约 10 秒未更新后可恢复；正常关闭先回收 Agent、代理和连接再释放锁。

旧 Unitary UI 工作台保留 SQLite v3、协议 v2 与已有身份，不自动搬移或重建数据。
先停止旧服务，在原项目目录启动：

```sh
dev-shell --workspace . --data-dir .workbuddy/dev-shell --target http://127.0.0.1:5173
```

如果旧数据库记录的是其他工作目录，启动会报 `WORKSPACE_MISMATCH`；使用数据库原来绑定的
`--workspace`，或为新项目选择其他数据目录。端口/origin 改变时需用已有 token 重新登录。
备份前停止服务，并保留 SQLite、WAL、SHM 和身份文件。

兼容环境变量：`DEV_SHELL_WORKSPACE`、`DEV_SHELL_TARGET`、`DEV_SHELL_BACKEND`、
`DEV_SHELL_PORT`、`DEV_SHELL_DATA_DIR`、`DEV_SHELL_DATABASE`、`DEV_SHELL_HOST`。
监听地址仅允许 loopback；端口占用会退出。

## Agent 与 MCP

默认 executable 分别为 `codebuddy`、`codex`、`opencode`，可在设置中指定绝对路径。
OpenCode 必须为 v2。模型留空使用后端默认配置；每次发送开启新会话，不隐式 resume。
会话保留实际后端、原生会话 ID、脱敏输出和失败原因，并支持取消、超时和进程树回收。

| 权限模式 | CodeBuddy | Codex | OpenCode v2 |
| --- | --- | --- | --- |
| default | CLI default | read-only，拒绝提权 | 允许读取，拒绝编辑及交互权限请求 |
| plan | CLI plan | read-only，拒绝提权 | plan agent，只读 |
| acceptEdits | CLI acceptEdits | workspace-write，拒绝提权 | 允许工作区编辑，拒绝外部目录与 shell 权限请求 |

工具不提供权限绕过，也不修改后端全局认证配置。模型认证、网络和额度由各 CLI 管理。

在“会话”页创建 Agent 访问者，保存一次展示的 token。MCP endpoint 为
`http://127.0.0.1:5274/mcp`，使用 `Authorization: Bearer <token>`；不同 Agent 使用独立身份。
Agent 可以通过 MCP 参与队列、消息、待办和 advisory 资源租约，不能签发凭据或启动其他 CLI。
读取、复制、标为已读不会消费队列；私信正文只对发件人和收件人可见。

## 页面交互

- 宽度至少 1024px 使用侧栏；Ctrl 点击网页元素添加上下文。
- 窄屏使用浮球和 BottomSheet，支持拖动、显式 picker 与长按选择；设置使用 Modal。
- Enter 创建会话，Ctrl+Enter 加入队列，Shift+Enter 换行；兼容中文输入法。
- 批量发送将队列项组合成一个 prompt，仅启动一个会话；复制使用同一份 bundle。
- 支持双主题、多访问者、共享待办、广播、私信及 advisory 资源租约。

目标通过独立 origin 的 iframe 代理运行，每个 frame 使用独立 CookieJar。浏览器的
Cookie/Authorization 不转发给目标，原站登录状态不导入。依赖 `document.cookie`、
Service Worker、COOP/COEP、frame-busting 或跨源嵌套 iframe 的页面可能降级，可打开原页。
picker 提供 DOM 信息；源码位置仅在目标实际提供开发元数据时返回。

## 开发与验证

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run test:e2e
pnpm run test:package
```

开发本工具使用 `pnpm dev`（网页 5273，服务端 5274）。生产启动使用
`pnpm start --workspace <project> --target <url>`；普通消费者只需安装包和 Node，无需 Vite/TSX。

三个 workspace 都是内部模块；根包是唯一分发单元。前端只消费已发布的
`@hustradio/unitary-ui@0.1.0-beta.1`，无需 Unitary UI checkout。
安装包验收在独立临时项目中检查 REST、WS、MCP、真实代理/picker、16 个字体、CLI 会话、
单实例保护和浏览器 A→B→A 项目切换。CI 在 Windows/Linux 执行检查并保存产物。

真实只读模型检查需显式运行，会使用本机认证和少量额度：

```sh
pnpm run smoke:agents
```

该命令使用操作系统临时目录，每个后端独立调用 `visitor_me` 并验证回复标记。
任一后端认证/协议检查失败均返回非零，不用 fake 测试替代真实连接结论。
当前实测中 Codex 通过；CodeBuddy 需要本机认证，OpenCode v2.1.4 的 MCP 工具调用尚未通过。
详见[真实模型检查记录](https://github.com/LeonhardtHUST/frontend-vibeshell/blob/main/docs/real-smoke-2026-10-30.md)。

## 来源与参考

本项目从 [Unitary UI](https://github.com/HUSTRadio/unitary-ui) 的 Dev Shell 提取，来源提交见
[SOURCE.md](SOURCE.md)。MIT 许可及字体说明随安装包提供。

[React Grab](https://github.com/aidenybai/react-grab)、[Vibe Kanban](https://github.com/BloopAI/vibe-kanban)、
[OpenChamber](https://github.com/openchamber/openchamber)、[Agentation](https://github.com/benjitaylor/agentation)
用于方案比较；本次未复制这些项目的代码或引入其运行依赖。
