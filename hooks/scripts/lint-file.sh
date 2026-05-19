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

exec bun "${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts" post-tool-use lint-file
