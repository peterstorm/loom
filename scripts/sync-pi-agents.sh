#!/usr/bin/env bash
# Sync loom agents to pi's agent directory.
# Run after adding/changing agents in loom/agents/.
#
# Usage: ./scripts/sync-pi-agents.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOOM_DIR="$(dirname "$SCRIPT_DIR")"
PI_AGENTS_DIR="$HOME/.pi/agent/agents"

mkdir -p "$PI_AGENTS_DIR"

copied=0
skipped=0

for agent in "$LOOM_DIR"/agents/*.md; do
  name="$(basename "$agent")"
  # Skip README
  [[ "$name" == "README.md" ]] && continue

  if [[ -f "$PI_AGENTS_DIR/$name" ]] && diff -q "$agent" "$PI_AGENTS_DIR/$name" >/dev/null 2>&1; then
    ((skipped++))
  else
    cp "$agent" "$PI_AGENTS_DIR/$name"
    echo "  copied: $name"
    ((copied++))
  fi
done

echo ""
echo "Synced loom agents → ~/.pi/agent/agents/"
echo "  $copied copied, $skipped unchanged"
echo ""
if ((copied > 0)); then
  echo "Run /reload in pi to pick up changes."
fi
