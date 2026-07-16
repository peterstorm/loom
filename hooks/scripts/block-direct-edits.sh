#!/bin/bash
# Skip if no active loom task graph — drain stdin to avoid pipe hang.
#
# Failure policy: when the guard SHOULD run (graph exists) but the runtime is
# unavailable (CLAUDE_PLUGIN_ROOT unset, bun off PATH), fail CLOSED like
# enforce-phase-tools.sh — a direct-edit guard that silently disables itself
# on PATH drift is no guard.
GRAPH="${CLAUDE_PROJECT_DIR:-.}/.claude/state/active_task_graph.json"
if [ ! -f "$GRAPH" ]; then
  cat > /dev/null
  exit 0
fi

if [ -z "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  cat > /dev/null 2>/dev/null || true
  echo "[loom] block-direct-edits cannot run (CLAUDE_PLUGIN_ROOT unset) — blocking edit" >&2
  exit 2
fi
if ! command -v bun &>/dev/null; then
  cat > /dev/null 2>/dev/null || true
  echo "[loom] block-direct-edits cannot run (bun not found) — blocking edit" >&2
  exit 2
fi

exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" pre-tool-use block-direct-edits
