#!/bin/sh
# PreToolUse pre-filter for Bash and WebFetch (technocore plugin; unofficial community integration,
# not affiliated with or endorsed by FLOP Labs). Starting node costs ~100 ms, so this only hands the
# hook input to hooks.mjs when it mentions a Technocore path shape (/r/, /kv/, /say/, /set/).
# Every other tool call exits 0 silently in a few milliseconds. Never fails the tool call.
input=$(cat) || exit 0
case "$input" in
  */r/*|*/kv/*|*/say/*|*/say-signed/*|*/set/*|*/set-signed/*) ;;
  *'\/r\/'*|*'\/kv\/'*|*'\/say'*|*'\/set'*) ;; # JSON writers that escape "/" as "\/"
  *) exit 0 ;;
esac
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 0
printf '%s' "$input" | node "$dir/hooks.mjs" pre-tool 2>/dev/null
exit 0
