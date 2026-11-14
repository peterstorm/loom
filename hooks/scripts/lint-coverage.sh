#!/bin/bash
# Session-start lint-coverage reminder: when the session's project does not
# have every Loom lint rule family on (no setup, or an opt-in family neither
# configured nor declined), tell the model and the user. Stdout carries the
# hook's JSON output. A repository on the user's ignore list stays quiet.
#
# Failure policy: fail OPEN loudly — SessionStart must never block a session,
# but a silent skip would hide that the reminder did not run.
if [ -z "${CLAUDE_PLUGIN_ROOT:-}" ] || ! command -v bun &>/dev/null; then
  cat > /dev/null 2>/dev/null || true
  echo "lint-coverage: runtime unavailable — lint coverage not checked" >&2
  exit 0
fi

exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" session-start lint-coverage
