#!/bin/bash
set -euo pipefail

# PreToolUse guarded-skill-machine gate — deny-by-default tool gating for
# machine-bound subagent runs. Cheap no-op when no binding file exists.
#
# Failure policy: when a binding EXISTS but the runtime is unavailable
# (bun/plugin-root missing), the gate fails CLOSED — a gate that silently
# disables itself on PATH drift is no gate. Keep in sync with config.ts
# SUBAGENT_DIR default.

SUBAGENT_DIR="${LOOM_SUBAGENT_DIR:-/tmp/claude-subagents}"

# Fast path: no machine binding anywhere → allow without spawning bun
if ! ls "${SUBAGENT_DIR}"/*.machine &>/dev/null; then
  cat > /dev/null
  exit 0
fi

if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
  cat > /dev/null 2>/dev/null || true
  echo "[loom machine] gate cannot run (CLAUDE_PLUGIN_ROOT unset) — blocking enforced tools" >&2
  exit 2
fi
if ! command -v bun &>/dev/null; then
  cat > /dev/null 2>/dev/null || true
  echo "[loom machine] gate cannot run (bun not found) — blocking enforced tools" >&2
  exit 2
fi

exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" pre-tool-use enforce-phase-tools
