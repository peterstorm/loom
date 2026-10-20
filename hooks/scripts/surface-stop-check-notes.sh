#!/usr/bin/env bash
# Claude PostToolUse on Task/Agent: hand the orchestrating model the stop-check
# notes its session's agents left (#121). Fail-OPEN by design: this is context,
# never a gate. The fast path skips the bun spawn whenever no note sidecar
# exists at all, which is nearly every call; the engine filters by session.
set -u
dir="${LOOM_SUBAGENT_DIR:-/tmp/claude-subagents}"
if ! compgen -G "${dir}/*.stop-check-note.json" >/dev/null 2>&1; then
  exit 0
fi
if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" ]] || ! command -v bun >/dev/null 2>&1; then
  echo '{"systemMessage":"Loom stop-check notes not surfaced: runtime unavailable (CLAUDE_PLUGIN_ROOT unset or bun not on PATH)"}'
  exit 0
fi
exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" post-tool-use surface-stop-check-notes
