#!/bin/bash
# Run the SessionStart stale-sweep when a loom task graph is active OR the
# subagent tracking dir has any entries — stale bindings/ledgers from a
# session whose task graph was removed must still be swept, or they linger
# until the next graph-active session. Otherwise drain stdin and skip.
# Keep SUBAGENT_DIR default in sync with config.ts.
GRAPH="${CLAUDE_PROJECT_DIR:-.}/.claude/state/active_task_graph.json"
SUBAGENT_DIR="${LOOM_SUBAGENT_DIR:-/tmp/claude-subagents}"
if [ ! -f "$GRAPH" ] && [ -z "$(ls -A "${SUBAGENT_DIR}" 2>/dev/null)" ]; then
  cat > /dev/null
  exit 0
fi

exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" session-start cleanup-stale-subagents
