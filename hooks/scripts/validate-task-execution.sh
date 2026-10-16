#!/bin/bash
# Skip if no active loom task graph — drain stdin to avoid pipe hang.
# An implementation brief marker is the one exception: without a TaskGraph it
# cannot expand, and a spawn that went ahead would hand the child the bare
# one-line marker instead of its brief. This shim does not judge the marker:
# any payload that mentions it goes to the engine, whose one marker parser
# decides, and an unexpandable marker blocks there.
GRAPH="${CLAUDE_PROJECT_DIR:-.}/.claude/state/active_task_graph.json"
if [ ! -f "$GRAPH" ]; then
  input=$(cat)
  case "$input" in
    *LOOM_IMPLEMENTATION_BRIEF*)
      exec bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts pre-tool-use validate-task-execution <<<"$input"
      ;;
  esac
  exit 0
fi

exec bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts pre-tool-use validate-task-execution
