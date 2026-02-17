#!/bin/bash
# Integration test suite for loom hooks (TS CLI)
# Tests hook shims → cli.ts pipeline, helper scripts, and SubagentStop dispatch.
# Unit tests for pure logic are in loom/tests/ (vitest, 100+ tests).
# Run from repo root: bash .claude/tests/test-loom.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="$REPO_ROOT/.claude/hooks/loom/src/cli.ts"
DISPATCH="$REPO_ROOT/.claude/hooks/SubagentStop/dispatch.sh"
TEST_DIR=$(mktemp -d)
PASS=0
FAIL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

cleanup() {
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

# Helper: reset state file (chmod 644, clear locks)
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
cd "$TEST_DIR"

echo "=== Loom Integration Test Suite ==="
echo ""

# ============================================
# Test 1: store-review-findings.sh helper (stdin)
# ============================================
echo "--- Test: store-review-findings helper ---"

reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "implemented", "review_status": "pending", "critical_findings": [], "advisory_findings": []}
  ],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": true, "reviews_complete": false, "blocked": false}}
}
EOF

# stdin with special characters
bun "$CLI" helper store-review-findings --task T1 <<'EOF'
CRITICAL: SQL injection via "$user_input" in query
CRITICAL: Missing auth check on /api/admin
ADVISORY: Consider using `Optional<T>` instead of null
EOF

CRITICAL_COUNT=$(jq '[.tasks[] | select(.id=="T1") | .critical_findings | length] | add' "$TEST_DIR/.claude/state/active_task_graph.json")
ADVISORY_COUNT=$(jq '[.tasks[] | select(.id=="T1") | .advisory_findings | length] | add' "$TEST_DIR/.claude/state/active_task_graph.json")
REVIEW_STATUS=$(jq -r '.tasks[] | select(.id=="T1") | .review_status' "$TEST_DIR/.claude/state/active_task_graph.json")
WAVE_BLOCKED=$(jq -r '.wave_gates["1"].blocked' "$TEST_DIR/.claude/state/active_task_graph.json")

[[ "$CRITICAL_COUNT" == "2" ]] && pass "Stores 2 critical findings" || fail "Stores 2 critical findings" "2" "$CRITICAL_COUNT"
[[ "$ADVISORY_COUNT" == "1" ]] && pass "Stores 1 advisory finding" || fail "Stores 1 advisory finding" "1" "$ADVISORY_COUNT"
[[ "$REVIEW_STATUS" == "blocked" ]] && pass "Sets review_status to blocked" || fail "Sets review_status to blocked" "blocked" "$REVIEW_STATUS"
[[ "$WAVE_BLOCKED" == "true" ]] && pass "Sets wave blocked=true" || fail "Sets wave blocked=true" "true" "$WAVE_BLOCKED"

# Verify special chars preserved
FINDING=$(jq -r '.tasks[] | select(.id=="T1") | .critical_findings[0]' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$FINDING" == *'$user_input'* ]] && pass "Preserves \$user_input in finding" || fail "Preserves special chars" "contains \$user_input" "$FINDING"

# ============================================
# Test 2: mark-tests-passed helper (read-only verifier)
# ============================================
echo ""
echo "--- Test: mark-tests-passed helper ---"

# Test: all tasks have evidence → exit 0
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "implemented", "tests_passed": true, "test_evidence": "node: 5 passing", "new_tests_written": true, "new_test_evidence": "ts/js: 3 new it/test/describe blocks"}
  ],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": null, "reviews_complete": false, "blocked": false}}
}
EOF

if bun "$CLI" helper mark-tests-passed </dev/null >/dev/null 2>&1; then
  pass "mark-tests-passed exits 0 when all tasks have evidence"
else
  fail "mark-tests-passed exits 0 when all tasks have evidence" "exit 0" "exit 1"
fi

# Test: missing test evidence → exit 1
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "implemented", "tests_passed": false, "new_tests_written": false}
  ],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": null, "reviews_complete": false, "blocked": false}}
}
EOF

if bun "$CLI" helper mark-tests-passed </dev/null >/dev/null 2>&1; then
  fail "mark-tests-passed exits 1 when evidence missing" "exit 1" "exit 0"
else
  pass "mark-tests-passed exits 1 when evidence missing"
fi

# ============================================
# Test 3: complete-wave-gate helper
# ============================================
echo ""
echo "--- Test: complete-wave-gate helper ---"

# Setup: wave 1 complete, no critical findings
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "github_issue": null,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "implemented", "review_status": "passed", "critical_findings": [], "advisory_findings": [], "tests_passed": true, "test_evidence": "node: 3 passing", "new_tests_written": true, "new_test_evidence": "ts/js: 2 new it blocks"},
    {"id": "T2", "wave": 1, "status": "implemented", "review_status": "passed", "critical_findings": [], "advisory_findings": [], "tests_passed": true, "test_evidence": "node: 5 passing", "new_tests_written": true, "new_test_evidence": "ts/js: 4 new test blocks"},
    {"id": "T3", "wave": 2, "status": "pending", "review_status": "pending", "critical_findings": [], "advisory_findings": []}
  ],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": true, "reviews_complete": false, "blocked": false}}
}
EOF

bun "$CLI" helper complete-wave-gate </dev/null 2>/dev/null

CURRENT_WAVE=$(jq -r '.current_wave' "$TEST_DIR/.claude/state/active_task_graph.json")
T1_STATUS=$(jq -r '.tasks[] | select(.id=="T1") | .status' "$TEST_DIR/.claude/state/active_task_graph.json")
REVIEWS_COMPLETE=$(jq -r '.wave_gates["1"].reviews_complete' "$TEST_DIR/.claude/state/active_task_graph.json")
WAVE2_EXISTS=$(jq -r '.wave_gates["2"] // "missing"' "$TEST_DIR/.claude/state/active_task_graph.json")

[[ "$CURRENT_WAVE" == "2" ]] && pass "Advances to wave 2" || fail "Advances to wave 2" "2" "$CURRENT_WAVE"
[[ "$T1_STATUS" == "completed" ]] && pass "Marks T1 completed" || fail "Marks T1 completed" "completed" "$T1_STATUS"
[[ "$REVIEWS_COMPLETE" == "true" ]] && pass "Sets reviews_complete=true" || fail "Sets reviews_complete" "true" "$REVIEWS_COMPLETE"
[[ "$WAVE2_EXISTS" != "missing" ]] && pass "Initializes wave 2 gate" || fail "Initializes wave 2 gate" "object" "$WAVE2_EXISTS"

# Test blocking when critical findings exist
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [{"id": "T1", "wave": 1, "status": "implemented", "review_status": "blocked", "critical_findings": ["bug"], "advisory_findings": []}],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": true, "reviews_complete": false, "blocked": true}}
}
EOF

if bun "$CLI" helper complete-wave-gate </dev/null 2>&1; then
  fail "Blocks when critical findings exist" "exit 1" "exit 0"
else
  pass "Blocks when critical findings exist"
fi

# ============================================
# Test 4: validate-task-execution.sh (shim)
# ============================================
echo ""
echo "--- Test: validate-task-execution.sh ---"

reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "pending", "depends_on": []},
    {"id": "T2", "wave": 2, "status": "pending", "depends_on": ["T1"]}
  ],
  "wave_gates": {"1": {"impl_complete": false, "tests_passed": null, "reviews_complete": false, "blocked": false}}
}
EOF

# Allow wave 1 task
if echo '{"tool_name": "Task", "tool_input": {"prompt": "**Task ID:** T1\nImplement feature"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/validate-task-execution.sh" 2>&1; then
  pass "Allows wave 1 task when current_wave=1"
else
  fail "Allows wave 1 task" "exit 0" "exit non-zero"
fi

# Block wave 2 task
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "pending", "depends_on": []},
    {"id": "T2", "wave": 2, "status": "pending", "depends_on": ["T1"]}
  ],
  "wave_gates": {"1": {"impl_complete": false, "tests_passed": null, "reviews_complete": false, "blocked": false}}
}
EOF

if echo '{"tool_name": "Task", "tool_input": {"prompt": "**Task ID:** T2\nImplement feature"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/validate-task-execution.sh" 2>&1; then
  fail "Blocks wave 2 task when current_wave=1" "exit 2" "exit 0"
else
  pass "Blocks wave 2 task when current_wave=1"
fi

# Allow non-planned task (no Task ID)
if echo '{"tool_name": "Task", "tool_input": {"prompt": "Run some tests"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/validate-task-execution.sh" 2>&1; then
  pass "Allows non-planned tasks (no Task ID)"
else
  fail "Allows non-planned tasks" "exit 0" "exit non-zero"
fi

# Accepts non-canonical format
if echo '{"tool_name": "Task", "tool_input": {"prompt": "TASK: T1\nImplement feature"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/validate-task-execution.sh" 2>/dev/null; then
  pass "Accepts non-canonical format (TASK: T1)"
else
  fail "Accepts non-canonical format (TASK: T1)" "exit 0" "exit 2"
fi

# ============================================
# Test 5: validate-task-execution.sh stores start_sha
# ============================================
echo ""
echo "--- Test: Per-task start_sha ---"

GIT_TEST_DIR=$(mktemp -d)
(cd "$GIT_TEST_DIR" && git init -q && git commit --allow-empty -m "init" -q)
EXPECTED_SHA=$(cd "$GIT_TEST_DIR" && git rev-parse HEAD)

mkdir -p "$GIT_TEST_DIR/.claude/state"
cat > "$GIT_TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "pending", "depends_on": []}
  ],
  "wave_gates": {"1": {"impl_complete": false, "reviews_complete": false, "blocked": false}}
}
EOF

(cd "$GIT_TEST_DIR" && echo '{"tool_name": "Task", "tool_input": {"prompt": "**Task ID:** T1\nImplement feature"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/validate-task-execution.sh" 2>&1)

STORED_SHA=$(jq -r '.tasks[] | select(.id=="T1") | .start_sha // "missing"' "$GIT_TEST_DIR/.claude/state/active_task_graph.json")
[[ "$STORED_SHA" == "$EXPECTED_SHA" ]] && pass "stores HEAD SHA as start_sha" || fail "stores start_sha" "$EXPECTED_SHA" "$STORED_SHA"

rm -rf "$GIT_TEST_DIR"

# ============================================
# Test 6: guard-state-file.sh write patterns
# ============================================
echo ""
echo "--- Test: guard-state-file.sh write patterns ---"

cd "$TEST_DIR"
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{"current_wave": 1, "tasks": [], "wave_gates": {}}
EOF

# >> (append) should be blocked
if echo '{"tool_name": "Bash", "tool_input": {"command": "echo x >> .claude/state/active_task_graph.json"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/guard-state-file.sh" 2>/dev/null; then
  fail "Blocks >> append to state file" "exit 2" "exit 0"
else
  pass "Blocks >> append to state file"
fi

# jq read (no write) should be allowed
if echo '{"tool_name": "Bash", "tool_input": {"command": "jq . .claude/state/active_task_graph.json"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/guard-state-file.sh" 2>/dev/null; then
  pass "Allows jq read of state file"
else
  fail "Allows jq read of state file" "exit 0" "exit 2"
fi

# cat read should be allowed
if echo '{"tool_name": "Bash", "tool_input": {"command": "cat .claude/state/active_task_graph.json"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/guard-state-file.sh" 2>/dev/null; then
  pass "Allows cat read of state file"
else
  fail "Allows cat read of state file" "exit 0" "exit 2"
fi

# Whitelisted helper (new CLI format) should be allowed
if echo '{"tool_name": "Bash", "tool_input": {"command": "bun ~/.claude/hooks/loom/src/cli.ts helper complete-wave-gate"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/guard-state-file.sh" 2>/dev/null; then
  pass "Allows whitelisted helper (CLI format)"
else
  fail "Allows whitelisted helper (CLI format)" "exit 0" "exit 2"
fi

# chmod on state file should be blocked
if echo '{"tool_name": "Bash", "tool_input": {"command": "chmod 644 .claude/state/active_task_graph.json"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/guard-state-file.sh" 2>/dev/null; then
  fail "Blocks chmod on state file" "exit 2" "exit 0"
else
  pass "Blocks chmod on state file"
fi

# populate-task-graph whitelisted
if echo '{"tool_name": "Bash", "tool_input": {"command": "echo x | bun ~/.claude/hooks/loom/src/cli.ts helper populate-task-graph --issue 42"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/guard-state-file.sh" 2>/dev/null; then
  pass "Allows whitelisted populate-task-graph"
else
  fail "Allows whitelisted populate-task-graph" "exit 0" "exit 2"
fi

# ============================================
# Test 7: block-direct-edits.sh
# ============================================
echo ""
echo "--- Test: block-direct-edits.sh ---"

reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{"current_wave": 1, "tasks": [], "wave_gates": {"1": {"blocked": false}}}
EOF

# Edit blocked during orchestration
if echo '{"tool_name": "Edit", "tool_input": {"file_path": "test.ts"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/block-direct-edits.sh" 2>/dev/null; then
  fail "Blocks Edit during orchestration" "exit 2" "exit 0"
else
  pass "Blocks Edit during orchestration"
fi

# Write blocked during orchestration
if echo '{"tool_name": "Write", "tool_input": {"file_path": "test.ts"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/block-direct-edits.sh" 2>/dev/null; then
  fail "Blocks Write during orchestration" "exit 2" "exit 0"
else
  pass "Blocks Write during orchestration"
fi

# Other tools allowed
if echo '{"tool_name": "Read", "tool_input": {"file_path": "test.ts"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/block-direct-edits.sh" 2>/dev/null; then
  pass "Allows Read during orchestration"
else
  fail "Allows Read during orchestration" "exit 0" "exit 2"
fi

# No task graph = no blocking
rm "$TEST_DIR/.claude/state/active_task_graph.json"
if echo '{"tool_name": "Edit", "tool_input": {"file_path": "test.ts"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/block-direct-edits.sh" 2>/dev/null; then
  pass "Allows Edit when no orchestration active"
else
  fail "Allows Edit when no orchestration active" "exit 0" "exit 2"
fi

# Restore state file
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{"current_wave": 1, "tasks": [], "wave_gates": {"1": {"blocked": false}}}
EOF

# ============================================
# Test 8: SessionStart cleanup hook
# ============================================
echo ""
echo "--- Test: SessionStart cleanup ---"

mkdir -p /tmp/claude-subagents

# Create stale files (> 60 min)
echo "stale-agent" > /tmp/claude-subagents/old-session.active
echo "code-implementer-agent" > /tmp/claude-subagents/stale-agent.type
touch -t 202001010000 /tmp/claude-subagents/old-session.active
touch -t 202001010000 /tmp/claude-subagents/stale-agent.type

# Create recent files
echo "recent-agent" > /tmp/claude-subagents/new-session.active
echo "recent-type" > /tmp/claude-subagents/recent-agent.type

bash "$REPO_ROOT/.claude/hooks/SessionStart/cleanup-stale-subagents.sh"

if [[ -f /tmp/claude-subagents/old-session.active ]]; then
  fail "Cleans stale (>60min) .active files" "deleted" "still exists"
else
  pass "Cleans stale (>60min) .active files"
fi

if [[ -f /tmp/claude-subagents/stale-agent.type ]]; then
  fail "Cleans stale (>60min) .type files" "deleted" "still exists"
else
  pass "Cleans stale (>60min) .type files"
fi

if [[ -f /tmp/claude-subagents/new-session.active ]]; then
  pass "Preserves recent (<60min) files"
else
  fail "Preserves recent files" "preserved" "deleted"
fi

rm -f /tmp/claude-subagents/new-session.active /tmp/claude-subagents/recent-agent.type

# ============================================
# Test 9: complete-wave-gate blocks missing new_tests_written
# ============================================
echo ""
echo "--- Test: complete-wave-gate new_tests_written gate ---"

cd "$TEST_DIR"
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "implemented", "review_status": "passed", "critical_findings": [], "tests_passed": true, "test_evidence": "node: 3 passing", "new_tests_written": false, "new_test_evidence": ""}
  ],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": null, "reviews_complete": false, "blocked": false}}
}
EOF

if bun "$CLI" helper complete-wave-gate </dev/null 2>&1; then
  fail "Blocks when new_tests_written=false" "exit 1" "exit 0"
else
  pass "Blocks when new_tests_written=false"
fi

# ============================================
# Test 10: cleanup-subagent-flag via dispatch
# ============================================
echo ""
echo "--- Test: cleanup-subagent-flag (via dispatch) ---"

mkdir -p /tmp/claude-subagents
echo -e "agent-aaa\nagent-bbb" > /tmp/claude-subagents/cleanup-test-session.active
echo "code-implementer-agent" > /tmp/claude-subagents/agent-aaa.type

# Dispatch handles cleanup for all agent types
echo '{"session_id": "cleanup-test-session", "agent_id": "agent-aaa", "agent_type": "general-purpose"}' | bash "$DISPATCH"

if [[ -f /tmp/claude-subagents/cleanup-test-session.active ]]; then
  REMAINING=$(cat /tmp/claude-subagents/cleanup-test-session.active)
  echo "$REMAINING" | grep -q "agent-bbb" && pass "cleanup: keeps other agents" || fail "cleanup: keeps agent-bbb" "agent-bbb" "$REMAINING"
  ! echo "$REMAINING" | grep -q "agent-aaa" && pass "cleanup: removes completed agent" || fail "cleanup: removes agent-aaa" "absent" "$REMAINING"
else
  fail "cleanup: .active file should still exist with agent-bbb" "file exists" "file deleted"
fi

rm -rf /tmp/claude-subagents

# ============================================
# Test 11: complete-wave-gate new_tests_required=false
# ============================================
echo ""
echo "--- Test: complete-wave-gate new_tests_required=false ---"

cd "$TEST_DIR"
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "github_issue": null,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "implemented", "review_status": "passed", "critical_findings": [], "tests_passed": true, "test_evidence": "node: 3 passing", "new_tests_required": false, "new_tests_written": false, "new_test_evidence": "new_tests_required=false (skipped)"}
  ],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": null, "reviews_complete": false, "blocked": false}}
}
EOF

if bun "$CLI" helper complete-wave-gate </dev/null 2>&1 | grep -q "All checks passed"; then
  pass "Passes when new_tests_required=false"
else
  fail "Passes when new_tests_required=false" "All checks passed" "blocked"
fi

# Mixed: one false, one true+written
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "github_issue": null,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "implemented", "review_status": "passed", "critical_findings": [], "tests_passed": true, "test_evidence": "node: 3 passing", "new_tests_required": false, "new_tests_written": false, "new_test_evidence": "new_tests_required=false (skipped)"},
    {"id": "T2", "wave": 1, "status": "implemented", "review_status": "passed", "critical_findings": [], "tests_passed": true, "test_evidence": "node: 5 passing", "new_tests_required": true, "new_tests_written": true, "new_test_evidence": "java: 2 new @Test methods"}
  ],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": null, "reviews_complete": false, "blocked": false}}
}
EOF

if bun "$CLI" helper complete-wave-gate </dev/null 2>&1 | grep -q "All checks passed"; then
  pass "Mixed tasks: false + true both pass"
else
  fail "Mixed tasks pass" "All checks passed" "blocked"
fi

# new_tests_required=true but written=false should still fail
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "implemented", "review_status": "passed", "critical_findings": [], "tests_passed": true, "test_evidence": "node: 3 passing", "new_tests_required": true, "new_tests_written": false, "new_test_evidence": ""}
  ],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": null, "reviews_complete": false, "blocked": false}}
}
EOF

if bun "$CLI" helper complete-wave-gate </dev/null 2>&1; then
  fail "Blocks when new_tests_required=true but written=false" "exit 1" "exit 0"
else
  pass "Blocks when new_tests_required=true but written=false"
fi

# ============================================
# Test 12: update-task-status new_tests_required=false (via dispatch)
# ============================================
echo ""
echo "--- Test: update-task-status new_tests_required=false ---"

VNT_GIT_DIR=$(mktemp -d)
(cd "$VNT_GIT_DIR" && git init -q && git commit --allow-empty -m "init" -q)

mkdir -p "$VNT_GIT_DIR/.claude/state"
mkdir -p /tmp/claude-subagents
cat > "$VNT_GIT_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "pending", "agent": "code-implementer-agent", "new_tests_required": false}
  ],
  "executing_tasks": [],
  "wave_gates": {"1": {"impl_complete": false}}
}
EOF
echo "$VNT_GIT_DIR/.claude/state/active_task_graph.json" > /tmp/claude-subagents/vnt-skip-session.task_graph

# Create transcript (text only, no Bash tool output)
cat > "$VNT_GIT_DIR/skip-transcript.jsonl" << 'EOF'
{"message": {"content": "**Task ID:** T1\nImplementing migration"}}
EOF

# Dispatch routes code-implementer-agent → update-task-status
(cd "$VNT_GIT_DIR" && echo "{\"session_id\": \"vnt-skip-session\", \"agent_type\": \"code-implementer-agent\", \"agent_transcript_path\": \"$VNT_GIT_DIR/skip-transcript.jsonl\"}" | bash "$DISPATCH" 2>&1)

SKIP_EVIDENCE=$(jq -r '.tasks[] | select(.id=="T1") | .new_test_evidence' "$VNT_GIT_DIR/.claude/state/active_task_graph.json")
[[ "$SKIP_EVIDENCE" == *"skipped"* ]] && pass "skips new-test when new_tests_required=false" || fail "skips new-test" "contains 'skipped'" "$SKIP_EVIDENCE"

TASK_STATUS=$(jq -r '.tasks[] | select(.id=="T1") | .status' "$VNT_GIT_DIR/.claude/state/active_task_graph.json")
[[ "$TASK_STATUS" == "implemented" ]] && pass "marks implemented with skip" || fail "marks implemented" "implemented" "$TASK_STATUS"

rm -rf "$VNT_GIT_DIR" /tmp/claude-subagents
cd "$TEST_DIR"

# ============================================
# Test 13: SubagentStart stores task_graph path
# ============================================
echo ""
echo "--- Test: SubagentStart stores task_graph path ---"

rm -rf /tmp/claude-subagents

# SubagentStart in directory WITH task graph
cd "$TEST_DIR"
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{"current_wave": 1, "tasks": [], "wave_gates": {}}
EOF

echo '{"session_id": "store-path-session", "agent_id": "agent-xyz", "agent_type": "code-implementer-agent"}' | \
  bash "$REPO_ROOT/.claude/hooks/SubagentStart/mark-subagent-active.sh"

if [[ -f /tmp/claude-subagents/store-path-session.task_graph ]]; then
  STORED_PATH=$(cat /tmp/claude-subagents/store-path-session.task_graph)
  [[ "$STORED_PATH" == *"/.claude/state/active_task_graph.json" ]] && pass "SubagentStart: stores absolute task_graph path" || fail "SubagentStart: stores abs path" "*/.claude/state/active_task_graph.json" "$STORED_PATH"
  [[ "$STORED_PATH" == /* ]] && pass "SubagentStart: path is absolute" || fail "SubagentStart: path absolute" "starts with /" "$STORED_PATH"
else
  fail "SubagentStart: creates .task_graph file" "file exists" "file not found"
fi

# SubagentStart in directory WITHOUT task graph should NOT create file
NO_GRAPH_DIR=$(mktemp -d)
cd "$NO_GRAPH_DIR"
rm -f /tmp/claude-subagents/no-graph-session.task_graph
echo '{"session_id": "no-graph-session", "agent_id": "agent-abc", "agent_type": "code-implementer-agent"}' | \
  bash "$REPO_ROOT/.claude/hooks/SubagentStart/mark-subagent-active.sh"

[[ ! -f /tmp/claude-subagents/no-graph-session.task_graph ]] && pass "SubagentStart: no .task_graph when no local graph" || fail "SubagentStart: no file without graph" "file not exists" "file created"
rm -rf "$NO_GRAPH_DIR"

rm -rf /tmp/claude-subagents
cd "$TEST_DIR"

# ============================================
# Test 14: cleanup preserves .task_graph on last agent (via dispatch)
# ============================================
echo ""
echo "--- Test: cleanup preserves .task_graph on last agent ---"

mkdir -p /tmp/claude-subagents
echo "agent-last" > /tmp/claude-subagents/cleanup-graph-session.active
echo "/some/path/task_graph.json" > /tmp/claude-subagents/cleanup-graph-session.task_graph
echo "code-implementer-agent" > /tmp/claude-subagents/agent-last.type

# Last agent completing via dispatch
echo '{"session_id": "cleanup-graph-session", "agent_id": "agent-last", "agent_type": "general-purpose"}' | \
  bash "$DISPATCH"

[[ ! -f /tmp/claude-subagents/cleanup-graph-session.active ]] && pass "cleanup: removes .active on last agent" || fail "cleanup: removes .active" "deleted" "still exists"
[[ -f /tmp/claude-subagents/cleanup-graph-session.task_graph ]] && pass "cleanup: preserves .task_graph for parallel hooks" || fail "cleanup: preserves .task_graph" "preserved" "deleted"

rm -rf /tmp/claude-subagents

# ============================================
# Test 15: validate-phase-order.sh
# ============================================
echo ""
echo "--- Test: validate-phase-order.sh ---"

cd "$TEST_DIR"

# brainstorm-agent allowed from init
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_phase": "init",
  "phase_artifacts": {},
  "skipped_phases": [],
  "current_wave": null,
  "tasks": []
}
EOF

if echo '{"tool_name": "Task", "tool_input": {"prompt": "Explore feature", "subagent_type": "brainstorm-agent"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/validate-phase-order.sh" 2>&1; then
  pass "allows brainstorm from init"
else
  fail "allows brainstorm from init" "exit 0" "exit 2"
fi

# specify-agent BLOCKED from init (brainstorm not done)
if echo '{"tool_name": "Task", "tool_input": {"prompt": "Create spec", "subagent_type": "specify-agent"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/validate-phase-order.sh" 2>/dev/null; then
  fail "blocks specify from init" "exit 2" "exit 0"
else
  pass "blocks specify from init"
fi

# specify-agent allowed when brainstorm skipped
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_phase": "init",
  "phase_artifacts": {},
  "skipped_phases": ["brainstorm"],
  "current_wave": null,
  "tasks": []
}
EOF

if echo '{"tool_name": "Task", "tool_input": {"prompt": "Create spec", "subagent_type": "specify-agent"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/validate-phase-order.sh" 2>&1; then
  pass "allows specify when brainstorm skipped"
else
  fail "allows specify when brainstorm skipped" "exit 0" "exit 2"
fi

# architecture blocked without spec
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_phase": "specify",
  "phase_artifacts": {"brainstorm": "completed"},
  "skipped_phases": [],
  "current_wave": null,
  "tasks": []
}
EOF

if echo '{"tool_name": "Task", "tool_input": {"prompt": "Design architecture", "subagent_type": "architecture-agent"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/validate-phase-order.sh" 2>/dev/null; then
  fail "blocks architecture without spec" "exit 2" "exit 0"
else
  pass "blocks architecture without spec"
fi

# architecture allowed with spec (markers <= 3)
mkdir -p "$TEST_DIR/.claude/specs/test-feature"
cat > "$TEST_DIR/.claude/specs/test-feature/spec.md" << 'EOF'
# Test Spec
Some requirements here.
[NEEDS CLARIFICATION]: One marker
[NEEDS CLARIFICATION]: Two markers
EOF

reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_phase": "specify",
  "phase_artifacts": {"brainstorm": "completed", "specify": ".claude/specs/test-feature/spec.md"},
  "skipped_phases": [],
  "spec_file": ".claude/specs/test-feature/spec.md",
  "current_wave": null,
  "tasks": []
}
EOF

if echo '{"tool_name": "Task", "tool_input": {"prompt": "Design architecture", "subagent_type": "architecture-agent"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/validate-phase-order.sh" 2>&1; then
  pass "allows architecture with spec (markers <= 3)"
else
  fail "allows architecture with spec" "exit 0" "exit 2"
fi

# architecture BLOCKED when too many markers
cat > "$TEST_DIR/.claude/specs/test-feature/spec.md" << 'EOF'
# Test Spec
[NEEDS CLARIFICATION]: One
[NEEDS CLARIFICATION]: Two
[NEEDS CLARIFICATION]: Three
[NEEDS CLARIFICATION]: Four
[NEEDS CLARIFICATION]: Five
EOF

if echo '{"tool_name": "Task", "tool_input": {"prompt": "Design architecture", "subagent_type": "architecture-agent"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/validate-phase-order.sh" 2>/dev/null; then
  fail "blocks architecture when markers > 3" "exit 2" "exit 0"
else
  pass "blocks architecture when markers > 3"
fi

# Non-Task tools pass through
if echo '{"tool_name": "Read", "tool_input": {"file_path": "test.ts"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/validate-phase-order.sh" 2>&1; then
  pass "ignores non-Task tools"
else
  fail "ignores non-Task tools" "exit 0" "exit 2"
fi

# Unknown agent types BLOCKED
if echo '{"tool_name": "Task", "tool_input": {"prompt": "Run tests", "subagent_type": "rogue-agent"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/validate-phase-order.sh" 2>/dev/null; then
  fail "blocks unknown agent types" "exit 2" "exit 0"
else
  pass "blocks unknown agent types"
fi

# ============================================
# Test 16: advance-phase via dispatch
# ============================================
echo ""
echo "--- Test: advance-phase (via dispatch) ---"

cd "$TEST_DIR"
mkdir -p /tmp/claude-subagents

# brainstorm → specify
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_phase": "init",
  "phase_artifacts": {},
  "skipped_phases": [],
  "current_wave": null,
  "tasks": []
}
EOF

mkdir -p "$TEST_DIR/.claude/specs/test-feature"
echo "# Brainstorm" > "$TEST_DIR/.claude/specs/test-feature/brainstorm.md"

echo "$TEST_DIR/.claude/state/active_task_graph.json" > /tmp/claude-subagents/advance-test-session.task_graph

echo '{"session_id": "advance-test-session", "agent_type": "brainstorm-agent", "agent_transcript_path": "/tmp/fake-transcript.jsonl"}' | \
  bash "$DISPATCH" 2>&1

NEW_PHASE=$(jq -r '.current_phase' "$TEST_DIR/.claude/state/active_task_graph.json")
BRAINSTORM_ARTIFACT=$(jq -r '.phase_artifacts.brainstorm // "missing"' "$TEST_DIR/.claude/state/active_task_graph.json")

[[ "$NEW_PHASE" == "specify" ]] && pass "brainstorm → specify" || fail "brainstorm → specify" "specify" "$NEW_PHASE"
[[ "$BRAINSTORM_ARTIFACT" == *"brainstorm.md" ]] && pass "sets brainstorm artifact" || fail "sets brainstorm artifact" "*brainstorm.md" "$BRAINSTORM_ARTIFACT"

# specify → architecture (markers <= 3, auto-skip clarify)
cat > "$TEST_DIR/.claude/specs/test-feature/spec.md" << 'EOF'
# Spec
[NEEDS CLARIFICATION]: One marker only
EOF

reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_phase": "specify",
  "phase_artifacts": {"brainstorm": "completed"},
  "skipped_phases": [],
  "spec_file": ".claude/specs/test-feature/spec.md",
  "current_wave": null,
  "tasks": []
}
EOF

echo "$TEST_DIR/.claude/state/active_task_graph.json" > /tmp/claude-subagents/advance-test-session.task_graph

echo '{"session_id": "advance-test-session", "agent_type": "specify-agent", "agent_transcript_path": "/tmp/fake-transcript.jsonl"}' | \
  bash "$DISPATCH" 2>&1

NEW_PHASE=$(jq -r '.current_phase' "$TEST_DIR/.claude/state/active_task_graph.json")
SKIPPED=$(jq -r '.skipped_phases | join(",")' "$TEST_DIR/.claude/state/active_task_graph.json")

[[ "$NEW_PHASE" == "architecture" ]] && pass "specify → architecture (markers <= 3)" || fail "specify → architecture" "architecture" "$NEW_PHASE"
[[ "$SKIPPED" == *"clarify"* ]] && pass "auto-skips clarify" || fail "auto-skips clarify" "contains clarify" "$SKIPPED"

# specify → clarify (many markers)
cat > "$TEST_DIR/.claude/specs/test-feature/spec.md" << 'EOF'
# Spec
[NEEDS CLARIFICATION]: One
[NEEDS CLARIFICATION]: Two
[NEEDS CLARIFICATION]: Three
[NEEDS CLARIFICATION]: Four
[NEEDS CLARIFICATION]: Five
EOF

reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_phase": "specify",
  "phase_artifacts": {"brainstorm": "completed"},
  "skipped_phases": [],
  "spec_file": ".claude/specs/test-feature/spec.md",
  "current_wave": null,
  "tasks": []
}
EOF

echo "$TEST_DIR/.claude/state/active_task_graph.json" > /tmp/claude-subagents/advance-test-session.task_graph

echo '{"session_id": "advance-test-session", "agent_type": "specify-agent", "agent_transcript_path": "/tmp/fake-transcript.jsonl"}' | \
  bash "$DISPATCH" 2>&1

NEW_PHASE=$(jq -r '.current_phase' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$NEW_PHASE" == "clarify" ]] && pass "specify → clarify (markers > 3)" || fail "specify → clarify" "clarify" "$NEW_PHASE"

# Non-phase agents don't advance
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_phase": "execute",
  "phase_artifacts": {},
  "skipped_phases": [],
  "current_wave": 1,
  "tasks": []
}
EOF

echo "$TEST_DIR/.claude/state/active_task_graph.json" > /tmp/claude-subagents/advance-test-session.task_graph

echo '{"session_id": "advance-test-session", "agent_type": "code-implementer-agent", "agent_transcript_path": "/tmp/fake-transcript.jsonl"}' | \
  bash "$DISPATCH" 2>&1

STILL_EXECUTE=$(jq -r '.current_phase' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$STILL_EXECUTE" == "execute" ]] && pass "impl agents don't advance phase" || fail "impl agents don't advance" "execute" "$STILL_EXECUTE"

rm -rf /tmp/claude-subagents

# ============================================
# Test 17: update-task-status remaining tasks + anti-spoofing (via dispatch)
# ============================================
echo ""
echo "--- Test: update-task-status remaining + anti-spoofing ---"

cd "$TEST_DIR"
mkdir -p /tmp/claude-subagents

# wave 1 with 3 tasks, one about to complete
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "pending", "agent": "code-implementer-agent"},
    {"id": "T2", "wave": 1, "status": "pending", "agent": "code-implementer-agent"},
    {"id": "T3", "wave": 1, "status": "pending", "agent": "code-implementer-agent"}
  ],
  "executing_tasks": [],
  "wave_gates": {"1": {"impl_complete": false}}
}
EOF

echo "$TEST_DIR/.claude/state/active_task_graph.json" > /tmp/claude-subagents/remaining-test.task_graph

# REAL Bash tool_use/tool_result (anti-spoof format)
cat > "$TEST_DIR/remaining-transcript.jsonl" << 'EOF'
{"message": {"content": "**Task ID:** T1\nImplemented successfully"}}
{"message": {"content": [{"type": "tool_use", "id": "tool_123", "name": "Bash", "input": {"command": "mvn test"}}]}}
{"message": {"content": [{"type": "tool_result", "tool_use_id": "tool_123", "content": "BUILD SUCCESS\nTests run: 5, Failures: 0, Errors: 0"}]}}
EOF

echo '{"session_id": "remaining-test", "agent_type": "code-implementer-agent", "agent_transcript_path": "'"$TEST_DIR"'/remaining-transcript.jsonl"}' | \
  bash "$DISPATCH" 2>&1

T1_PASSED=$(jq -r '.tasks[] | select(.id=="T1") | .tests_passed' "$TEST_DIR/.claude/state/active_task_graph.json")
T1_EVIDENCE=$(jq -r '.tasks[] | select(.id=="T1") | .test_evidence' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$T1_PASSED" == "true" ]] && pass "tests_passed from real Bash output" || fail "tests_passed" "true" "$T1_PASSED"
[[ "$T1_EVIDENCE" == *"maven"* ]] && pass "maven evidence extracted" || fail "maven evidence" "contains maven" "$T1_EVIDENCE"

# ANTI-SPOOFING: text-only "BUILD SUCCESS" → tests_passed=false
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "pending", "agent": "code-implementer-agent"}
  ],
  "executing_tasks": [],
  "wave_gates": {"1": {"impl_complete": false}}
}
EOF

echo "$TEST_DIR/.claude/state/active_task_graph.json" > /tmp/claude-subagents/spoof-test.task_graph

cat > "$TEST_DIR/spoof-transcript.jsonl" << 'EOF'
{"message": {"content": "**Task ID:** T1\nI ran the tests and they passed.\nBUILD SUCCESS\nTests run: 5, Failures: 0, Errors: 0\nAll good!"}}
EOF

echo '{"session_id": "spoof-test", "agent_type": "code-implementer-agent", "agent_transcript_path": "'"$TEST_DIR"'/spoof-transcript.jsonl"}' | \
  bash "$DISPATCH" 2>&1 >/dev/null

SPOOF_PASSED=$(jq -r '.tasks[] | select(.id=="T1") | .tests_passed' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$SPOOF_PASSED" == "false" ]] && pass "ANTI-SPOOF: text-only BUILD SUCCESS → tests_passed=false" || fail "ANTI-SPOOF: text-only" "false" "$SPOOF_PASSED"

rm -rf /tmp/claude-subagents

# ============================================
# Test 18: validate-task-execution.sh non-git graceful handling
# ============================================
echo ""
echo "--- Test: validate-task-execution.sh non-git ---"

NON_GIT_DIR=$(mktemp -d)
mkdir -p "$NON_GIT_DIR/.claude/state"

cat > "$NON_GIT_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "pending", "depends_on": []}
  ],
  "wave_gates": {"1": {"impl_complete": false}}
}
EOF

if (cd "$NON_GIT_DIR" && echo '{"tool_name": "Task", "tool_input": {"prompt": "**Task ID:** T1\nImplement feature"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/validate-task-execution.sh" 2>&1); then
  pass "works in non-git repos"
else
  fail "works in non-git repos" "exit 0" "exit non-zero"
fi

NO_SHA=$(jq -r '.tasks[] | select(.id=="T1") | .start_sha // "missing"' "$NON_GIT_DIR/.claude/state/active_task_graph.json")
[[ "$NO_SHA" == "missing" ]] && pass "skips SHA in non-git" || fail "skips SHA in non-git" "missing" "$NO_SHA"

rm -rf "$NON_GIT_DIR"
cd "$TEST_DIR"

# ============================================
# Test 19: populate-task-graph helper
# ============================================
echo ""
echo "--- Test: populate-task-graph helper ---"

cd "$TEST_DIR"
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_phase": "execute",
  "phase_artifacts": {"brainstorm": "completed", "specify": "spec.md", "architecture": "plan.md"},
  "skipped_phases": [],
  "spec_file": "spec.md",
  "plan_file": "plan.md"
}
EOF

echo '{
  "plan_title": "Test Feature",
  "plan_file": "plan.md",
  "spec_file": "spec.md",
  "tasks": [
    {"id": "T1", "description": "First task", "wave": 1, "agent": "code-implementer-agent", "depends_on": []},
    {"id": "T2", "description": "Second task", "wave": 1, "agent": "code-implementer-agent", "depends_on": []},
    {"id": "T3", "description": "Third task", "wave": 2, "agent": "code-implementer-agent", "depends_on": ["T1"]}
  ]
}' | bun "$CLI" helper populate-task-graph --issue 42 --repo owner/repo 2>/dev/null

TASK_COUNT=$(jq '.tasks | length' "$TEST_DIR/.claude/state/active_task_graph.json")
CURRENT_WAVE=$(jq -r '.current_wave' "$TEST_DIR/.claude/state/active_task_graph.json")
ISSUE=$(jq -r '.github_issue' "$TEST_DIR/.claude/state/active_task_graph.json")
REPO=$(jq -r '.github_repo' "$TEST_DIR/.claude/state/active_task_graph.json")
PHASE=$(jq -r '.current_phase' "$TEST_DIR/.claude/state/active_task_graph.json")
WAVE1_GATE=$(jq -r '.wave_gates["1"].impl_complete' "$TEST_DIR/.claude/state/active_task_graph.json")
WAVE2_GATE=$(jq -r '.wave_gates["2"].impl_complete' "$TEST_DIR/.claude/state/active_task_graph.json")

[[ "$TASK_COUNT" == "3" ]] && pass "3 tasks merged" || fail "task count" "3" "$TASK_COUNT"
[[ "$CURRENT_WAVE" == "1" ]] && pass "current_wave=1" || fail "wave" "1" "$CURRENT_WAVE"
[[ "$ISSUE" == "42" ]] && pass "github_issue set" || fail "issue" "42" "$ISSUE"
[[ "$REPO" == "owner/repo" ]] && pass "github_repo set" || fail "repo" "owner/repo" "$REPO"
[[ "$PHASE" == "execute" ]] && pass "preserves current_phase" || fail "phase preserved" "execute" "$PHASE"
[[ "$WAVE1_GATE" == "false" ]] && pass "initializes wave 1 gate" || fail "wave 1 gate" "false" "$WAVE1_GATE"
[[ "$WAVE2_GATE" == "false" ]] && pass "initializes wave 2 gate" || fail "wave 2 gate" "false" "$WAVE2_GATE"

# ============================================
# Test 20: validate-task-graph keywords helper
# ============================================
echo ""
echo "--- Test: validate-task-graph new_tests_required keywords ---"

# Task with new_tests_required=false + config description → no warning
VALID_JSON='{
  "plan_title": "Test",
  "plan_file": "plan.md",
  "spec_file": "spec.md",
  "tasks": [{"id": "T1", "description": "Update config for new env", "wave": 1, "agent": "code-implementer-agent", "depends_on": [], "new_tests_required": false}]
}'

VALID_OUTPUT=$(echo "$VALID_JSON" | bun "$CLI" helper validate-task-graph 2>&1)
! echo "$VALID_OUTPUT" | grep -q "WARNING" && pass "no warning for config task + tests=false" || fail "config no warning" "no WARNING" "$VALID_OUTPUT"

# Task with new_tests_required=false + implementation description → WARNING
SUSPICIOUS_JSON='{
  "plan_title": "Test",
  "plan_file": "plan.md",
  "spec_file": "spec.md",
  "tasks": [{"id": "T1", "description": "Implement user authentication with JWT", "wave": 1, "agent": "code-implementer-agent", "depends_on": [], "new_tests_required": false}]
}'

SUSPICIOUS_OUTPUT=$(echo "$SUSPICIOUS_JSON" | bun "$CLI" helper validate-task-graph 2>&1)
echo "$SUSPICIOUS_OUTPUT" | grep -q "WARNING" && pass "warns for impl task + tests=false" || fail "impl warning" "contains WARNING" "$SUSPICIOUS_OUTPUT"

# Still valid (warning ≠ error) — exit code should be 0
echo "$SUSPICIOUS_JSON" | bun "$CLI" helper validate-task-graph >/dev/null 2>&1
[[ $? -eq 0 ]] && pass "warning doesn't fail validation" || fail "warning not error" "exit 0" "exit $?"

# ============================================
# Test 21: store-reviewer-findings Machine Summary (via dispatch)
# ============================================
echo ""
echo "--- Test: store-reviewer-findings Machine Summary ---"

cd "$TEST_DIR"
mkdir -p /tmp/claude-subagents

reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "implemented", "review_status": "pending", "critical_findings": [], "advisory_findings": []}
  ],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": true, "reviews_complete": false, "blocked": false}}
}
EOF

echo "$TEST_DIR/.claude/state/active_task_graph.json" > /tmp/claude-subagents/review-summary-test.task_graph

# Transcript with Machine Summary block
cat > "$TEST_DIR/review-summary-transcript.jsonl" << 'EOF'
{"message": {"content": "**Task ID:** T1\n# PR Review Summary\n## Critical Issues\n- SQL injection in query builder\n## Suggestions\n- Consider logging\n\n### Machine Summary\nCRITICAL_COUNT: 1\nADVISORY_COUNT: 1\nCRITICAL: SQL injection in query builder\nADVISORY: Consider logging"}}
EOF

echo '{"session_id": "review-summary-test", "agent_type": "code-reviewer", "agent_transcript_path": "'"$TEST_DIR"'/review-summary-transcript.jsonl"}' | \
  bash "$DISPATCH" 2>&1 >/dev/null

MS_CRITICAL=$(jq '[.tasks[] | select(.id=="T1") | .critical_findings | length] | add' "$TEST_DIR/.claude/state/active_task_graph.json")
MS_ADVISORY=$(jq '[.tasks[] | select(.id=="T1") | .advisory_findings | length] | add' "$TEST_DIR/.claude/state/active_task_graph.json")
MS_STATUS=$(jq -r '.tasks[] | select(.id=="T1") | .review_status' "$TEST_DIR/.claude/state/active_task_graph.json")

[[ "$MS_CRITICAL" == "1" ]] && pass "Machine Summary: 1 critical finding" || fail "Machine Summary: critical count" "1" "$MS_CRITICAL"
[[ "$MS_ADVISORY" == "1" ]] && pass "Machine Summary: 1 advisory finding" || fail "Machine Summary: advisory count" "1" "$MS_ADVISORY"
[[ "$MS_STATUS" == "blocked" ]] && pass "Machine Summary: review_status=blocked" || fail "Machine Summary: status" "blocked" "$MS_STATUS"

# CRITICAL_COUNT: 0 → passed
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "implemented", "review_status": "pending", "critical_findings": [], "advisory_findings": []}
  ],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": true, "reviews_complete": false, "blocked": false}}
}
EOF

echo "$TEST_DIR/.claude/state/active_task_graph.json" > /tmp/claude-subagents/review-pass-test.task_graph

cat > "$TEST_DIR/review-pass-transcript.jsonl" << 'EOF'
{"message": {"content": "**Task ID:** T1\n# PR Review Summary\nNo issues found.\n\n### Machine Summary\nCRITICAL_COUNT: 0\nADVISORY_COUNT: 0"}}
EOF

echo '{"session_id": "review-pass-test", "agent_type": "code-reviewer", "agent_transcript_path": "'"$TEST_DIR"'/review-pass-transcript.jsonl"}' | \
  bash "$DISPATCH" 2>&1 >/dev/null

PASS_STATUS=$(jq -r '.tasks[] | select(.id=="T1") | .review_status' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$PASS_STATUS" == "passed" ]] && pass "Machine Summary: CRITICAL_COUNT:0 → passed" || fail "Machine Summary: pass status" "passed" "$PASS_STATUS"

rm -rf /tmp/claude-subagents

# ============================================
# Test 22: dispatch.sh routing
# ============================================
echo ""
echo "--- Test: dispatch.sh routing ---"

cd "$TEST_DIR"
mkdir -p /tmp/claude-subagents

# Setup for brainstorm → advance-phase
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_phase": "init",
  "phase_artifacts": {},
  "skipped_phases": [],
  "current_wave": null,
  "tasks": []
}
EOF

mkdir -p "$TEST_DIR/.claude/specs/test-feature"
echo "# Brainstorm" > "$TEST_DIR/.claude/specs/test-feature/brainstorm.md"

echo "$TEST_DIR/.claude/state/active_task_graph.json" > /tmp/claude-subagents/dispatch-test.task_graph

echo '{"session_id": "dispatch-test", "agent_type": "brainstorm-agent", "agent_transcript_path": "/tmp/fake.jsonl"}' | \
  bash "$DISPATCH" 2>&1 >/dev/null

DISPATCH_PHASE=$(jq -r '.current_phase' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$DISPATCH_PHASE" == "specify" ]] && pass "dispatch: routes brainstorm → advance-phase" || fail "dispatch: brainstorm" "specify" "$DISPATCH_PHASE"

# impl agent → update-task-status
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_phase": "execute",
  "phase_artifacts": {},
  "skipped_phases": [],
  "current_wave": 1,
  "tasks": [{"id": "T1", "wave": 1, "status": "pending", "agent": "code-implementer-agent"}],
  "executing_tasks": [],
  "wave_gates": {"1": {"impl_complete": false}}
}
EOF

echo "$TEST_DIR/.claude/state/active_task_graph.json" > /tmp/claude-subagents/dispatch-impl-test.task_graph

cat > "$TEST_DIR/dispatch-impl-transcript.jsonl" << 'EOF'
{"message": {"content": "**Task ID:** T1\nDone"}}
EOF

echo '{"session_id": "dispatch-impl-test", "agent_type": "code-implementer-agent", "agent_transcript_path": "'"$TEST_DIR"'/dispatch-impl-transcript.jsonl"}' | \
  bash "$DISPATCH" 2>&1 >/dev/null

DISPATCH_STATUS=$(jq -r '.tasks[] | select(.id=="T1") | .status' "$TEST_DIR/.claude/state/active_task_graph.json")
DISPATCH_PHASE2=$(jq -r '.current_phase' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$DISPATCH_STATUS" == "implemented" ]] && pass "dispatch: routes impl → update-task-status" || fail "dispatch: impl routing" "implemented" "$DISPATCH_STATUS"
[[ "$DISPATCH_PHASE2" == "execute" ]] && pass "dispatch: impl doesn't trigger advance-phase" || fail "dispatch: no advance" "execute" "$DISPATCH_PHASE2"

# Unknown agent type → cleanup only
echo '{"session_id": "dispatch-test", "agent_id": "agent-unknown", "agent_type": "general-purpose"}' | \
  bash "$DISPATCH" 2>&1 >/dev/null
pass "dispatch: handles unknown agent type gracefully"

rm -rf /tmp/claude-subagents

# ============================================
# Summary
# ============================================
echo ""
echo "==================================="
echo -e "Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
echo "==================================="

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
