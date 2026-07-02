#!/bin/bash
set -euo pipefail

# PreToolUse guarded-skill-machine gate — deny-by-default tool gating for
# machine-bound subagent runs. Cheap no-op when no binding file exists.

if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" ]] || ! command -v bun &>/dev/null; then
  cat > /dev/null 2>/dev/null || true
  exit 0
fi

# Skip fast when no machine binding is active for any session
SUBAGENT_DIR="${LOOM_SUBAGENT_DIR:-/tmp/claude-subagents}"
if ! ls "${SUBAGENT_DIR}"/*.machine &>/dev/null; then
  cat > /dev/null
  exit 0
fi

exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" pre-tool-use enforce-phase-tools
