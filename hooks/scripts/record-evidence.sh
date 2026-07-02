#!/bin/bash
# PostToolUse evidence recorder — appends ground-truth events to the
# session's evidence ledger. Fail-open by design: evidence collection must
# never brick a session; the SubagentStop resolver labels a bound-but-empty
# ledger as degraded, so recorder failure surfaces downstream.
# Keep SUBAGENT_DIR default in sync with config.ts.

SUBAGENT_DIR="${LOOM_SUBAGENT_DIR:-/tmp/claude-subagents}"

# An existing-but-unreadable SUBAGENT_DIR is NOT "no bindings" — bindings may
# exist that we cannot see. The recorder must never block (fail-open by
# design), but it must not be SILENT about dropping evidence either: the
# SubagentStop resolver will label the bound-but-empty ledger as degraded.
if [[ -e "${SUBAGENT_DIR}" && ( ! -d "${SUBAGENT_DIR}" || ! -r "${SUBAGENT_DIR}" || ! -x "${SUBAGENT_DIR}" ) ]]; then
  cat > /dev/null 2>/dev/null || true
  echo "record-evidence: cannot read ${SUBAGENT_DIR} — evidence not recorded (recorder stays fail-open)" >&2
  exit 0
fi

# Fast path: no machine binding anywhere → nothing to record, skip bun spawn
if ! ls "${SUBAGENT_DIR}"/*.machine &>/dev/null; then
  cat > /dev/null
  exit 0
fi

if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" ]] || ! command -v bun &>/dev/null; then
  cat > /dev/null 2>/dev/null || true
  echo "record-evidence: runtime unavailable — evidence not recorded" >&2
  exit 0
fi

exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" post-tool-use record-evidence
