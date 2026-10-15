#!/bin/bash
# Skip if no active loom task graph — drain stdin to avoid pipe hang.
# An implementation brief marker is the one exception: without a TaskGraph it
# cannot expand, and a spawn that went ahead would hand the child the bare
# one-line marker instead of its brief. Refuse it (exit 2 blocks the call).
GRAPH="${CLAUDE_PROJECT_DIR:-.}/.claude/state/active_task_graph.json"
if [ ! -f "$GRAPH" ]; then
  input=$(cat)
  if printf '%s' "$input" | grep -Eq '"prompt"[[:space:]]*:[[:space:]]*"[[:space:]]*LOOM_IMPLEMENTATION_BRIEF: T[0-9]+'; then
    echo "validate-task-execution: BLOCKED: an implementation brief marker cannot expand without an active TaskGraph at $GRAPH" >&2
    exit 2
  fi
  exit 0
fi

exec bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts pre-tool-use validate-task-execution
