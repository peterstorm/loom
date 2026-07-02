#!/bin/bash
# PostToolUse evidence recorder — appends ground-truth events to the
# session's evidence ledger. Fail-open by design: evidence collection must
# never brick a session; the SubagentStop resolver labels a bound-but-empty
# ledger as degraded, so recorder failure surfaces downstream.
# Keep SUBAGENT_DIR default in sync with config.ts.

SUBAGENT_DIR="${LOOM_SUBAGENT_DIR:-/tmp/claude-subagents}"

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
