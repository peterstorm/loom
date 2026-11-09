#!/bin/bash
# PreToolUse Bash guard (ADR-0067 D6): a SUBAGENT may not change audit or
# orchestration authority — no `helper security-audit|orchestration` write
# operations, no writes onto a registered audit run's authority files.
#
# Claude Code sets `agent_id` on PreToolUse only for calls that originate in a
# subagent. A payload that cannot carry it is the parent's: skip the bun spawn.
# The engine re-parses the JSON properly; this is only a fast path, and any
# payload that merely MENTIONS "agent_id" (e.g. in the command text) still goes
# to the engine, which decides on the parsed field.
#
# Failure policy: when the payload may be a subagent's and the runtime is
# unavailable (CLAUDE_PLUGIN_ROOT unset, bun off PATH), fail CLOSED — a guard
# that silently disables itself on PATH drift is no guard.
INPUT="$(cat)"
case "$INPUT" in
  *'"agent_id"'*) ;;
  *) exit 0 ;;
esac

if [ -z "${CLAUDE_PLUGIN_ROOT:-}" ]; then
  echo "[loom] guard-subagent-authority cannot run (CLAUDE_PLUGIN_ROOT unset) — blocking subagent Bash call" >&2
  exit 2
fi
if ! command -v bun &>/dev/null; then
  echo "[loom] guard-subagent-authority cannot run (bun not found) — blocking subagent Bash call" >&2
  exit 2
fi

printf '%s' "$INPUT" | exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" pre-tool-use guard-subagent-authority
