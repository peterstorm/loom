#!/bin/bash
# Skip if no active loom task graph — drain stdin to avoid pipe hang
GRAPH="${CLAUDE_PROJECT_DIR:-.}/.claude/state/active_task_graph.json"
if [ ! -f "$GRAPH" ]; then
  cat > /dev/null
  exit 0
fi

exec bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts pre-tool-use validate-template-substitution
