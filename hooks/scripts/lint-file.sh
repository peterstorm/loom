#!/bin/bash
set -euo pipefail

# PostToolUse lint hook — lint file after Edit/Write/MultiEdit
# Fail-closed: any setup error blocks the edit (exit 2)

# Fail-closed: if CLAUDE_PLUGIN_ROOT is unset, block with error
if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
  # Drain stdin to avoid SIGPIPE
  cat > /dev/null 2>/dev/null || true
  echo "❌ LINT HOOK ERROR: CLAUDE_PLUGIN_ROOT is not set" >&2
  exit 2
fi

# Fail-closed: if bun is not available, block with error
if ! command -v bun &>/dev/null; then
  # Drain stdin to avoid SIGPIPE
  cat > /dev/null 2>/dev/null || true
  echo "❌ LINT HOOK ERROR: 'bun' not found in PATH" >&2
  exit 2
fi

# OS-level timeout (5s) as last-resort safety net for cooperative deadline checker.
# If the regex engine hangs (bypassing the amortized deadline), this kills the process.
# `timeout` exits 124 on timeout; set -e propagates it as failure → fail-closed.
if command -v timeout &>/dev/null; then
  exec timeout 5 bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" post-tool-use lint-file
else
  # macOS coreutils may not have `timeout` — fall back to direct exec
  exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" post-tool-use lint-file
fi
