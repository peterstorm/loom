#!/bin/bash
# PreToolUse (every tool) — binds a Claude implementation Agent's exact
# Implementation Attempt on its first tool call. SubagentStart usually runs
# before the child transcript exists, so the binding starts pending.
#
# Failure policy: fail OPEN, never silent. This hook decides no write —
# block-direct-edits performs the same binding before every Edit/Write/
# MultiEdit decision and fails CLOSED there — so a missing runtime only
# defers the binding to that gate (or to SubagentStop).
# Keep SUBAGENT_DIR default in sync with config.ts.

SUBAGENT_DIR="${LOOM_SUBAGENT_DIR:-/tmp/claude-subagents}"
INPUT="$(cat)"

# Fast paths, no runtime needed: only calls made INSIDE a subagent carry
# agent_id, and only a session with an active roster can have one to bind.
case "$INPUT" in
  *'"agent_id"'*) ;;
  *) exit 0 ;;
esac
if ! ls "${SUBAGENT_DIR}"/*.active &>/dev/null; then
  exit 0
fi

if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" ]] || ! command -v bun &>/dev/null; then
  echo "bind-implementation-attempt: runtime unavailable — binding deferred to block-direct-edits / SubagentStop" >&2
  exit 0
fi

exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" pre-tool-use bind-implementation-attempt <<<"$INPUT"
