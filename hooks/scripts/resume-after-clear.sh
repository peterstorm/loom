#!/bin/bash
# Inject loom execution context after /clear — stdout goes into fresh conversation
GRAPH="${CLAUDE_PROJECT_DIR:-.}/.claude/state/active_task_graph.json"
if [ ! -f "$GRAPH" ]; then
  cat > /dev/null
  exit 0
fi

exec bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts session-start resume-after-clear
