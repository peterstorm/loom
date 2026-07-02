#!/bin/bash
# PostToolUse evidence recorder — appends ground-truth events to the
# session's evidence ledger. Fail-open: evidence collection must never
# brick a session (downstream gates fail closed on MISSING evidence).
if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" ]] || ! command -v bun &>/dev/null; then
  cat > /dev/null 2>/dev/null || true
  exit 0
fi

exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" post-tool-use record-evidence
