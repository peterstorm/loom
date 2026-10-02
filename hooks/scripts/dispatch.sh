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
# A session run binding (`<session>.orchestration-runs.json`, published by the
# orchestration façade) means a request-bound run — a standalone review, a
# panel — may own this stop with NO task graph and NO machine binding. Skipping
# it would strand the reserved slot: capture never runs and resume re-issues the
# same batch forever.
if [ ! -f "$GRAPH" ] && ! ls "${SUBAGENT_DIR}"/*.machine &>/dev/null \
   && ! ls "${SUBAGENT_DIR}"/*.orchestration-runs.json &>/dev/null; then
  END=$(date +%s%N)
  ELAPSED=$(( (END - START) / 1000000 ))
  debug_log "  SKIPPED (no graph, no bindings, no run bindings) ${ELAPSED}ms"
  cat > /dev/null
  exit 0
fi

if [ -z "${CLAUDE_PLUGIN_ROOT:-}" ] || ! command -v bun &>/dev/null; then
  cat > /dev/null 2>/dev/null || true
  debug_log "  SKIPPED (runtime unavailable)"
  # A run binding means a reserved reviewer slot may be waiting on this stop:
  # exit 1 (non-blocking, but surfaced to the operator) so the stranded capture
  # is visible. Still never 2 — that would refuse the subagent's own stop.
  if ls "${SUBAGENT_DIR}"/*.orchestration-runs.json &>/dev/null; then
    echo "dispatch: runtime unavailable (bun/CLAUDE_PLUGIN_ROOT) — a session run binding exists, so a request-bound capture may be stranded; restore the runtime and re-run the stop" >&2
    exit 1
  fi
  echo "dispatch: runtime unavailable (bun/CLAUDE_PLUGIN_ROOT) — SubagentStop cleanup skipped, bindings may leak" >&2
  exit 0
fi

cat | bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" subagent-stop dispatch
EXIT_CODE=$?
END=$(date +%s%N)
ELAPSED=$(( (END - START) / 1000000 ))
debug_log "  DONE bun ${ELAPSED}ms exit=$EXIT_CODE"
exit $EXIT_CODE
