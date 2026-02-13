#!/bin/bash
# Tests for validate-task-graph + populate-task-graph (TS CLI)
# Run: bash .claude/tests/test-validate-task-graph.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$SCRIPT_DIR/../hooks/loom/src/cli.ts"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

TESTS_RUN=0
TESTS_PASSED=0

pass() { TESTS_RUN=$((TESTS_RUN + 1)); TESTS_PASSED=$((TESTS_PASSED + 1)); echo -e "${GREEN}✓${NC} $1"; }
fail() { TESTS_RUN=$((TESTS_RUN + 1)); echo -e "${RED}✗${NC} $1 (expected '$2', got '$3')"; }

# ===== MINIMAL MODE =====

echo "Testing validate-task-graph (TS CLI)"
echo "========================================="
echo ""
echo "--- Minimal mode ---"

# Valid minimal graph
VALID_MINIMAL='{
  "current_phase": "init",
  "phase_artifacts": {},
  "skipped_phases": [],
  "spec_file": null,
  "plan_file": null
}'

if echo "$VALID_MINIMAL" | bun "$CLI" helper validate-task-graph --minimal >/dev/null 2>&1; then
  pass "valid minimal graph passes"
else
  fail "valid minimal graph passes" "exit 0" "exit 1"
fi

# Missing current_phase
BAD_NO_PHASE='{
  "phase_artifacts": {},
  "skipped_phases": [],
  "spec_file": null,
  "plan_file": null
}'
if echo "$BAD_NO_PHASE" | bun "$CLI" helper validate-task-graph --minimal >/dev/null 2>&1; then
  fail "rejects missing current_phase" "exit 1" "exit 0"
else
  pass "rejects missing current_phase"
fi

# Invalid current_phase value
BAD_PHASE='{
  "current_phase": "bogus",
  "phase_artifacts": {},
  "skipped_phases": [],
  "spec_file": null,
  "plan_file": null
}'
if echo "$BAD_PHASE" | bun "$CLI" helper validate-task-graph --minimal >/dev/null 2>&1; then
  fail "rejects invalid phase name" "exit 1" "exit 0"
else
  pass "rejects invalid phase name"
fi

# Missing spec_file key
BAD_NO_SPEC='{
  "current_phase": "init",
  "phase_artifacts": {},
  "skipped_phases": []
}'
if echo "$BAD_NO_SPEC" | bun "$CLI" helper validate-task-graph --minimal >/dev/null 2>&1; then
  fail "rejects missing spec_file key" "exit 1" "exit 0"
else
  pass "rejects missing spec_file key"
fi

# phase_artifacts wrong type
BAD_PA='{
  "current_phase": "init",
  "phase_artifacts": "wrong",
  "skipped_phases": [],
  "spec_file": null,
  "plan_file": null
}'
if echo "$BAD_PA" | bun "$CLI" helper validate-task-graph --minimal >/dev/null 2>&1; then
  fail "rejects non-object phase_artifacts" "exit 1" "exit 0"
else
  pass "rejects non-object phase_artifacts"
fi

# All valid phase names accepted
for phase in init brainstorm specify clarify architecture decompose execute; do
  JSON=$(echo "$VALID_MINIMAL" | jq --arg p "$phase" '.current_phase = $p')
  if echo "$JSON" | bun "$CLI" helper validate-task-graph --minimal >/dev/null 2>&1; then
    pass "accepts phase: $phase"
  else
    fail "accepts phase: $phase" "exit 0" "exit 1"
  fi
done

# ===== --FIX MINIMAL =====

echo ""
echo "--- Minimal --fix mode ---"

# Fix missing fields
PARTIAL='{"current_phase": "specify"}'
FIXED=$(echo "$PARTIAL" | bun "$CLI" helper validate-task-graph --minimal --fix 2>/dev/null)
if echo "$FIXED" | jq -e '.phase_artifacts == {} and .skipped_phases == [] and .spec_file == null and .plan_file == null' >/dev/null 2>&1; then
  pass "fix adds missing minimal fields"
else
  fail "fix adds missing minimal fields" "all defaults" "$(echo "$FIXED" | jq -c '.')"
fi

# Fix resets invalid current_phase to "init"
BOGUS_PHASE='{"current_phase": "bogus", "phase_artifacts": {}, "skipped_phases": [], "spec_file": null, "plan_file": null}'
FIXED_BOGUS=$(echo "$BOGUS_PHASE" | bun "$CLI" helper validate-task-graph --minimal --fix 2>/dev/null)
FIXED_CP=$(echo "$FIXED_BOGUS" | jq -r '.current_phase')
[[ "$FIXED_CP" == "init" ]] && pass "fix resets invalid current_phase to init" || fail "fix resets invalid phase" "init" "$FIXED_CP"

# Fix preserves valid fields
PARTIAL_WITH_DATA='{"current_phase": "architecture", "phase_artifacts": {"brainstorm": "/path"}, "skipped_phases": ["clarify"]}'
FIXED2=$(echo "$PARTIAL_WITH_DATA" | bun "$CLI" helper validate-task-graph --minimal --fix 2>/dev/null)
CP=$(echo "$FIXED2" | jq -r '.current_phase')
PA=$(echo "$FIXED2" | jq -r '.phase_artifacts.brainstorm')
SP=$(echo "$FIXED2" | jq -r '.skipped_phases[0]')
if [[ "$CP" == "architecture" && "$PA" == "/path" && "$SP" == "clarify" ]]; then
  pass "fix preserves existing valid fields"
else
  fail "fix preserves existing valid fields" "architecture,/path,clarify" "$CP,$PA,$SP"
fi

# Fix from garbage JSON
FIXED3=$(echo "not json at all" | bun "$CLI" helper validate-task-graph --minimal --fix 2>/dev/null)
if echo "$FIXED3" | jq -e '.current_phase == "init"' >/dev/null 2>&1; then
  pass "fix recovers from invalid JSON with canonical template"
else
  fail "fix recovers from invalid JSON" "canonical template" "$FIXED3"
fi

# ===== --FIX FULL =====

echo ""
echo "--- Full --fix mode ---"

FIXABLE='{
  "plan_title": "Test",
  "plan_file": "/p",
  "spec_file": "/s",
  "tasks": [
    {"id": "T1", "description": "Do thing", "agent": "code-implementer-agent", "wave": 1}
  ]
}'
FIXED4=$(echo "$FIXABLE" | bun "$CLI" helper validate-task-graph --fix 2>/dev/null)
HAS_DEFAULTS=$(echo "$FIXED4" | jq '.tasks[0] | has("depends_on") and has("status") and has("review_status") and has("critical_findings") and has("advisory_findings")')
if [[ "$HAS_DEFAULTS" == "true" ]]; then
  pass "fix adds per-task defaults (status, review_status, depends_on, findings)"
else
  fail "fix adds per-task defaults" "true" "$HAS_DEFAULTS"
fi

STATUS=$(echo "$FIXED4" | jq -r '.tasks[0].status')
[[ "$STATUS" == "pending" ]] && pass "fix sets status=pending" || fail "fix sets status" "pending" "$STATUS"

# ===== POPULATE VALIDATION =====

echo ""
echo "--- populate-task-graph validates decompose input ---"

PTEST_DIR=$(mktemp -d)
CLEANUP_DIRS="$PTEST_DIR"
trap "rm -rf $CLEANUP_DIRS" EXIT

# Setup minimal state
mkdir -p "$PTEST_DIR/.claude/state"
cat > "$PTEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_phase": "decompose",
  "phase_artifacts": {},
  "skipped_phases": [],
  "spec_file": null,
  "plan_file": null
}
EOF
chmod 644 "$PTEST_DIR/.claude/state/active_task_graph.json"

# Bad decompose JSON (missing required fields)
BAD_DECOMPOSE='{"tasks": []}'
if (cd "$PTEST_DIR" && echo "$BAD_DECOMPOSE" | bun "$CLI" helper populate-task-graph 2>/dev/null); then
  fail "populate rejects invalid decompose JSON" "exit 1" "exit 0"
else
  pass "populate rejects invalid decompose JSON"
fi

# Valid decompose JSON passes
GOOD_DECOMPOSE='{
  "plan_title": "Test Plan",
  "plan_file": ".claude/plans/test.md",
  "spec_file": ".claude/specs/test/spec.md",
  "tasks": [
    {"id": "T1", "description": "Impl", "agent": "code-implementer-agent", "wave": 1, "depends_on": []}
  ]
}'
# Reset state (may be chmod 444 after previous write)
chmod 644 "$PTEST_DIR/.claude/state/active_task_graph.json" 2>/dev/null || true
rm -rf "$PTEST_DIR/.claude/state/.task_graph.lock" 2>/dev/null || true
cat > "$PTEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_phase": "decompose",
  "phase_artifacts": {},
  "skipped_phases": [],
  "spec_file": null,
  "plan_file": null
}
EOF

if (cd "$PTEST_DIR" && echo "$GOOD_DECOMPOSE" | bun "$CLI" helper populate-task-graph >/dev/null 2>&1); then
  pass "populate accepts valid decompose JSON"
else
  fail "populate accepts valid decompose JSON" "exit 0" "exit 1"
fi

# ===== RESULTS =====

echo ""
echo "========================================="
echo "Results: $TESTS_PASSED/$TESTS_RUN passed"

if [[ "$TESTS_PASSED" -eq "$TESTS_RUN" ]]; then
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
else
  echo -e "${RED}Some tests failed!${NC}"
  exit 1
fi
