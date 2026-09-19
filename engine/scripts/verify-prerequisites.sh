#!/usr/bin/env bash
set -euo pipefail

# Platform-specific requirements are named, not silently dropped: GNU
# `timeout` and Bash 4 are LINUX operator requirements. The macOS suite
# degrades by design — scripts/smoke-pi-resources.sh probes for `timeout`
# before using it, and scripts/smoke-panel-mode.sh reads line-by-line
# instead of `mapfile` so Apple's bash 3.2 can run the smoke suite.
for tool in bun node npm jq bash git; do
  command -v "$tool" >/dev/null || { printf 'Verification blocked: missing %s\n' "$tool" >&2; exit 1; }
done
if [[ "$(uname -s)" = "Linux" ]]; then
  command -v timeout >/dev/null || { printf 'Verification blocked: missing timeout\n' >&2; exit 1; }
  [[ "$BASH_VERSINFO" -ge 4 ]] || { printf 'Verification blocked: Bash 4+ required\n' >&2; exit 1; }
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
for executable in "$ROOT/node_modules/.bin/pi" "$ROOT/engine/node_modules/.bin/vitest"; do
  test -x "$executable" || { printf 'Verification blocked: install both frozen locks; missing %s\n' "$executable" >&2; exit 1; }
done
# npm includes ancestor .bin directories. Reject shadowing as well as global fallback.
[[ "$(command -v pi)" = "$ROOT/node_modules/.bin/pi" ]] || {
  printf 'Verification blocked: pi must resolve to the root locked installation\n' >&2
  exit 1
}
