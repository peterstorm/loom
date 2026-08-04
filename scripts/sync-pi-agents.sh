#!/usr/bin/env bash
# Render Loom's shared agent definitions into Pi-specific definitions with
# explicit OpenAI provider/model/thinking bindings. A byte-copy would preserve
# Claude aliases (opus/sonnet/haiku), and omitting model would inherit Pi's
# expensive orchestrator model — both are forbidden by the LLM Profile policy.
#
# Usage: ./scripts/sync-pi-agents.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOOM_DIR="$(dirname "$SCRIPT_DIR")"
PI_AGENTS_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/agents"

mkdir -p "$PI_AGENTS_DIR"

before="$(mktemp -d)"
trap 'rm -rf "$before"' EXIT
for agent in "$LOOM_DIR"/agents/*.md; do
  name="$(basename "$agent")"
  [[ "$name" == "README.md" ]] && continue
  [[ -f "$PI_AGENTS_DIR/$name" ]] && cp "$PI_AGENTS_DIR/$name" "$before/$name"
done

bun "$LOOM_DIR/engine/src/cli.ts" helper model-profiles render-pi \
  --agents-dir "$LOOM_DIR/agents" \
  --package-root "$LOOM_DIR" \
  --output "$PI_AGENTS_DIR"

copied=0
unchanged=0
for agent in "$LOOM_DIR"/agents/*.md; do
  name="$(basename "$agent")"
  [[ "$name" == "README.md" ]] && continue
  if [[ -f "$before/$name" ]] && cmp -s "$before/$name" "$PI_AGENTS_DIR/$name"; then
    ((unchanged += 1))
  else
    printf '  rendered: %s\n' "$name"
    ((copied += 1))
  fi
done

printf '\nRendered Loom agents → %s\n' "$PI_AGENTS_DIR"
printf '  %d changed, %d unchanged\n' "$copied" "$unchanged"
if (( copied > 0 )); then
  printf '\nRun /reload in Pi to pick up the explicit model bindings.\n'
fi
