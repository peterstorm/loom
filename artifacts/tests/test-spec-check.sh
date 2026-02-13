#!/bin/bash
# Test suite for spec-check hooks and integration
# Run from repo root: bash .claude/tests/test-spec-check.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_DIR=$(mktemp -d)
PASS=0
FAIL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

cleanup() {
  rm -rf "$TEST_DIR"
  rm -rf /tmp/claude-subagents
}
trap cleanup EXIT

# Helper: reset state file (chmod 644 so cat > works, clears stale locks)
reset_state() {
  chmod 644 "$TEST_DIR/.claude/state/active_task_graph.json" 2>/dev/null || true
  rm -rf "$TEST_DIR/.claude/state/.task_graph.lock" "$TEST_DIR/.claude/state/.task_graph.lock.lock" 2>/dev/null || true
}

pass() {
  echo -e "${GREEN}✓ $1${NC}"
  ((PASS++)) || true
}

fail() {
  echo -e "${RED}✗ $1${NC}"
  echo "  Expected: $2"
  echo "  Got: $3"
  ((FAIL++)) || true
}

# Setup test state directory
mkdir -p "$TEST_DIR/.claude/state"
mkdir -p "$TEST_DIR/.claude/specs/2025-01-29-test-feature"
mkdir -p /tmp/claude-subagents
cd "$TEST_DIR"

echo "=== Spec-Check Test Suite ==="
echo ""

# ============================================
# Test 1: store-spec-check-findings.sh parsing
# ============================================
echo "--- Test: store-spec-check-findings.sh ---"

# Create test state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "implemented", "review_status": "pending"}
  ],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": true, "reviews_complete": false, "blocked": false}}
}
EOF

# Create fake transcript with spec-check output
cat > "$TEST_DIR/spec-check-transcript.jsonl" << 'EOF'
{"message": {"content": "Running spec-check..."}}
{"message": {"content": "SPEC_CHECK_WAVE: 1\n\nCRITICAL: FR-003 (email validation) has no implementation\nCRITICAL: New /api/admin endpoint not in spec\nHIGH: US1 error scenario has no test\nMEDIUM: Terminology drift: User vs Account\n\nSPEC_CHECK_CRITICAL_COUNT: 2\nSPEC_CHECK_HIGH_COUNT: 1\nSPEC_CHECK_VERDICT: BLOCKED"}}
EOF

# Setup agent type file (simulates SubagentStart)
echo "spec-check-invoker" > /tmp/claude-subagents/test-agent-123.type
echo "test-session-123" > /tmp/claude-subagents/test-session.active

# Run hook (pipe input via stdin)
echo "{\"session_id\": \"test-session\", \"agent_id\": \"test-agent-123\", \"agent_type\": \"spec-check-invoker\", \"agent_transcript_path\": \"$TEST_DIR/spec-check-transcript.jsonl\"}" | \
  bash "$REPO_ROOT/.claude/hooks/SubagentStop/store-spec-check-findings.sh" 2>&1

# Verify spec_check was stored
SPEC_CRITICAL=$(jq -r '.spec_check.critical_count // "missing"' "$TEST_DIR/.claude/state/active_task_graph.json")
SPEC_HIGH=$(jq -r '.spec_check.high_count // "missing"' "$TEST_DIR/.claude/state/active_task_graph.json")
SPEC_VERDICT=$(jq -r '.spec_check.verdict // "missing"' "$TEST_DIR/.claude/state/active_task_graph.json")
SPEC_WAVE=$(jq -r '.spec_check.wave // "missing"' "$TEST_DIR/.claude/state/active_task_graph.json")
WAVE_BLOCKED=$(jq -r '.wave_gates["1"].blocked' "$TEST_DIR/.claude/state/active_task_graph.json")

[[ "$SPEC_CRITICAL" == "2" ]] && pass "Stores critical_count: 2" || fail "Stores critical_count" "2" "$SPEC_CRITICAL"
[[ "$SPEC_HIGH" == "1" ]] && pass "Stores high_count: 1" || fail "Stores high_count" "1" "$SPEC_HIGH"
[[ "$SPEC_VERDICT" == "BLOCKED" ]] && pass "Stores verdict: BLOCKED" || fail "Stores verdict" "BLOCKED" "$SPEC_VERDICT"
[[ "$SPEC_WAVE" == "1" ]] && pass "Stores wave: 1" || fail "Stores wave" "1" "$SPEC_WAVE"
[[ "$WAVE_BLOCKED" == "true" ]] && pass "Sets wave blocked=true" || fail "Sets wave blocked" "true" "$WAVE_BLOCKED"

# Verify critical findings stored
CRITICAL_FINDINGS=$(jq -r '.spec_check.critical_findings | length' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$CRITICAL_FINDINGS" == "2" ]] && pass "Stores 2 critical findings" || fail "Stores critical findings" "2" "$CRITICAL_FINDINGS"

# ============================================
# Test 2: store-spec-check-findings.sh PASSED case
# ============================================
echo ""
echo "--- Test: store-spec-check-findings.sh PASSED ---"

reset_state
# Reset state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [{"id": "T1", "wave": 1, "status": "implemented"}],
  "wave_gates": {"1": {"impl_complete": true, "blocked": false}}
}
EOF

# Create passing transcript
cat > "$TEST_DIR/spec-check-pass.jsonl" << 'EOF'
{"message": {"content": "SPEC_CHECK_WAVE: 1\n\nHIGH: Minor terminology drift\n\nSPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 1\nSPEC_CHECK_VERDICT: PASSED"}}
EOF

echo "spec-check-invoker" > /tmp/claude-subagents/pass-agent.type

echo "{\"session_id\": \"test-session\", \"agent_id\": \"pass-agent\", \"agent_type\": \"spec-check-invoker\", \"agent_transcript_path\": \"$TEST_DIR/spec-check-pass.jsonl\"}" | \
  bash "$REPO_ROOT/.claude/hooks/SubagentStop/store-spec-check-findings.sh" 2>&1

PASS_VERDICT=$(jq -r '.spec_check.verdict' "$TEST_DIR/.claude/state/active_task_graph.json")
PASS_BLOCKED=$(jq -r '.wave_gates["1"].blocked' "$TEST_DIR/.claude/state/active_task_graph.json")

[[ "$PASS_VERDICT" == "PASSED" ]] && pass "Stores PASSED verdict" || fail "Stores PASSED verdict" "PASSED" "$PASS_VERDICT"
[[ "$PASS_BLOCKED" == "false" ]] && pass "Does NOT block wave on PASSED" || fail "Does NOT block wave" "false" "$PASS_BLOCKED"

# ============================================
# Test 3: Hook ignores non-spec-check agents
# ============================================
echo ""
echo "--- Test: Hook ignores non-spec-check agents ---"

reset_state
# Reset state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [{"id": "T1", "wave": 1, "status": "implemented"}],
  "wave_gates": {"1": {"impl_complete": true, "blocked": false}}
}
EOF

# Different agent type
echo "code-implementer-agent" > /tmp/claude-subagents/impl-agent.type

echo "{\"session_id\": \"test-session\", \"agent_id\": \"impl-agent\", \"agent_type\": \"code-implementer-agent\", \"agent_transcript_path\": \"$TEST_DIR/spec-check-transcript.jsonl\"}" | \
  bash "$REPO_ROOT/.claude/hooks/SubagentStop/store-spec-check-findings.sh" 2>&1

# spec_check should NOT be added
SPEC_CHECK_EXISTS=$(jq -r '.spec_check // "missing"' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$SPEC_CHECK_EXISTS" == "missing" ]] && pass "Ignores non-spec-check agent types" || fail "Ignores non-spec-check agents" "missing" "$SPEC_CHECK_EXISTS"

# ============================================
# Test 4: complete-wave-gate.sh spec_check integration
# ============================================
echo ""
echo "--- Test: complete-wave-gate.sh spec_check gate ---"

reset_state
# Setup: spec_check has critical findings
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "implemented", "review_status": "passed", "critical_findings": [], "tests_passed": true, "test_evidence": "node: 3 passing", "new_tests_written": true, "new_test_evidence": "2 new tests"}
  ],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": null, "reviews_complete": false, "blocked": false}},
  "spec_check": {
    "wave": 1,
    "critical_count": 2,
    "high_count": 0,
    "critical_findings": ["FR-003 missing", "Scope creep"],
    "verdict": "BLOCKED"
  }
}
EOF

if bash "$REPO_ROOT/.claude/hooks/helpers/complete-wave-gate.sh" 2>&1; then
  fail "Blocks when spec_check has critical findings" "exit 1" "exit 0"
else
  pass "Blocks when spec_check has critical findings"
fi

# ============================================
# Test 5: complete-wave-gate.sh passes with clean spec_check
# ============================================
echo ""
echo "--- Test: complete-wave-gate.sh passes with clean spec_check ---"

reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "implemented", "review_status": "passed", "critical_findings": [], "tests_passed": true, "test_evidence": "node: 3 passing", "new_tests_written": true, "new_test_evidence": "2 new tests"}
  ],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": null, "reviews_complete": false, "blocked": false}},
  "spec_check": {
    "wave": 1,
    "critical_count": 0,
    "high_count": 1,
    "critical_findings": [],
    "high_findings": ["minor drift"],
    "verdict": "PASSED"
  }
}
EOF

if bash "$REPO_ROOT/.claude/hooks/helpers/complete-wave-gate.sh" 2>&1 | grep -q "All checks passed"; then
  pass "Passes with clean spec_check (0 critical)"
else
  fail "Passes with clean spec_check" "All checks passed" "blocked"
fi

# ============================================
# Test 6: complete-wave-gate.sh skips when no spec_check
# ============================================
echo ""
echo "--- Test: complete-wave-gate.sh skips when no spec_check ---"

reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "implemented", "review_status": "passed", "critical_findings": [], "tests_passed": true, "test_evidence": "node: 3 passing", "new_tests_written": true, "new_test_evidence": "2 new tests"}
  ],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": null, "reviews_complete": false, "blocked": false}}
}
EOF

OUTPUT=$(bash "$REPO_ROOT/.claude/hooks/helpers/complete-wave-gate.sh" 2>&1)
echo "$OUTPUT" | grep -q "skipped" && pass "Shows 'skipped' when no spec_check data" || fail "Shows skipped message" "contains 'skipped'" "$OUTPUT"
echo "$OUTPUT" | grep -q "All checks passed" && pass "Still passes without spec_check" || fail "Passes without spec_check" "All checks passed" "$OUTPUT"

# ============================================
# Test 7: complete-wave-gate.sh warns on wrong wave
# ============================================
echo ""
echo "--- Test: complete-wave-gate.sh warns on wrong wave ---"

reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 2,
  "tasks": [
    {"id": "T1", "wave": 2, "status": "implemented", "review_status": "passed", "critical_findings": [], "tests_passed": true, "test_evidence": "node: 3 passing", "new_tests_written": true, "new_test_evidence": "2 new tests"}
  ],
  "wave_gates": {"2": {"impl_complete": true, "tests_passed": null, "reviews_complete": false, "blocked": false}},
  "spec_check": {
    "wave": 1,
    "critical_count": 0,
    "verdict": "PASSED"
  }
}
EOF

OUTPUT=$(bash "$REPO_ROOT/.claude/hooks/helpers/complete-wave-gate.sh" 2>&1)
echo "$OUTPUT" | grep -q "WARNING" && pass "Warns when spec_check wave != current wave" || fail "Warns on wave mismatch" "contains WARNING" "$OUTPUT"

# ============================================
# Test 8: Hook requires SPEC_CHECK_CRITICAL_COUNT
# ============================================
echo ""
echo "--- Test: Hook requires SPEC_CHECK_CRITICAL_COUNT ---"

reset_state
# Reset state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [{"id": "T1", "wave": 1, "status": "implemented"}],
  "wave_gates": {"1": {"impl_complete": true, "blocked": false}}
}
EOF

# Malformed transcript (missing SPEC_CHECK_CRITICAL_COUNT)
cat > "$TEST_DIR/malformed-transcript.jsonl" << 'EOF'
{"message": {"content": "SPEC_CHECK_WAVE: 1\nCRITICAL: Some finding\nSPEC_CHECK_VERDICT: BLOCKED"}}
EOF

echo "spec-check-invoker" > /tmp/claude-subagents/malformed-agent.type

OUTPUT=$(echo "{\"session_id\": \"test-session\", \"agent_id\": \"malformed-agent\", \"agent_type\": \"spec-check-invoker\", \"agent_transcript_path\": \"$TEST_DIR/malformed-transcript.jsonl\"}" | \
  bash "$REPO_ROOT/.claude/hooks/SubagentStop/store-spec-check-findings.sh" 2>&1)

echo "$OUTPUT" | grep -q "WARNING" && pass "Warns on malformed output (missing count)" || fail "Warns on malformed" "contains WARNING" "$OUTPUT"

# Malformed → stores EVIDENCE_CAPTURE_FAILED (not silently ignored)
SPEC_VERDICT=$(jq -r '.spec_check.verdict // "missing"' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$SPEC_VERDICT" == "EVIDENCE_CAPTURE_FAILED" ]] && pass "Stores EVIDENCE_CAPTURE_FAILED verdict" || fail "Stores EVIDENCE_CAPTURE_FAILED" "EVIDENCE_CAPTURE_FAILED" "$SPEC_VERDICT"

# ============================================
# Test 9: spec-check-invoker agent file exists
# ============================================
echo ""
echo "--- Test: spec-check-invoker agent exists ---"

if [[ -f "$REPO_ROOT/.claude/agents/spec-check-invoker.md" ]]; then
  pass "spec-check-invoker.md exists"
else
  fail "spec-check-invoker.md exists" "file exists" "file not found"
fi

# Check agent has required fields
if grep -q "name: spec-check-invoker" "$REPO_ROOT/.claude/agents/spec-check-invoker.md"; then
  pass "Agent has name field"
else
  fail "Agent has name field" "name: spec-check-invoker" "missing"
fi

if grep -q "Skill" "$REPO_ROOT/.claude/agents/spec-check-invoker.md"; then
  pass "Agent has Skill tool"
else
  fail "Agent has Skill tool" "Skill in tools" "missing"
fi

# ============================================
# Test 10: /specify skill file exists
# ============================================
echo ""
echo "--- Test: /specify skill exists ---"

if [[ -f "$REPO_ROOT/.claude/skills/specify/SKILL.md" ]]; then
  pass "specify/SKILL.md exists"
else
  fail "specify/SKILL.md exists" "file exists" "file not found"
fi

if grep -q "name: specify" "$REPO_ROOT/.claude/skills/specify/SKILL.md"; then
  pass "Skill has name field"
else
  fail "Skill has name field" "name: specify" "missing"
fi

if grep -q "NEEDS CLARIFICATION" "$REPO_ROOT/.claude/skills/specify/SKILL.md"; then
  pass "Skill mentions NEEDS CLARIFICATION markers"
else
  fail "Skill mentions markers" "NEEDS CLARIFICATION" "missing"
fi

# ============================================
# Test 11: /clarify skill file exists
# ============================================
echo ""
echo "--- Test: /clarify skill exists ---"

if [[ -f "$REPO_ROOT/.claude/skills/clarify/SKILL.md" ]]; then
  pass "clarify/SKILL.md exists"
else
  fail "clarify/SKILL.md exists" "file exists" "file not found"
fi

if grep -q "name: clarify" "$REPO_ROOT/.claude/skills/clarify/SKILL.md"; then
  pass "Skill has name field"
else
  fail "Skill has name field" "name: clarify" "missing"
fi

# ============================================
# Test 12: /spec-check skill file exists
# ============================================
echo ""
echo "--- Test: /spec-check skill exists ---"

if [[ -f "$REPO_ROOT/.claude/skills/spec-check/SKILL.md" ]]; then
  pass "spec-check/SKILL.md exists"
else
  fail "spec-check/SKILL.md exists" "file exists" "file not found"
fi

if grep -q "name: spec-check" "$REPO_ROOT/.claude/skills/spec-check/SKILL.md"; then
  pass "Skill has name field"
else
  fail "Skill has name field" "name: spec-check" "missing"
fi

# ============================================
# Test 13: settings.json has spec-check hook
# ============================================
echo ""
echo "--- Test: dispatch.sh routes spec-check hook ---"

if grep -q "store-spec-check-findings.sh" "$REPO_ROOT/.claude/hooks/SubagentStop/dispatch.sh"; then
  pass "dispatch.sh routes to store-spec-check-findings.sh"
else
  fail "dispatch.sh routes hook" "store-spec-check-findings.sh" "missing"
fi

# ============================================
# Test 14: wave-gate mentions spec-check
# ============================================
echo ""
echo "--- Test: wave-gate includes spec-check ---"

if grep -q "spec-check-invoker" "$REPO_ROOT/.claude/skills/wave-gate/SKILL.md"; then
  pass "wave-gate mentions spec-check-invoker"
else
  fail "wave-gate mentions spec-check-invoker" "spec-check-invoker" "missing"
fi

if grep -q "Spec alignment" "$REPO_ROOT/.claude/skills/wave-gate/SKILL.md"; then
  pass "wave-gate mentions Spec alignment check"
else
  fail "wave-gate mentions Spec alignment" "Spec alignment" "missing"
fi

# ============================================
# Test 15: loom mentions spec_anchors
# ============================================
echo ""
echo "--- Test: loom includes spec_anchors ---"

if grep -q "spec_anchors" "$REPO_ROOT/.claude/skills/loom/SKILL.md"; then
  pass "loom SKILL.md mentions spec_anchors"
else
  fail "loom mentions spec_anchors" "spec_anchors" "missing"
fi

if grep -q "spec_anchors" "$REPO_ROOT/.claude/skills/loom/templates.md"; then
  pass "loom templates.md mentions spec_anchors"
else
  fail "templates.md mentions spec_anchors" "spec_anchors" "missing"
fi

if grep -q "spec_file" "$REPO_ROOT/.claude/skills/loom/templates.md"; then
  pass "loom templates.md mentions spec_file"
else
  fail "templates.md mentions spec_file" "spec_file" "missing"
fi

# ============================================
# Summary
# ============================================
echo ""
echo "==================================="
echo -e "Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
echo "==================================="

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
