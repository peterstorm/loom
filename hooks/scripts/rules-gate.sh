#!/bin/bash
# PreToolUse rules gate — Edit/Write/MultiEdit/Bash. Blocks code mutation until
# the Loom rules/skills are in context and adherence is stated (twin of the Pi
# loom-rules-gate extension). LOOM_GATE=off disables it.
#
# Failure policy: fail CLOSED when the runtime is unavailable — a gate that
# silently disables itself on PATH drift is no gate.
if [ "${LOOM_GATE:-}" = "off" ] || [ "${LOOM_GATE:-}" = "0" ]; then
  cat > /dev/null
  exit 0
fi
if [ -z "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  cat > /dev/null 2>/dev/null || true
  echo "[loom] rules-gate cannot run (CLAUDE_PLUGIN_ROOT unset) — blocking call (LOOM_GATE=off to bypass)" >&2
  exit 2
fi
if ! command -v bun &>/dev/null; then
  cat > /dev/null 2>/dev/null || true
  echo "[loom] rules-gate cannot run (bun not found) — blocking call (LOOM_GATE=off to bypass)" >&2
  exit 2
fi

exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" pre-tool-use rules-gate
