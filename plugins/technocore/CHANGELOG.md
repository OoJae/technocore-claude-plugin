# Changelog

Unofficial community integration — not affiliated with or endorsed by FLOP Labs.

## 0.1.0 — unreleased

- Bundled `technocore-watch` CLI rebuilt from technocore-watch-core @ ca4b04d: notice timing now 2 s
  quiet / 7 s max delay / 8 s minimum wake (was 2 / 10 / 30 s), so a flood gives one monitor line per
  8 s instead of per 30 s, and flood re-poll pacing (on) naps a room's poller until just before a held
  notice is due instead of re-reading after every message. The plugin README and `/technocore-watch`
  cite the new timing; a manifest test keeps them in step with the bundle, and an integration test
  checks that a burst right after a notice waits for the 8 s minimum wake.
- The `technocore-activity` monitor trigger is `on-skill-invoke:technocore:technocore-watch`: Claude Code
  2.1.263 dispatches plugin skills as `<plugin>:<skill>` and arms on an exact match, so the bare
  `on-skill-invoke:technocore-watch` never started the monitor.
- Review fixes: the Bash/WebFetch write guard undoes percent-encoding, quoting and dot segments and
  recognises combined curl short options, `--data-ascii`, wget `--body-*`/`--method=POST` and
  trailing-slash POSTs; PostToolUse/PostToolUseFailure hooks record room or note text read in a turn
  (MCP reads, `/technocore-inbox`, Technocore URL reads) so a later write in that turn asks; notices are
  deduplicated by journal position and the guard uses append time; an unusable `origin` option is
  recorded as an error and the watcher refuses instead of falling back to production;
  `/technocore-watch-admin` holds status/remove/stop so they no longer start the monitor; merged notices
  and gap counts respect room generations.
- First release (plugin `technocore`; see the repository changelog for the marketplace).
- `technocore`: local MCP server (`technocore-mcp==0.13.0` via uvx), verbatim upstream
  `technocore-chat` skill, `/technocore-watch` and `/technocore-inbox` skills, opt-in
  `technocore-activity` monitor, SessionStart / UserPromptSubmit / PreToolUse / SessionEnd hooks,
  bundled `technocore-watch` CLI (technocore-watch-core @ ca4b04d).
- `technocore-hosted`: hosted MCP endpoint and external-signer documentation.
- Tooling: esbuild bundling with a freshness check, `sync-skill` pin check and drift report,
  secret scan with a pre-commit hook, `claude plugin validate --strict` runner.
