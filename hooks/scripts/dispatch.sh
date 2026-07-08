#!/bin/bash
# SubagentStop dispatcher shim. Runs when a loom task graph is active OR any
# machine binding exists — mirroring guard-state-file.sh: the dispatcher's
# cleanup-subagent-flag must still unbind and clear the .active roster for a
# gated session whose task graph was removed mid-run, or the leaked binding
# stays fresh via session-activity TTL refresh and cross-credits later
# session evidence into a dead epoch.
#
# Failure policy: fail OPEN loudly (like record-evidence.sh) — SubagentStop
# must never brick a session, but a silent skip leaks bindings, so the
# runtime-unavailable path says so on stderr. Handler stderr is surfaced to
# the harness, not diverted into the debug log.
# Keep SUBAGENT_DIR default in sync with config.ts.

# Debug timing log is opt-in (LOOM_DEBUG=1): an always-on append to a fixed
# world-writable /tmp path grows unbounded and is a symlink hazard. Best
# effort — a failed append must never affect dispatch.
debug_log() {
  [ -n "${LOOM_DEBUG:-}" ] && echo "$1" >> "${LOOM_DEBUG_LOG:-/tmp/loom-hook-debug.log}" 2>/dev/null || true
}

START=$(date +%s%N)
debug_log "---$(date)--- START dispatch.sh PID=$$ PPID=$PPID CLAUDE_PROJECT_DIR=${CLAUDE_PROJECT_DIR:-unset}"

GRAPH="${CLAUDE_PROJECT_DIR:-.}/.claude/state/active_task_graph.json"
SUBAGENT_DIR="${LOOM_SUBAGENT_DIR:-/tmp/claude-subagents}"
if [ ! -f "$GRAPH" ] && ! ls "${SUBAGENT_DIR}"/*.machine &>/dev/null; then
  END=$(date +%s%N)
  ELAPSED=$(( (END - START) / 1000000 ))
  debug_log "  SKIPPED (no graph, no bindings) ${ELAPSED}ms"
  cat > /dev/null
  exit 0
fi

if [ -z "${CLAUDE_PLUGIN_ROOT:-}" ] || ! command -v bun &>/dev/null; then
  cat > /dev/null 2>/dev/null || true
  echo "dispatch: runtime unavailable (bun/CLAUDE_PLUGIN_ROOT) — SubagentStop cleanup skipped, bindings may leak" >&2
  debug_log "  SKIPPED (runtime unavailable)"
  exit 0
fi

cat | bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" subagent-stop dispatch
EXIT_CODE=$?
END=$(date +%s%N)
ELAPSED=$(( (END - START) / 1000000 ))
debug_log "  DONE bun ${ELAPSED}ms exit=$EXIT_CODE"
exit $EXIT_CODE
