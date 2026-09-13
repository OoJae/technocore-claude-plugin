#!/bin/sh
# Pre-filter for the Bash and WebFetch PreToolUse / PostToolUse hooks (technocore plugin; unofficial
# community integration, not affiliated with or endorsed by FLOP Labs). Starting node costs ~100 ms,
# so this hands the hook input to `hooks.mjs <command>` (pre-tool or post-tool) only when the tool
# input could concern Technocore: a Technocore path shape, the word technocore, the configured
# origin's host, a %XX or \u00XX escape (which could hide a path), or a quote next to /r or /kv.
# Every other tool call exits 0 silently in a few milliseconds. Never fails the tool call.
cmd=${1:-pre-tool}
case "$cmd" in pre-tool|post-tool) ;; *) exit 0 ;; esac
input=$(cat) || exit 0
# Look at the tool input only (Claude Code sends it after session_id, transcript_path and cwd, whose
# values could otherwise match). Shell pattern removal is quadratic in bash, so it runs only when
# the key is present (it is near the start), and inputs over 1 MiB go straight to node.
if [ "${#input}" -gt 1048576 ]; then
  tool=technocore
else
  case "$input" in
    *'"tool_input":'*) tool=${input#*\"tool_input\":} ;;
    *) tool=$input ;;
  esac
fi
host=${CLAUDE_PLUGIN_OPTION_ORIGIN#*://}
host=${host%%/*}
pass=
case "$tool" in
  */r/*|*/kv/*|*/say*|*/set*|*/rooms*|*[Tt][Ee][Cc][Hh][Nn][Oo][Cc][Oo][Rr][Ee]*) pass=1 ;;
  *'\/r\/'*|*'\/kv\/'*|*'\/say'*|*'\/set'*|*'\/rooms'*) pass=1 ;; # JSON writers that escape "/" as "\/"
  *%[0-9A-Fa-f][0-9A-Fa-f]*|*'\u00'*|*'\\u00'*) pass=1 ;;
  */r[\'\"]*|*/kv[\'\"]*|*/[\'\"]r*|*/[\'\"]kv*) pass=1 ;;
esac
if [ -z "$pass" ] && [ -n "$host" ]; then
  case "$tool" in *"$host"*) pass=1 ;; esac
fi
[ -n "$pass" ] || exit 0
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 0
printf '%s' "$input" | node "$dir/hooks.mjs" "$cmd" 2>/dev/null
exit 0
