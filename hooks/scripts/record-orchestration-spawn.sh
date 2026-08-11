#!/usr/bin/env bash
# Claude PostToolUse spawn correlator. Request-bound calls fail visibly; legacy
# calls are a no-op inside the TypeScript boundary.
set -u
if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" ]] || ! command -v bun >/dev/null 2>&1; then
  echo "record-orchestration-spawn: runtime unavailable — request correlation failed" >&2
  exit 1
fi
exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" post-tool-use record-orchestration-spawn
