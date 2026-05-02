#!/bin/bash
# Stdout from this hook injects context into the conversation post-/clear.
set -euo pipefail
GRAPH="${CLAUDE_PROJECT_DIR:-.}/.claude/state/active_task_graph.json"
if [ ! -f "$GRAPH" ]; then
  cat > /dev/null
  exit 0
fi

if [ -z "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  echo "[loom] resume-after-clear: CLAUDE_PLUGIN_ROOT not set" >&2
  exit 1
fi

if ! command -v bun > /dev/null 2>&1; then
  echo "[loom] resume-after-clear: bun not found on PATH" >&2
  exit 1
fi

exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" session-start resume-after-clear
