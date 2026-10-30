# Real backend smoke — 2026-10-30

These are local, read-only model checks, separate from automated fake-CLI and
HTTP/WebSocket/MCP transport tests. Each backend received an isolated workspace
and visitor credential. No global CLI or provider authentication settings changed.

| Backend | CLI help | Plain reply | Server-observed `visitor_me` | Result |
| --- | --- | --- | --- | --- |
| CodeBuddy | Passed | Failed | Not observed | Local authentication required (`CODEBUDDY_AUTH_REQUIRED`) |
| Codex | Passed | Passed | Observed | Passed |
| OpenCode v2.1.4 | Passed | Passed | Not observed | MCP model integration not verified |

OpenCode completed its response but reported that the MCP tool was absent from its
session toolset. A second isolated check reproduced that result. A separate MCP
listing diagnostic reached the workbench's initialize and catalog endpoints but
did not expose the server to the CLI. The failed checks remain failures.

OpenCode's [MCP implementation](https://github.com/anomalyco/opencode/blob/v2.1.4/packages/core/src/mcp/index.ts)
starts initial connections asynchronously. A startup or tool-registration timing
issue is a possible explanation, not a confirmed diagnosis. The adapter retains
the documented v2 configuration and does not add delays or broaden permissions
to conceal the failure.

Run `pnpm run smoke:agents` on the intended machine before relying on a backend's
MCP tools. Until its check succeeds, use a verified backend or connect an external
MCP client explicitly. A successful process exit or fake-CLI test is not evidence
that a real model invoked its MCP tools.
