#!/bin/bash
START=$(date +%s%N)
echo "---$(date)--- START dispatch.sh PID=$$ PPID=$PPID CLAUDE_PROJECT_DIR=${CLAUDE_PROJECT_DIR:-unset}" >> /tmp/loom-hook-debug.log

GRAPH="${CLAUDE_PROJECT_DIR:-.}/.claude/state/active_task_graph.json"
if [ ! -f "$GRAPH" ]; then
  END=$(date +%s%N)
  ELAPSED=$(( (END - START) / 1000000 ))
  echo "  SKIPPED (no graph) ${ELAPSED}ms" >> /tmp/loom-hook-debug.log
  exit 0
fi

cat | bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts subagent-stop dispatch 2>> /tmp/loom-hook-debug.log
EXIT_CODE=$?
END=$(date +%s%N)
ELAPSED=$(( (END - START) / 1000000 ))
echo "  DONE bun ${ELAPSED}ms exit=$EXIT_CODE" >> /tmp/loom-hook-debug.log
exit $EXIT_CODE
