#!/bin/bash
# Tests for validate-template-substitution.sh PreToolUse hook
# Run: bash .claude/tests/test-validate-template-substitution.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../hooks/PreToolUse/validate-template-substitution.sh"
TEST_DIR=$(mktemp -d)
TASK_GRAPH="$TEST_DIR/.claude/state/active_task_graph.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

TESTS_RUN=0
TESTS_PASSED=0

setup() {
  mkdir -p "$TEST_DIR/.claude/state"
  echo '{"current_phase":"execute"}' > "$TASK_GRAPH"
  cd "$TEST_DIR"
}

teardown() {
  rm -rf "$TEST_DIR"
}

assert_exit() {
  local expected=$1
  local actual=$2
  local name=$3
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$expected" == "$actual" ]]; then
    echo -e "${GREEN}✓${NC} $name"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  else
    echo -e "${RED}✗${NC} $name (expected exit $expected, got $actual)"
  fi
}

assert_stderr_contains() {
  local pattern=$1
  local stderr=$2
  local name=$3
  TESTS_RUN=$((TESTS_RUN + 1))
  if echo "$stderr" | grep -q "$pattern"; then
    echo -e "${GREEN}✓${NC} $name"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  else
    echo -e "${RED}✗${NC} $name (stderr does not contain '$pattern')"
    echo "  stderr was: $stderr"
  fi
}

# ===== TEST CASES =====

test_allows_when_no_task_graph() {
  rm -f "$TASK_GRAPH"
  local input='{"tool_name":"Task","tool_input":{"prompt":"test {unsubstituted}"}}'
  local exit_code
  echo "$input" | bash "$HOOK" >/dev/null 2>&1 && exit_code=0 || exit_code=$?
  assert_exit 0 "$exit_code" "allows when no task graph exists"
  setup  # Restore for next test
}

test_allows_non_task_tools() {
  local input='{"tool_name":"Bash","tool_input":{"command":"echo {variable}"}}'
  local exit_code
  echo "$input" | bash "$HOOK" >/dev/null 2>&1 && exit_code=0 || exit_code=$?
  assert_exit 0 "$exit_code" "allows non-Task tools"
}

test_allows_substituted_prompt() {
  local input='{"tool_name":"Task","tool_input":{"prompt":"Implement the auth feature at /project/src/auth.ts"}}'
  local exit_code
  echo "$input" | bash "$HOOK" >/dev/null 2>&1 && exit_code=0 || exit_code=$?
  assert_exit 0 "$exit_code" "allows fully substituted prompts"
}

test_blocks_unsubstituted_variable() {
  local input='{"tool_name":"Task","tool_input":{"prompt":"Implement feature at {spec_file_path}"}}'
  local exit_code stderr
  stderr=$(echo "$input" | bash "$HOOK" 2>&1 >/dev/null) && exit_code=0 || exit_code=$?
  assert_exit 2 "$exit_code" "blocks unsubstituted {spec_file_path}"
  assert_stderr_contains "spec_file_path" "$stderr" "error message mentions variable"
}

test_blocks_multiple_unsubstituted() {
  local input='{"tool_name":"Task","tool_input":{"prompt":"Task {task_id} in wave {wave} for {feature_description}"}}'
  local exit_code stderr
  stderr=$(echo "$input" | bash "$HOOK" 2>&1 >/dev/null) && exit_code=0 || exit_code=$?
  assert_exit 2 "$exit_code" "blocks multiple unsubstituted variables"
  assert_stderr_contains "task_id" "$stderr" "error mentions task_id"
}

test_allows_json_braces() {
  # JSON-like content should not trigger false positives
  local input='{"tool_name":"Task","tool_input":{"prompt":"Parse this JSON: {\"key\": \"value\"}"}}'
  local exit_code
  echo "$input" | bash "$HOOK" >/dev/null 2>&1 && exit_code=0 || exit_code=$?
  assert_exit 0 "$exit_code" "allows JSON braces (not template variables)"
}

test_allows_shell_expansions() {
  # Shell ${var} syntax should not match {var} pattern
  local input='{"tool_name":"Task","tool_input":{"prompt":"Run echo ${HOME} command"}}'
  local exit_code
  echo "$input" | bash "$HOOK" >/dev/null 2>&1 && exit_code=0 || exit_code=$?
  assert_exit 0 "$exit_code" "allows shell \${var} expansions"
}

test_allows_regex_quantifiers() {
  # Regex {n,m} should not match
  local input='{"tool_name":"Task","tool_input":{"prompt":"Match pattern [a-z]{3,5} in regex"}}'
  local exit_code
  echo "$input" | bash "$HOOK" >/dev/null 2>&1 && exit_code=0 || exit_code=$?
  assert_exit 0 "$exit_code" "allows regex quantifiers {n,m}"
}

test_allows_empty_prompt() {
  local input='{"tool_name":"Task","tool_input":{"prompt":""}}'
  local exit_code
  echo "$input" | bash "$HOOK" >/dev/null 2>&1 && exit_code=0 || exit_code=$?
  assert_exit 0 "$exit_code" "allows empty prompt"
}

test_allows_missing_prompt() {
  local input='{"tool_name":"Task","tool_input":{"description":"do something"}}'
  local exit_code
  echo "$input" | bash "$HOOK" >/dev/null 2>&1 && exit_code=0 || exit_code=$?
  assert_exit 0 "$exit_code" "allows missing prompt field"
}

test_real_loom_template_unsubstituted() {
  # Simulate real loom template with unsubstituted variables
  local input='{"tool_name":"Task","tool_input":{"prompt":"## Specify: {feature_description}\n\n**Brainstorm output:** Read `.claude/specs/{date_slug}/brainstorm.md`\n\nCreate formal specification.\n\n**Output location:** `.claude/specs/{date_slug}/spec.md`"}}'
  local exit_code stderr
  stderr=$(echo "$input" | bash "$HOOK" 2>&1 >/dev/null) && exit_code=0 || exit_code=$?
  assert_exit 2 "$exit_code" "blocks real loom template with unsubstituted vars"
  assert_stderr_contains "feature_description" "$stderr" "detects feature_description"
}

test_real_loom_template_substituted() {
  # Same template but properly substituted
  local input='{"tool_name":"Task","tool_input":{"prompt":"## Specify: Add user authentication\n\nSelected approach: JWT-based auth\n\nCreate formal specification.\n\n**Output location:** `.claude/specs/2025-01-15-user-auth/spec.md`"}}'
  local exit_code
  echo "$input" | bash "$HOOK" >/dev/null 2>&1 && exit_code=0 || exit_code=$?
  assert_exit 0 "$exit_code" "allows properly substituted loom template"
}

# ===== RUN TESTS =====

echo "Testing validate-template-substitution.sh"
echo "========================================="
echo ""

setup

test_allows_when_no_task_graph
test_allows_non_task_tools
test_allows_substituted_prompt
test_blocks_unsubstituted_variable
test_blocks_multiple_unsubstituted
test_allows_json_braces
test_allows_shell_expansions
test_allows_regex_quantifiers
test_allows_empty_prompt
test_allows_missing_prompt
test_real_loom_template_unsubstituted
test_real_loom_template_substituted

teardown

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
