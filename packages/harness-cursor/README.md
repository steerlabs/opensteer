# Cursor MCP calls

Cursor is an installed engine, rather than a shipped binary. Its documented
[CLI MCP configuration](https://cursor.com/docs/cli/mcp) has no supported
per-server tool timeout setting. The harness writes only its supported server
URL and authorization headers; `cursor-driver.test.ts` pins that configuration.
A Cursor execution timeout cannot be pinned by this harness.

The fake-data delayed `sign_in` journey in
`apps/host/src/browser/password-sign-in-timeout.engine.test.ts` checks the
shipped Codex, Claude Code, OpenCode and Pi engines. It requires a
throwaway PostgreSQL database, configured engine accounts and runtime binaries,
and writes a JSON artifact per engine to `OPENSTEER_ENGINE_E2E_OUTPUT`.
An engine skipped because its account or binary is missing remains unqualified;
the timeout setting alone does not prove that its call completes.
