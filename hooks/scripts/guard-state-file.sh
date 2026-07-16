#!/bin/bash
# Run when a loom task graph is active OR any machine binding exists — the
# handler both guards state files and stamps the call-start time that the
# evidence recorder's report-freshness ordering check consumes. A gated
# session whose task graph was removed mid-run must keep stamping, or every
# disk-artifact report would be rejected (fail closed) for the rest of the
# run. Otherwise drain stdin to avoid a pipe hang and skip the bun spawn.
#
# Failure policy: when the guard SHOULD run (graph or binding exists) but the
# runtime is unavailable (CLAUDE_PLUGIN_ROOT unset, bun off PATH), fail
# CLOSED like enforce-phase-tools.sh — a state-file guard that silently
# disables itself on PATH drift is no guard.
# Keep SUBAGENT_DIR default in sync with config.ts.
GRAPH="${CLAUDE_PROJECT_DIR:-.}/.claude/state/active_task_graph.json"
SUBAGENT_DIR="${LOOM_SUBAGENT_DIR:-/tmp/claude-subagents}"
if [ ! -f "$GRAPH" ] && ! ls "${SUBAGENT_DIR}"/*.machine &>/dev/null; then
  cat > /dev/null
  exit 0
fi

if [ -z "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  cat > /dev/null 2>/dev/null || true
  echo "[loom] guard-state-file cannot run (CLAUDE_PLUGIN_ROOT unset) — blocking Bash call" >&2
  exit 2
fi
if ! command -v bun &>/dev/null; then
  cat > /dev/null 2>/dev/null || true
  echo "[loom] guard-state-file cannot run (bun not found) — blocking Bash call" >&2
  exit 2
fi

exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" pre-tool-use guard-state-file
