#!/bin/bash
# SubagentStart shim — marks the session's subagent flag and binds the
# guarded machine for machine-gated agent types.
# Skip if no active loom task graph — drain stdin to avoid pipe hang.
#
# Failure policy: fail OPEN loudly (SubagentStart must never block agent
# spawning) — but a silent skip leaves the machine NOT bound, so the agent
# runs UNGATED and its evidence is never attributed; the runtime-unavailable
# path names that consequence on stderr.
GRAPH="${CLAUDE_PROJECT_DIR:-.}/.claude/state/active_task_graph.json"
if [ ! -f "$GRAPH" ]; then
  cat > /dev/null
  exit 0
fi

if [ -z "${CLAUDE_PLUGIN_ROOT:-}" ] || ! command -v bun &>/dev/null; then
  cat > /dev/null 2>/dev/null || true
  echo "mark-subagent-active: runtime unavailable (bun/CLAUDE_PLUGIN_ROOT) — machine NOT bound, agent runs UNGATED" >&2
  exit 0
fi

exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" subagent-start mark-subagent-active
