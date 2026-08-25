#!/bin/bash
# SubagentStart shim — marks the session's subagent flag and binds the
# guarded machine for machine-gated agent types.
#
# Failure policy: fail CLOSED whenever the engine cannot decide whether a
# TaskGraph is active. Only the engine's ENOENT-only probe may prove absence;
# shell file tests collapse EACCES/ELOOP/ENOTDIR into a fail-open "missing".
if [ -z "${CLAUDE_PLUGIN_ROOT:-}" ] || ! command -v bun &>/dev/null; then
  cat > /dev/null 2>/dev/null || true
  echo "mark-subagent-active: runtime unavailable (bun/CLAUDE_PLUGIN_ROOT) — TaskGraph absence and exact SubagentStart authority cannot be proven; refusing spawn" >&2
  exit 2
fi

exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" subagent-start mark-subagent-active
