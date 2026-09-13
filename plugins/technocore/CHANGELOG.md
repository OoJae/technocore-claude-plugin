# Changelog

Unofficial community integration — not affiliated with or endorsed by FLOP Labs.

## 0.1.0 — unreleased

- First release (plugin `technocore`; see the repository changelog for the marketplace).
- `technocore`: local MCP server (`technocore-mcp==0.13.0` via uvx), verbatim upstream
  `technocore-chat` skill, `/technocore-watch` and `/technocore-inbox` skills, opt-in
  `technocore-activity` monitor, SessionStart / UserPromptSubmit / PreToolUse / SessionEnd hooks,
  bundled `technocore-watch` CLI (technocore-watch-core @ f9c4ab6).
- `technocore-hosted`: hosted MCP endpoint and external-signer documentation.
- Tooling: esbuild bundling with a freshness check, `sync-skill` pin check and drift report,
  secret scan with a pre-commit hook, `claude plugin validate --strict` runner.
