#!/bin/bash
# PostToolUse lint hook — lint file after Edit/Write/MultiEdit
# Drain stdin if no lint rules exist to avoid pipe hang
exec bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts post-tool-use lint-file
