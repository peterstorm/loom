#!/bin/bash
# Run all loom tests
# Usage: bash .claude/tests/run-all.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$SCRIPT_DIR/../hooks"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

echo "============================================"
echo "  Loom Test Suite"
echo "============================================"
echo ""

FAILED=0
TOTAL=0

run_test() {
  local name="$1"
  local cmd="$2"
  TOTAL=$((TOTAL + 1))
  
  echo -e "${YELLOW}[$TOTAL] $name${NC}"
  echo "--------------------------------------------"
  if eval "$cmd" 2>&1; then
    echo -e "${GREEN}✓ $name passed${NC}"
  else
    echo -e "${RED}✗ $name failed${NC}"
    FAILED=$((FAILED + 1))
  fi
  echo ""
}

# TypeScript tests (parse-phase-artifacts, etc.) — bun runs TS directly
run_test "TypeScript Parser Tests" \
  "cd $HOOKS_DIR/ts-utils && bun test src/tests.test.ts"

# Template validation tests
run_test "Template Validation Hook Tests" \
  "bash $SCRIPT_DIR/test-validate-template-substitution.sh"

# Advance-phase artifact capture tests
run_test "Advance-Phase Artifact Capture Tests" \
  "nix-shell -p nodejs jq --run \"bash $SCRIPT_DIR/test-advance-phase-artifacts.sh\""

# Task graph validation tests (minimal, full, --fix)
run_test "Task Graph Validation Tests" \
  "nix-shell -p jq --run \"bash $SCRIPT_DIR/test-validate-task-graph.sh\""

# Core loom tests
if [[ -f "$SCRIPT_DIR/test-loom.sh" ]]; then
  run_test "Loom Core Tests" \
    "nix-shell -p nodejs jq git --run \"bash $SCRIPT_DIR/test-loom.sh\""
fi

# Hook gap tests
if [[ -f "$SCRIPT_DIR/test-hook-gaps.sh" ]]; then
  run_test "Hook Gap Tests" \
    "nix-shell -p nodejs jq git --run \"bash $SCRIPT_DIR/test-hook-gaps.sh\""
fi

# Spec-check tests
if [[ -f "$SCRIPT_DIR/test-spec-check.sh" ]]; then
  run_test "Spec-Check Tests" \
    "nix-shell -p jq --run \"bash $SCRIPT_DIR/test-spec-check.sh\""
fi

echo "============================================"
echo "  Summary: $((TOTAL - FAILED))/$TOTAL passed"
echo "============================================"

if [[ "$FAILED" -eq 0 ]]; then
  echo -e "${GREEN}  All test suites passed!${NC}"
  exit 0
else
  echo -e "${RED}  $FAILED test suite(s) failed!${NC}"
  exit 1
fi
