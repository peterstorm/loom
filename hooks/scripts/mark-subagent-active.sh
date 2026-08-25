#!/bin/bash
# SubagentStart shim — marks the session's subagent flag and binds the
# guarded machine for machine-gated agent types.
# Skip if no active loom task graph — drain stdin to avoid pipe hang.
#
# Failure policy: fail CLOSED while a TaskGraph is active. Modern
# implementation attempts require the engine to bind exact authority before
# the child starts; runtime absence cannot safely degrade to an ungated spawn.
GRAPH="${CLAUDE_PROJECT_DIR:-.}/.claude/state/active_task_graph.json"
if [ ! -f "$GRAPH" ]; then
  cat > /dev/null
  exit 0
fi

if [ -z "${CLAUDE_PLUGIN_ROOT:-}" ] || ! command -v bun &>/dev/null; then
  cat > /dev/null 2>/dev/null || true
  echo "mark-subagent-active: runtime unavailable (bun/CLAUDE_PLUGIN_ROOT) — exact SubagentStart authority cannot be bound; refusing spawn" >&2
  exit 2
fi

exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" subagent-start mark-subagent-active
