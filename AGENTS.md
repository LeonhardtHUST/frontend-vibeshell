# Frontend VibeShell contributor guide

Keep web, server and contract private workspace modules; publish only the root CLI.
Use the released Unitary UI package through public imports. Never add source aliases
or require another checkout. Preserve protocol v2 and existing SQLite v3 data.

Before editing, inspect Git status and preserve unrelated work. Do not commit local
databases, tokens, machine paths, scratch output, or real CLI smoke artifacts.
Run focused tests first, then typecheck/build and installed-package acceptance for
distribution changes. UI changes require the affected browser scenarios in both
themes and all configured widths. Real model smoke is explicit and uses quota.

The CLI must lock its database before opening/recovering it, bind agent work to its
startup workspace, and close agents, sockets and frames before releasing the lock.
Use Context7 for current dependency API documentation when needed.
