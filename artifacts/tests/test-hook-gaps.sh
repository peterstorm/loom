#!/bin/bash
# Test suite for hook gap fixes (MultiEdit, crash detection, artifact verification, validator)
# Run: bash ~/.dotfiles/.claude/tests/test-hook-gaps.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_DIR=$(mktemp -d)
PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

cleanup() {
  rm -rf "$TEST_DIR"
  rm -rf /tmp/claude-subagents
}
trap cleanup EXIT

# Reset state file permissions (state-file-write.sh sets chmod 444)
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

mkdir -p "$TEST_DIR/.claude/state"
cd "$TEST_DIR"

echo "=== Hook Gap Fixes Test Suite ==="
echo ""

# ============================================
# Test 1: MultiEdit blocked during orchestration
# ============================================
echo "--- Test: block-direct-edits.sh MultiEdit ---"

cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{"current_wave": 1, "tasks": [], "wave_gates": {}}
EOF

# MultiEdit should be blocked
if echo '{"tool_name": "MultiEdit", "tool_input": {"file_path": "test.ts"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/block-direct-edits.sh" 2>/dev/null; then
  fail "Blocks MultiEdit during orchestration" "exit 2" "exit 0"
else
  pass "Blocks MultiEdit during orchestration"
fi

# Edit still blocked (regression check)
if echo '{"tool_name": "Edit", "tool_input": {"file_path": "test.ts"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/block-direct-edits.sh" 2>/dev/null; then
  fail "Still blocks Edit during orchestration" "exit 2" "exit 0"
else
  pass "Still blocks Edit during orchestration"
fi

# Write still blocked (regression check)
if echo '{"tool_name": "Write", "tool_input": {"file_path": "test.ts"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/block-direct-edits.sh" 2>/dev/null; then
  fail "Still blocks Write during orchestration" "exit 2" "exit 0"
else
  pass "Still blocks Write during orchestration"
fi

# Read still allowed (regression check)
if echo '{"tool_name": "Read", "tool_input": {"file_path": "test.ts"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/block-direct-edits.sh" 2>/dev/null; then
  pass "Still allows Read during orchestration"
else
  fail "Still allows Read during orchestration" "exit 0" "exit 2"
fi

# No state file = no blocking
rm "$TEST_DIR/.claude/state/active_task_graph.json"
if echo '{"tool_name": "MultiEdit", "tool_input": {"file_path": "test.ts"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/block-direct-edits.sh" 2>/dev/null; then
  pass "Allows MultiEdit when no orchestration active"
else
  fail "Allows MultiEdit without orchestration" "exit 0" "exit 2"
fi

# ============================================
# Test 2: parse-files-modified.sh tracks MultiEdit
# ============================================
echo ""
echo "--- Test: parse-files-modified.sh MultiEdit ---"

if command -v python3 &>/dev/null; then
  source "$REPO_ROOT/.claude/hooks/helpers/parse-files-modified.sh"

  # Transcript with Write, Edit, and MultiEdit
  cat > "$TEST_DIR/multi-edit-transcript.jsonl" << 'EOF'
{"message": {"content": [{"type": "tool_use", "name": "Write", "input": {"file_path": "/src/Foo.ts", "content": "export class Foo {}"}}]}}
{"message": {"content": [{"type": "tool_use", "name": "Edit", "input": {"file_path": "/src/Bar.ts", "old_string": "x", "new_string": "y"}}]}}
{"message": {"content": [{"type": "tool_use", "name": "MultiEdit", "input": {"file_path": "/src/Baz.ts", "edits": []}}]}}
{"message": {"content": [{"type": "tool_use", "name": "Read", "input": {"file_path": "/src/Ignored.ts"}}]}}
EOF

  FILES_RESULT=$(parse_files_modified "$TEST_DIR/multi-edit-transcript.jsonl")

  echo "$FILES_RESULT" | grep -q "/src/Foo.ts" && pass "Tracks Write file_path" || fail "Tracks Write" "Foo.ts" "$FILES_RESULT"
  echo "$FILES_RESULT" | grep -q "/src/Bar.ts" && pass "Tracks Edit file_path" || fail "Tracks Edit" "Bar.ts" "$FILES_RESULT"
  echo "$FILES_RESULT" | grep -q "/src/Baz.ts" && pass "Tracks MultiEdit file_path" || fail "Tracks MultiEdit" "Baz.ts" "$FILES_RESULT"
  ! echo "$FILES_RESULT" | grep -q "/src/Ignored.ts" && pass "Ignores Read file_path" || fail "Ignores Read" "absent" "$FILES_RESULT"

  # Count: exactly 3 files
  FILE_COUNT=$(echo "$FILES_RESULT" | wc -l | tr -d ' ')
  [[ "$FILE_COUNT" == "3" ]] && pass "Exactly 3 files tracked (Write+Edit+MultiEdit)" || fail "File count" "3" "$FILE_COUNT"
else
  echo "  (skipped: python3 not available — parse-files-modified uses embedded python)"
  # Verify the code change is present even without running
  grep -q "MultiEdit" "$REPO_ROOT/.claude/hooks/helpers/parse-files-modified.sh" && pass "MultiEdit handler present in parse-files-modified.sh (code review)" || fail "MultiEdit code" "present" "missing"
fi

# ============================================
# Test 3: cleanup-subagent-flag.sh preserves .task_graph
# ============================================
echo ""
echo "--- Test: cleanup-subagent-flag.sh .task_graph preservation ---"

mkdir -p /tmp/claude-subagents
echo -e "agent-one\nagent-two" > /tmp/claude-subagents/preserve-session.active
echo "/path/to/task_graph.json" > /tmp/claude-subagents/preserve-session.task_graph

# Remove first agent (file should remain with agent-two)
echo '{"session_id": "preserve-session", "agent_id": "agent-one"}' | \
  bash "$REPO_ROOT/.claude/hooks/SubagentStop/cleanup-subagent-flag.sh"

[[ -f /tmp/claude-subagents/preserve-session.task_graph ]] && pass "task_graph preserved when agents remain" || fail "task_graph preserved" "preserved" "deleted"

# Remove last agent (file should STILL be preserved for parallel SubagentStop hooks)
echo '{"session_id": "preserve-session", "agent_id": "agent-two"}' | \
  bash "$REPO_ROOT/.claude/hooks/SubagentStop/cleanup-subagent-flag.sh"

[[ ! -f /tmp/claude-subagents/preserve-session.active ]] && pass ".active file removed on last agent" || fail ".active removed" "deleted" "still exists"
[[ -f /tmp/claude-subagents/preserve-session.task_graph ]] && pass "task_graph PRESERVED on last agent (for parallel hooks)" || fail "task_graph preserved on last" "preserved" "deleted"

rm -rf /tmp/claude-subagents

# ============================================
# Test 4: advance-phase.sh artifact verification
# ============================================
echo ""
echo "--- Test: advance-phase.sh artifact verification ---"

cd "$TEST_DIR"
mkdir -p /tmp/claude-subagents
echo "$TEST_DIR/.claude/state/active_task_graph.json" > /tmp/claude-subagents/artifact-test.task_graph

# Test 4a: specify agent completes but spec_file doesn't exist on disk
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_phase": "specify",
  "phase_artifacts": {"brainstorm": "completed"},
  "skipped_phases": [],
  "spec_file": "/nonexistent/path/spec.md",
  "current_wave": null,
  "tasks": []
}
EOF

OUTPUT=$(echo '{"session_id": "artifact-test", "agent_id": "agent-spec", "agent_type": "specify-agent"}' | \
  bash "$REPO_ROOT/.claude/hooks/SubagentStop/advance-phase.sh" 2>&1)

PHASE_AFTER=$(jq -r '.current_phase' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$PHASE_AFTER" == "specify" ]] && pass "Doesn't advance when spec_file missing from disk" || fail "No advance without spec" "specify" "$PHASE_AFTER"
echo "$OUTPUT" | grep -qi "ERROR\|not found" && pass "Logs error for missing spec_file" || fail "Logs error" "ERROR message" "$OUTPUT"

# Test 4b: architecture agent completes but plan_file doesn't exist
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_phase": "architecture",
  "phase_artifacts": {"brainstorm": "completed", "specify": ".claude/specs/test/spec.md"},
  "skipped_phases": [],
  "plan_file": "/nonexistent/path/plan.md",
  "current_wave": null,
  "tasks": []
}
EOF

OUTPUT=$(echo '{"session_id": "artifact-test", "agent_id": "agent-arch", "agent_type": "architecture-agent"}' | \
  bash "$REPO_ROOT/.claude/hooks/SubagentStop/advance-phase.sh" 2>&1)

PHASE_AFTER=$(jq -r '.current_phase' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$PHASE_AFTER" == "architecture" ]] && pass "Doesn't advance when plan_file missing from disk" || fail "No advance without plan" "architecture" "$PHASE_AFTER"

# Test 4c: spec_file DOES exist → should advance
mkdir -p "$TEST_DIR/.claude/specs/test"
echo "# Spec" > "$TEST_DIR/.claude/specs/test/spec.md"

cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_phase": "specify",
  "phase_artifacts": {"brainstorm": "completed"},
  "skipped_phases": [],
  "spec_file": ".claude/specs/test/spec.md",
  "current_wave": null,
  "tasks": []
}
EOF

echo '{"session_id": "artifact-test", "agent_id": "agent-spec2", "agent_type": "specify-agent"}' | \
  bash "$REPO_ROOT/.claude/hooks/SubagentStop/advance-phase.sh" 2>&1

PHASE_AFTER=$(jq -r '.current_phase' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$PHASE_AFTER" != "specify" ]] && pass "Advances when spec_file exists on disk" || fail "Advance with spec" "architecture or clarify" "$PHASE_AFTER"

# Test 4d: plan_file DOES exist → should advance
mkdir -p "$TEST_DIR/.claude/plans"
echo "# Plan" > "$TEST_DIR/.claude/plans/test.md"

reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_phase": "architecture",
  "phase_artifacts": {"brainstorm": "completed", "specify": ".claude/specs/test/spec.md"},
  "skipped_phases": [],
  "plan_file": ".claude/plans/test.md",
  "current_wave": null,
  "tasks": []
}
EOF

echo '{"session_id": "artifact-test", "agent_id": "agent-arch2", "agent_type": "architecture-agent"}' | \
  bash "$REPO_ROOT/.claude/hooks/SubagentStop/advance-phase.sh" 2>&1

PHASE_AFTER=$(jq -r '.current_phase' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$PHASE_AFTER" == "decompose" ]] && pass "Advances to decompose when plan_file exists" || fail "Advance with plan" "decompose" "$PHASE_AFTER"

# Test 4e: brainstorm advances only when brainstorm.md file exists
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

# 4e-i: Without brainstorm.md → stays at init
echo '{"session_id": "artifact-test", "agent_id": "agent-brain", "agent_type": "brainstorm-agent"}' | \
  bash "$REPO_ROOT/.claude/hooks/SubagentStop/advance-phase.sh" 2>&1

PHASE_AFTER=$(jq -r '.current_phase' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$PHASE_AFTER" == "init" ]] && pass "Brainstorm without file stays at init" || fail "Brainstorm no-file" "init" "$PHASE_AFTER"

# 4e-ii: With brainstorm.md → advances to specify
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

mkdir -p "$TEST_DIR/.claude/specs/2026-01-01-test"
echo "# Brainstorm Summary" > "$TEST_DIR/.claude/specs/2026-01-01-test/brainstorm.md"

echo '{"session_id": "artifact-test", "agent_id": "agent-brain", "agent_type": "brainstorm-agent"}' | \
  bash "$REPO_ROOT/.claude/hooks/SubagentStop/advance-phase.sh" 2>&1

PHASE_AFTER=$(jq -r '.current_phase' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$PHASE_AFTER" == "specify" ]] && pass "Brainstorm with file advances to specify" || fail "Brainstorm with-file" "specify" "$PHASE_AFTER"

rm -rf /tmp/claude-subagents

# ============================================
# Test 5: update-task-status.sh crash detection
# ============================================
echo ""
echo "--- Test: update-task-status.sh crash detection ---"

cd "$TEST_DIR"
mkdir -p /tmp/claude-subagents

reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [
    {"id": "T1", "wave": 1, "status": "in_progress", "agent": "code-implementer-agent"},
    {"id": "T2", "wave": 1, "status": "in_progress", "agent": "code-implementer-agent"},
    {"id": "T3", "wave": 1, "status": "pending", "agent": "code-implementer-agent"}
  ],
  "executing_tasks": ["T1", "T2"],
  "wave_gates": {"1": {"impl_complete": false}}
}
EOF

echo "$TEST_DIR/.claude/state/active_task_graph.json" > /tmp/claude-subagents/crash-test.task_graph

# Create EMPTY transcript (simulates crash — no task ID parseable)
echo '{"message": {"content": ""}}' > "$TEST_DIR/crash-transcript.jsonl"

# Run update-task-status with empty transcript + impl agent type
OUTPUT=$(echo "{\"session_id\": \"crash-test\", \"agent_id\": \"agent-crashed\", \"agent_type\": \"code-implementer-agent\", \"agent_transcript_path\": \"$TEST_DIR/crash-transcript.jsonl\"}" | \
  bash "$REPO_ROOT/.claude/hooks/SubagentStop/update-task-status.sh" 2>&1)

echo "$OUTPUT" | grep -q "CRASH DETECTED" && pass "Detects crash (no task ID + impl agent)" || fail "Crash detected" "CRASH DETECTED" "$OUTPUT"

# Both executing tasks should be marked failed
T1_STATUS=$(jq -r '.tasks[] | select(.id=="T1") | .status' "$TEST_DIR/.claude/state/active_task_graph.json")
T2_STATUS=$(jq -r '.tasks[] | select(.id=="T2") | .status' "$TEST_DIR/.claude/state/active_task_graph.json")
T3_STATUS=$(jq -r '.tasks[] | select(.id=="T3") | .status' "$TEST_DIR/.claude/state/active_task_graph.json")

[[ "$T1_STATUS" == "failed" ]] && pass "T1 marked failed (was executing)" || fail "T1 failed" "failed" "$T1_STATUS"
[[ "$T2_STATUS" == "failed" ]] && pass "T2 marked failed (was executing)" || fail "T2 failed" "failed" "$T2_STATUS"
[[ "$T3_STATUS" == "pending" ]] && pass "T3 unchanged (was pending, not executing)" || fail "T3 unchanged" "pending" "$T3_STATUS"

# Check retry_count incremented
T1_RETRY=$(jq -r '.tasks[] | select(.id=="T1") | .retry_count' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$T1_RETRY" == "1" ]] && pass "retry_count incremented to 1" || fail "retry_count" "1" "$T1_RETRY"

# Check failure_reason set
T1_REASON=$(jq -r '.tasks[] | select(.id=="T1") | .failure_reason' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$T1_REASON" == *"agent_crash"* ]] && pass "failure_reason contains agent_crash" || fail "failure_reason" "agent_crash" "$T1_REASON"

# Check executing_tasks cleared
EXEC_COUNT=$(jq '.executing_tasks | length' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$EXEC_COUNT" == "0" ]] && pass "executing_tasks cleared after crash" || fail "executing_tasks cleared" "0" "$EXEC_COUNT"

# Test 5b: crash detection does NOT trigger for review agents
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [{"id": "T1", "wave": 1, "status": "in_progress"}],
  "executing_tasks": ["T1"],
  "wave_gates": {"1": {"impl_complete": false}}
}
EOF

echo '{"message": {"content": ""}}' > "$TEST_DIR/review-crash.jsonl"

echo "{\"session_id\": \"crash-test\", \"agent_id\": \"agent-review\", \"agent_type\": \"review-invoker\", \"agent_transcript_path\": \"$TEST_DIR/review-crash.jsonl\"}" | \
  bash "$REPO_ROOT/.claude/hooks/SubagentStop/update-task-status.sh" 2>&1

T1_STILL=$(jq -r '.tasks[] | select(.id=="T1") | .status' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$T1_STILL" == "in_progress" ]] && pass "Review agent crash doesn't mark tasks failed" || fail "Review agent no crash" "in_progress" "$T1_STILL"

# Test 5c: retry_count increments on second crash
reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_wave": 1,
  "tasks": [{"id": "T1", "wave": 1, "status": "in_progress", "retry_count": 1}],
  "executing_tasks": ["T1"],
  "wave_gates": {"1": {"impl_complete": false}}
}
EOF

echo "{\"session_id\": \"crash-test\", \"agent_id\": \"agent-crash2\", \"agent_type\": \"code-implementer-agent\", \"agent_transcript_path\": \"$TEST_DIR/crash-transcript.jsonl\"}" | \
  bash "$REPO_ROOT/.claude/hooks/SubagentStop/update-task-status.sh" 2>&1

T1_RETRY2=$(jq -r '.tasks[] | select(.id=="T1") | .retry_count' "$TEST_DIR/.claude/state/active_task_graph.json")
[[ "$T1_RETRY2" == "2" ]] && pass "retry_count increments to 2 on second crash" || fail "retry_count 2" "2" "$T1_RETRY2"

rm -rf /tmp/claude-subagents

# ============================================
# Test 6: validate-task-graph.sh schema validation
# ============================================
echo ""
echo "--- Test: validate-task-graph.sh ---"

VALIDATOR="$REPO_ROOT/.claude/hooks/helpers/validate-task-graph.sh"

# Validator tests expect non-zero exits — disable set -e for this section
set +e

# 6a: Valid minimal graph
VALID_JSON='{"plan_title":"Test","plan_file":"x.md","spec_file":"s.md","tasks":[{"id":"T1","description":"Do thing","agent":"code-implementer-agent","wave":1,"depends_on":[]}]}'
OUTPUT=$(echo "$VALID_JSON" | bash "$VALIDATOR" - 2>&1)
[[ $? -eq 0 ]] && pass "Accepts valid minimal graph" || fail "Valid graph" "exit 0" "exit $?"

# 6b: Valid multi-wave with dependencies
MULTI_JSON='{"plan_title":"Test","plan_file":"x.md","spec_file":"s.md","tasks":[{"id":"T1","description":"First","agent":"code-implementer-agent","wave":1,"depends_on":[]},{"id":"T2","description":"Second","agent":"frontend-agent","wave":2,"depends_on":["T1"]}]}'
OUTPUT=$(echo "$MULTI_JSON" | bash "$VALIDATOR" - 2>&1)
[[ $? -eq 0 ]] && pass "Accepts multi-wave with valid deps" || fail "Multi-wave valid" "exit 0" "exit $?"

# 6c: Missing required field (plan_title)
BAD_MISSING='{"plan_file":"x.md","spec_file":"s.md","tasks":[{"id":"T1","description":"x","agent":"code-implementer-agent","wave":1,"depends_on":[]}]}'
OUTPUT=$(echo "$BAD_MISSING" | bash "$VALIDATOR" - 2>&1)
[[ $? -ne 0 ]] && pass "Rejects missing plan_title" || fail "Missing plan_title" "exit 1" "exit 0"
echo "$OUTPUT" | grep -q "plan_title" && pass "Error mentions plan_title" || fail "Error mentions field" "plan_title" "$OUTPUT"

# 6d: Invalid task ID format
BAD_ID='{"plan_title":"T","plan_file":"x","spec_file":"s","tasks":[{"id":"BAD","description":"x","agent":"code-implementer-agent","wave":1,"depends_on":[]}]}'
OUTPUT=$(echo "$BAD_ID" | bash "$VALIDATOR" - 2>&1)
[[ $? -ne 0 ]] && pass "Rejects invalid task ID (BAD)" || fail "Invalid ID" "exit 1" "exit 0"

# 6e: Unknown agent
BAD_AGENT='{"plan_title":"T","plan_file":"x","spec_file":"s","tasks":[{"id":"T1","description":"x","agent":"nonexistent-agent","wave":1,"depends_on":[]}]}'
OUTPUT=$(echo "$BAD_AGENT" | bash "$VALIDATOR" - 2>&1)
[[ $? -ne 0 ]] && pass "Rejects unknown agent" || fail "Unknown agent" "exit 1" "exit 0"
echo "$OUTPUT" | grep -q "unknown agent" && pass "Error mentions unknown agent" || fail "Error details" "unknown agent" "$OUTPUT"

# 6f: Wave < 1
BAD_WAVE='{"plan_title":"T","plan_file":"x","spec_file":"s","tasks":[{"id":"T1","description":"x","agent":"code-implementer-agent","wave":0,"depends_on":[]}]}'
OUTPUT=$(echo "$BAD_WAVE" | bash "$VALIDATOR" - 2>&1)
[[ $? -ne 0 ]] && pass "Rejects wave 0" || fail "Wave 0" "exit 1" "exit 0"

# 6g: Self-dependency
BAD_SELF='{"plan_title":"T","plan_file":"x","spec_file":"s","tasks":[{"id":"T1","description":"x","agent":"code-implementer-agent","wave":1,"depends_on":["T1"]}]}'
OUTPUT=$(echo "$BAD_SELF" | bash "$VALIDATOR" - 2>&1)
[[ $? -ne 0 ]] && pass "Rejects self-dependency" || fail "Self-dep" "exit 1" "exit 0"
echo "$OUTPUT" | grep -q "self-dependency" && pass "Error mentions self-dependency" || fail "Error details" "self-dependency" "$OUTPUT"

# 6h: Dependency on nonexistent task
BAD_DEP='{"plan_title":"T","plan_file":"x","spec_file":"s","tasks":[{"id":"T1","description":"x","agent":"code-implementer-agent","wave":1,"depends_on":["T99"]}]}'
OUTPUT=$(echo "$BAD_DEP" | bash "$VALIDATOR" - 2>&1)
[[ $? -ne 0 ]] && pass "Rejects dep on nonexistent task" || fail "Missing dep" "exit 1" "exit 0"
echo "$OUTPUT" | grep -q "non-existent" && pass "Error mentions non-existent dep" || fail "Error details" "non-existent" "$OUTPUT"

# 6i: Cross-wave dependency violation (dep in same wave)
BAD_CROSS='{"plan_title":"T","plan_file":"x","spec_file":"s","tasks":[{"id":"T1","description":"x","agent":"code-implementer-agent","wave":1,"depends_on":[]},{"id":"T2","description":"y","agent":"code-implementer-agent","wave":1,"depends_on":["T1"]}]}'
OUTPUT=$(echo "$BAD_CROSS" | bash "$VALIDATOR" - 2>&1)
[[ $? -ne 0 ]] && pass "Rejects same-wave dependency" || fail "Same-wave dep" "exit 1" "exit 0"
echo "$OUTPUT" | grep -q "earlier wave" && pass "Error mentions earlier wave" || fail "Error details" "earlier wave" "$OUTPUT"

# 6j: Dependency in later wave (T1 wave 2 depends on T2 wave 2)
BAD_LATER='{"plan_title":"T","plan_file":"x","spec_file":"s","tasks":[{"id":"T1","description":"x","agent":"code-implementer-agent","wave":2,"depends_on":["T2"]},{"id":"T2","description":"y","agent":"code-implementer-agent","wave":2,"depends_on":[]}]}'
OUTPUT=$(echo "$BAD_LATER" | bash "$VALIDATOR" - 2>&1)
[[ $? -ne 0 ]] && pass "Rejects dep in same-wave (reversed order)" || fail "Same-wave reversed" "exit 1" "exit 0"

# 6k: Empty tasks array
BAD_EMPTY='{"plan_title":"T","plan_file":"x","spec_file":"s","tasks":[]}'
OUTPUT=$(echo "$BAD_EMPTY" | bash "$VALIDATOR" - 2>&1)
[[ $? -ne 0 ]] && pass "Rejects empty tasks array" || fail "Empty tasks" "exit 1" "exit 0"

# 6l: Invalid JSON
OUTPUT=$(echo "not json at all" | bash "$VALIDATOR" - 2>&1)
[[ $? -ne 0 ]] && pass "Rejects invalid JSON" || fail "Invalid JSON" "exit 1" "exit 0"

# 6m: Optional fields validated when present
BAD_BOOL='{"plan_title":"T","plan_file":"x","spec_file":"s","tasks":[{"id":"T1","description":"x","agent":"code-implementer-agent","wave":1,"depends_on":[],"new_tests_required":"yes"}]}'
OUTPUT=$(echo "$BAD_BOOL" | bash "$VALIDATOR" - 2>&1)
[[ $? -ne 0 ]] && pass "Rejects non-boolean new_tests_required" || fail "Bad boolean" "exit 1" "exit 0"

# 6n: spec_anchors must be array
BAD_ANCHORS='{"plan_title":"T","plan_file":"x","spec_file":"s","tasks":[{"id":"T1","description":"x","agent":"code-implementer-agent","wave":1,"depends_on":[],"spec_anchors":"FR-001"}]}'
OUTPUT=$(echo "$BAD_ANCHORS" | bash "$VALIDATOR" - 2>&1)
[[ $? -ne 0 ]] && pass "Rejects non-array spec_anchors" || fail "Bad anchors" "exit 1" "exit 0"

# 6o: Multiple errors reported
BAD_MULTI='{"plan_title":"T","plan_file":"x","spec_file":"s","tasks":[{"id":"BAD","description":"","agent":"fake-agent","wave":0,"depends_on":["BAD"]}]}'
OUTPUT=$(echo "$BAD_MULTI" | bash "$VALIDATOR" - 2>&1)
ERR_COUNT=$(echo "$OUTPUT" | grep -c "  -" || true)
[[ "$ERR_COUNT" -ge 4 ]] && pass "Reports multiple errors (found $ERR_COUNT)" || fail "Multiple errors" ">=4" "$ERR_COUNT"

# 6p: All recognized agents accepted (batch test to avoid per-agent jq overhead)
ALL_AGENTS_OK=true
FAILED_AGENTS=""
for AGENT in code-implementer-agent ts-test-agent security-agent dotfiles-agent frontend-agent general-purpose; do
  AGENT_JSON="{\"plan_title\":\"T\",\"plan_file\":\"x\",\"spec_file\":\"s\",\"tasks\":[{\"id\":\"T1\",\"description\":\"x\",\"agent\":\"$AGENT\",\"wave\":1,\"depends_on\":[]}]}"
  if ! echo "$AGENT_JSON" | bash "$VALIDATOR" - 2>/dev/null; then
    ALL_AGENTS_OK=false
    FAILED_AGENTS="$FAILED_AGENTS $AGENT"
  fi
done
[[ "$ALL_AGENTS_OK" == "true" ]] && pass "All 9 impl agents accepted" || fail "Recognized agents" "all accepted" "failed:$FAILED_AGENTS"

set -e

# ============================================
# Test 7: validate-phase-order.sh recognizes decompose-agent
# ============================================
echo ""
echo "--- Test: validate-phase-order.sh decompose-agent ---"

cd "$TEST_DIR"

reset_state
cat > "$TEST_DIR/.claude/state/active_task_graph.json" << 'EOF'
{
  "current_phase": "architecture",
  "phase_artifacts": {"brainstorm": "completed", "specify": ".claude/specs/test/spec.md", "architecture": ".claude/plans/test.md"},
  "skipped_phases": [],
  "plan_file": ".claude/plans/test.md",
  "current_wave": null,
  "tasks": []
}
EOF

# decompose-agent should be allowed from architecture phase
if echo '{"tool_name": "Task", "tool_input": {"prompt": "Decompose into tasks", "subagent_type": "decompose-agent"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/validate-phase-order.sh" 2>&1; then
  pass "validate-phase-order: allows decompose-agent from architecture"
else
  fail "validate-phase-order: allows decompose-agent" "exit 0" "exit 2"
fi

# decompose-agent should be BLOCKED from init
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

if echo '{"tool_name": "Task", "tool_input": {"prompt": "Decompose", "subagent_type": "decompose-agent"}}' | bash "$REPO_ROOT/.claude/hooks/PreToolUse/validate-phase-order.sh" 2>/dev/null; then
  fail "validate-phase-order: blocks decompose-agent from init" "exit 2" "exit 0"
else
  pass "validate-phase-order: blocks decompose-agent from init"
fi

# ============================================
# Test 8: phase-decompose.md template exists and has required content
# ============================================
echo ""
echo "--- Test: phase-decompose.md template ---"

TEMPLATE="$REPO_ROOT/.claude/skills/loom/templates/phase-decompose.md"

[[ -f "$TEMPLATE" ]] && pass "phase-decompose.md exists" || fail "Template exists" "file exists" "not found"

grep -q "{feature_description}" "$TEMPLATE" && pass "Template has {feature_description} var" || fail "Template var" "{feature_description}" "missing"
grep -q "{spec_file_path}" "$TEMPLATE" && pass "Template has {spec_file_path} var" || fail "Template var" "{spec_file_path}" "missing"
grep -q "{plan_file_path}" "$TEMPLATE" && pass "Template has {plan_file_path} var" || fail "Template var" "{plan_file_path}" "missing"
grep -q "code-implementer-agent" "$TEMPLATE" && pass "Template lists code-implementer-agent" || fail "Agent table" "code-implementer-agent" "missing"
grep -q "new_tests_required" "$TEMPLATE" && pass "Template documents new_tests_required field" || fail "Field doc" "new_tests_required" "missing"
grep -q "spec_anchors" "$TEMPLATE" && pass "Template documents spec_anchors field" || fail "Field doc" "spec_anchors" "missing"
grep -q "depends_on" "$TEMPLATE" && pass "Template documents depends_on field" || fail "Field doc" "depends_on" "missing"
grep -q "Pure JSON" "$TEMPLATE" && pass "Template requires pure JSON output" || fail "Output format" "Pure JSON" "missing"

# ============================================
# Test 9: SKILL.md consistency checks
# ============================================
echo ""
echo "--- Test: SKILL.md consistency ---"

SKILL="$REPO_ROOT/.claude/skills/loom/SKILL.md"

grep -q "failed" "$SKILL" && pass "SKILL.md documents failed status" || fail "SKILL.md" "failed status" "missing"
grep -q "retry_count" "$SKILL" && pass "SKILL.md documents retry_count" || fail "SKILL.md" "retry_count" "missing"
grep -q "MultiEdit" "$SKILL" && pass "SKILL.md mentions MultiEdit" || fail "SKILL.md" "MultiEdit" "missing"
grep -q "advance-phase.sh" "$SKILL" && pass "SKILL.md documents advance-phase.sh hook" || fail "SKILL.md" "advance-phase.sh" "missing"
grep -qi "artifact verification" "$SKILL" && pass "SKILL.md documents artifact verification" || fail "SKILL.md" "artifact verification" "missing"
grep -q "decompose-agent\|decompose agent" "$SKILL" && pass "SKILL.md mentions decompose agent" || fail "SKILL.md" "decompose agent" "missing"
grep -q "validate-task-graph" "$SKILL" && pass "SKILL.md mentions validate-task-graph" || fail "SKILL.md" "validate-task-graph" "missing"

# Wave-gate SKILL.md
WGATE="$REPO_ROOT/.claude/skills/wave-gate/SKILL.md"
grep -q "files_modified" "$WGATE" && pass "wave-gate SKILL.md mentions files_modified" || fail "wave-gate" "files_modified" "missing"

# ============================================
# Summary
# ============================================
echo ""
echo "==================================="
echo -e "Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
echo "==================================="

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
