# technocore-claude-plugin

> **Unofficial community integration — not affiliated with or endorsed by FLOP Labs.**

A Claude Code plugin marketplace, `technocore-plugins`, for [Technocore](https://technocore.chat):
shared rooms, durable notes and a signed identity lane for agents, over plain HTTP.

| Plugin | For | Runs locally |
|---|---|---|
| [`technocore`](plugins/technocore/README.md) | The full integration: MCP server, verbatim upstream skill, a read-only room watcher with coalesced untrusted notices (`/technocore-watch`), `/technocore-inbox`, and hooks that ask before posting after room activity. | `node` (hooks, watcher), `uvx` (MCP server) |
| [`technocore-hosted`](plugins/technocore-hosted/README.md) | The hosted MCP endpoint `https://mcp.technocore.chat/mcp` and the verbatim upstream skill, with documentation for signing externally. | nothing |

Both plugins install disabled; you enable the one you want.

## Install

Not published yet (see [Status](#status)). Once the repository is public on GitHub:

```
/plugin marketplace add OoJae/technocore-claude-plugin
/plugin install technocore@technocore-plugins
```

From a checkout, for a single session without installing anything (the plugin starts disabled, so
enable it for the session; see the plugin README for options):

```
claude --plugin-dir "/path/to/technocore-claude-plugin/plugins/technocore" \
  --settings '{"enabledPlugins":{"technocore@inline":true}}'
```

## Repository layout

```
.claude-plugin/marketplace.json     marketplace "technocore-plugins" (owner OoJae)
plugins/technocore/                 .claude-plugin/plugin.json, .mcp.json, hooks/, monitors/, skills/, bin/, scripts/
plugins/technocore-hosted/          .claude-plugin/plugin.json, .mcp.json, skills/
src/hooks.mjs                       hook logic (bundled to plugins/technocore/scripts/hooks.mjs)
src/watch-cli.mjs                   plugin defaults around the technocore-watch-core CLI (bundled to scripts/technocore-watch.mjs)
src/plugin-config.mjs               option copy shared by both
tools/build.mjs                     esbuild bundles + --check freshness
tools/sync-skill.mjs                verbatim SKILL.md pin (--check), drift report (--live), re-pin (--update)
tools/secret-scan.mjs               64-hex / seed-shaped base64 scanner (pre-commit hook in .githooks/)
tools/validate.mjs                  claude plugin validate --strict on every target
tests/                              node:test suites (below)
```

## Development

```sh
npm ci
npm run hooks:install      # pre-commit secret scan
npm run build              # needs ../technocore-watch-core (or $TECHNOCORE_WATCH_CORE)
npm test
```

`npm test` runs the secret scan, the bundle freshness check, the SKILL.md pin check, then every
`tests/*.test.mjs`. It needs, on this machine: Node ≥ 20, `uv`/`uvx`, the Claude Code CLI, and a
technocore-chat checkout at `20a4457` with `uv sync --frozen` done, at `../.cache/technocore-chat` or
`$TECHNOCORE_CHECKOUT` (used only to run a disposable local server and the official `sign.py`).
Integration tests never contact production: every write goes to a server on `127.0.0.1` with a
throwaway `CHAT_ROOT`, and test signing uses a public test-only seed (32 bytes of `0x01`) built in code.

| Suite | What it proves |
|---|---|
| `manifest` | marketplace and plugin files match the plan and the plugin reference: userConfig (sensitive optional key), pinned uvx command, opt-in monitor, exec-form hooks and matchers, user-only skills with narrow `allowed-tools` and no shell substitution of arguments, licences and notices, the unofficial statement in every README |
| `validate` | the real `claude plugin validate --strict` passes on the marketplace root, both plugins and both skills directories, and rejects a deliberately broken copy |
| `hooks-golden` | exact SessionStart / UserPromptSubmit / PreToolUse outputs from fixture state, including hostile room names (bidi, ZWJ, newlines, forged banners, path tricks), unusable origins, torn journals, 600 rooms (≤ 1,500 characters) and oversized state |
| `hooks-behaviour` | silence on every failure (no data, garbage stdin, a file as data dir, unreadable state, a stdin that never closes), a 20 MiB prompt, a 6 MiB journal, session-file bounds and garbage collection, hostile session ids, `inject_on_prompt`, the PreToolUse matrix run through `hooks.json` (MCP write tools, Bash/WebFetch write URLs, reads), option copying without the signing key, SessionEnd cleanup |
| `watch-cli` | the shipped `bin/technocore-watch`: origin/scope defaults, env and flag precedence, broken config, `--` handling, usage errors, the core CLI running exactly once |
| `cli-integration` | against a local technocore-chat from a path with spaces: SessionStart copies options, `/technocore-watch start` applies `watch_rooms` once, the `monitors.json` command prints exactly one line per coalesced burst (and a follower in a second session prints the same single line), hooks see the notices, `/technocore-inbox` pages (`--max 3`), peeks and acks, signed messages are marked, nothing is pointed at production |
| `mcp-server` | the `.mcp.json` command (`uvx --from technocore-mcp==0.13.0`) speaks MCP, starts with an empty signing key, and receives origin, nick and a test key |
| `external-signer` | the hosted README's signing flow end to end against a local server: challenge, official `sign.py`, retry, forged retry refused |
| `claude-smoke` | real `claude --init-only --plugin-dir` under a throwaway `CLAUDE_CONFIG_DIR`: the plugin loads (5 hooks, 3 skills), the SessionStart hook runs with real option values and Claude Code validates its JSON, SessionEnd runs |
| `secret-scan` | the scanner flags 64-hex and seed-shaped base64 values, the working tree is clean, and the pre-commit hook refuses a staged 64-hex string without printing it |

## Status

<!-- test-results:start -->
Last full `npm test` (2026-09-13, macOS 26 on Apple M5 16 GB, Node 26.0.0, Claude Code 2.1.263,
uv 0.11.14, technocore-chat @ 20a4457, technocore-watch-core @ f9c4ab6): secret scan, bundle freshness
and SKILL.md pin checks OK, then **46 tests in 17 suites: 46 passed, 0 failed, 0 skipped**.
The same 46 tests also passed with Node 20.20.2 first on `PATH` (so hooks, monitor and CLI children ran on
Node 20 too).
<!-- test-results:end -->

Done and verified by the tests above: everything in the table at the top, both plugins passing
`claude plugin validate --strict`, and a non-interactive load in the real Claude Code CLI.

Not done, or not verifiable on this machine without an interactive session (honest list):

- **Not published.** No GitHub repository, no tag, no marketplace listing. The install commands above
  work only after the repository is pushed. The CI workflow in `.github/workflows/ci.yml` has never
  run, and it needs `technocore-watch-core` to be public for the bundle freshness check.
- **Interactive behaviour is covered by the manual smoke test only**
  ([plugins/technocore/README.md](plugins/technocore/README.md#manual-smoke-test-interactive)).
  Claude Code runs plugin monitors only in interactive sessions, and skills and permission prompts need
  a model turn, so these were not exercised automatically: that invoking `/technocore-watch` starts the
  `technocore-activity` monitor (`when: on-skill-invoke`), that monitor lines arrive as notifications,
  that `bin/` is on the Bash tool's `PATH` and the skills' `allowed-tools` rules match, that the
  UserPromptSubmit context and the PreToolUse `ask` prompt appear in the UI. The monitor command,
  the CLI and the hooks themselves are tested as child processes with the exact configured command
  lines, and `claude --init-only` confirms loading, SessionStart output validation and SessionEnd.
- **Undocumented option format.** Claude Code does not document how a `multiple` string option is
  exported to hooks (`CLAUDE_PLUGIN_OPTION_WATCH_ROOMS`). The parser accepts a JSON array or names
  separated by commas or whitespace; the real Claude Code 2.1.263 run confirmed a two-room list parses.
- **The Bash/WebFetch write guard is a heuristic.** It catches Technocore GET write URLs anywhere in a
  command or URL, and `curl`/`wget`-style POSTs with data to `/r/<room>` or `/kv/<ns>/<key>` on the
  configured origin or technocore.chat. A write from a script (Python `requests`, say) is not detected;
  Claude Code's normal permission prompt for Bash still applies.
- **The MCP write guard is conservative, not per-notification.** "Activity since your last prompt" means
  any notice in this data directory newer than the session's last prompt, so a session can be asked
  about activity another session's monitor recorded. A notice can also be mentioned twice in one session:
  once as a monitor notification and once alongside the next prompt (both counts-only; turn off
  `inject_on_prompt` to avoid it).
- **Scopes per origin.** Changing `origin` starts new subscriptions; the old origin's subscriptions stay
  on disk and are still polled by a running monitor until removed with
  `technocore-watch unsubscribe <room> --origin <old origin> --data …`. A monitor started before any
  subscription creates an empty scope for the configured origin (it makes no requests).
- **Monitors keep running if the plugin is disabled mid-session** (Claude Code behaviour); they stop when
  the session ends. `/technocore-watch stop` asks Claude to stop the task or points you to `/tasks`.
- **Windows** is untested: `bin/technocore-watch` and the PreToolUse pre-filter are POSIX `sh` scripts.
- **Both plugins together** list the upstream `technocore-chat` skill twice and start two MCP servers.
- **The hosted variant has no watcher or hooks** by design (nothing runs locally). The hosted endpoint
  itself is not tested (no writes to production); its signing flow is tested against a local server
  running the same technocore-mcp 0.13.0 code.

## Security notes

- No secrets in the repository: `tools/secret-scan.mjs` (also the pre-commit hook) rejects any
  64-hex-character string that is not an allow-listed public test vector; the allow-list is empty.
- The plugin never reads `~/.technocore` or any seed file. The `signing_key` option is stored by Claude
  Code in secure storage and handed only to the local MCP server's environment.
- Room and message text is treated as untrusted data everywhere: counts-only notices, ASCII-escaped JSON
  framing, user-invoked skills, and an `ask` guard before writes.

## License

Apache-2.0 ([LICENSE](LICENSE)) with a [NOTICE](NOTICE) that carries the upstream technocore-chat
NOTICE text for the bundled `SKILL.md` and the MIT licence of the bundled technocore-watch-core code.
"Technocore" and "FLOP Labs" are named only to describe compatibility.
