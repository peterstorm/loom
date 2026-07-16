#!/bin/bash
# ============================================================================
# Loom integration test suite — deterministic HELPERS + pure SHIMS
# ============================================================================
# Ported from the pre-`engine/` `artifacts/tests/test-loom.sh` to the current
# repo layout. Drives the REAL production entry points exactly as Claude Code
# invokes them:
#   - helpers:  bun engine/src/cli.ts helper <name>
#   - shims:    hooks/scripts/<name>.sh  (which exec `bun engine/src/cli.ts …`)
#   - dispatch: hooks/scripts/dispatch.sh
#
# Complements:
#   - artifacts/tests/smoke-deterministic-core.sh (guard/lint/wave/phase gates)
#   - engine/tests (1500+ vitest cases — the pure-logic + evidence-ledger unit
#     suite; the evidence-model dispatch paths this file cannot exercise
#     without a live TestRun/report artifact live there).
#
# Schema note: engine/src/state-manager.ts parseTaskGraph is fail-closed — it
# REQUIRES `current_phase` (a PHASE_ORDER value) and `phase_artifacts` (object)
# on every task graph a helper/handler loads, plus each task must carry
# id/wave/depends_on/status. Every fixture below satisfies that.
#
# Evidence-model note: `tests_passed`/`test_evidence` on a task no longer count
# as passing evidence — the gate/verifier read `test_result.verdict` (see
# engine/src/types.ts testResultPassed). Fixtures that need a passing task use
# `"test_result": {"verdict": "trusted-pass"}` + `"new_tests_written": true`.
#
# Isolation: every test runs in an mktemp sandbox with LOOM_SUBAGENT_DIR and
# LOOM_STATE_PATH pointed into that sandbox, so runs never collide in /tmp and
# the suite is deterministic across repeated invocations.
#
# Usage:   bash artifacts/tests/integration-hooks.sh
# Requires: bun + jq on PATH.
# ============================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOOM_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SHIMS="$LOOM_ROOT/hooks/scripts"
CLI="$LOOM_ROOT/engine/src/cli.ts"
DISPATCH="$SHIMS/dispatch.sh"

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
PASS=0; FAIL=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS+1)); }
fail() {
  echo -e "  ${RED}✗ FAIL${NC} $1"
  [ $# -ge 2 ] && echo "      expected: $2"
  [ $# -ge 3 ] && echo "      got:      $3"
  FAIL=$((FAIL+1))
}

command -v bun >/dev/null 2>&1 || { echo "bun not found on PATH — cannot run integration tests"; exit 1; }
command -v jq  >/dev/null 2>&1 || { echo "jq not found on PATH — cannot run integration tests";  exit 1; }
[ -f "$CLI" ] || { echo "engine/src/cli.ts not found at $LOOM_ROOT"; exit 1; }

echo "=== Loom integration test suite (helpers + shims) ==="
echo "    driving real hooks under $LOOM_ROOT"
echo

# ---------------------------------------------------------------------------
# 1. store-review-findings helper
# ---------------------------------------------------------------------------
echo "1. store-review-findings helper"
SB="$(mktemp -d)"; mkdir -p "$SB/.claude/state"; GP="$SB/.claude/state/active_task_graph.json"
cat > "$GP" <<'EOF'
{
  "current_phase": "execute", "current_wave": 1,
  "phase_artifacts": {}, "skipped_phases": [], "spec_file": null, "plan_file": null,
  "tasks": [
    {"id": "T1", "description": "d", "agent": "code-implementer-agent", "wave": 1, "depends_on": [], "status": "implemented", "review_status": "pending", "critical_findings": [], "advisory_findings": []}
  ],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": true, "reviews_complete": false, "blocked": false}}
}
EOF
LOOM_STATE_PATH="$GP" bun "$CLI" helper store-review-findings --task T1 >/dev/null 2>&1 <<'EOF'
CRITICAL: SQL injection via "$user_input" in query
CRITICAL: Missing auth check on /api/admin
ADVISORY: Consider using `Optional<T>` instead of null
EOF
CRIT=$(jq '[.tasks[] | select(.id=="T1") | .critical_findings | length] | add' "$GP")
ADV=$(jq '[.tasks[] | select(.id=="T1") | .advisory_findings | length] | add' "$GP")
RSTATUS=$(jq -r '.tasks[] | select(.id=="T1") | .review_status' "$GP")
WBLOCK=$(jq -r '.wave_gates["1"].blocked' "$GP")
FINDING=$(jq -r '.tasks[] | select(.id=="T1") | .critical_findings[0]' "$GP")
[ "$CRIT" = "2" ]        && pass "stores 2 critical findings"      || fail "stores 2 critical findings" 2 "$CRIT"
[ "$ADV" = "1" ]         && pass "stores 1 advisory finding"       || fail "stores 1 advisory finding" 1 "$ADV"
[ "$RSTATUS" = "blocked" ] && pass "sets review_status=blocked"    || fail "sets review_status=blocked" blocked "$RSTATUS"
[ "$WBLOCK" = "true" ]   && pass "sets wave blocked=true"          || fail "sets wave blocked=true" true "$WBLOCK"
case "$FINDING" in *'$user_input'*) pass "preserves \$user_input special chars";; *) fail "preserves special chars" 'contains $user_input' "$FINDING";; esac
rm -rf "$SB"
echo

# ---------------------------------------------------------------------------
# 2. mark-tests-passed helper (read-only verifier)
# ---------------------------------------------------------------------------
echo "2. mark-tests-passed helper"
SB="$(mktemp -d)"; mkdir -p "$SB/.claude/state"; GP="$SB/.claude/state/active_task_graph.json"
cat > "$GP" <<'EOF'
{
  "current_phase": "execute", "current_wave": 1,
  "phase_artifacts": {}, "skipped_phases": [], "spec_file": null, "plan_file": null,
  "tasks": [
    {"id": "T1", "description": "d", "agent": "code-implementer-agent", "wave": 1, "depends_on": [], "status": "implemented", "test_result": {"verdict": "trusted-pass"}, "new_tests_written": true, "new_test_evidence": "3 new it/test/describe blocks"}
  ],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": null, "reviews_complete": false, "blocked": false}}
}
EOF
LOOM_STATE_PATH="$GP" bun "$CLI" helper mark-tests-passed </dev/null >/dev/null 2>&1
[ $? -eq 0 ] && pass "exit 0 when all tasks have evidence" || fail "exit 0 when all tasks have evidence" 0 non-zero
cat > "$GP" <<'EOF'
{
  "current_phase": "execute", "current_wave": 1,
  "phase_artifacts": {}, "skipped_phases": [], "spec_file": null, "plan_file": null,
  "tasks": [
    {"id": "T1", "description": "d", "agent": "code-implementer-agent", "wave": 1, "depends_on": [], "status": "implemented", "new_tests_written": false}
  ],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": null, "reviews_complete": false, "blocked": false}}
}
EOF
LOOM_STATE_PATH="$GP" bun "$CLI" helper mark-tests-passed </dev/null >/dev/null 2>&1
[ $? -ne 0 ] && pass "exit 1 when evidence missing" || fail "exit 1 when evidence missing" non-zero 0
rm -rf "$SB"
echo

# ---------------------------------------------------------------------------
# 3/9/11. complete-wave-gate helper
# ---------------------------------------------------------------------------
echo "3. complete-wave-gate helper (advance, block, new-test gates)"
run_gate() { LOOM_STATE_PATH="$GP" bun "$CLI" helper complete-wave-gate </dev/null 2>&1; }

# 3a. Happy path: advances wave, marks completed, sets reviews_complete, inits next gate.
SB="$(mktemp -d)"; mkdir -p "$SB/.claude/state"; GP="$SB/.claude/state/active_task_graph.json"
cat > "$GP" <<'EOF'
{
  "current_phase": "execute", "current_wave": 1, "github_issue": null,
  "phase_artifacts": {}, "skipped_phases": [], "spec_file": null, "plan_file": null,
  "tasks": [
    {"id": "T1", "description": "d", "agent": "code-implementer-agent", "wave": 1, "depends_on": [], "status": "implemented", "review_status": "passed", "critical_findings": [], "advisory_findings": [], "test_result": {"verdict": "trusted-pass"}, "new_tests_written": true, "new_test_evidence": "2 new it blocks"},
    {"id": "T2", "description": "d", "agent": "code-implementer-agent", "wave": 1, "depends_on": [], "status": "implemented", "review_status": "passed", "critical_findings": [], "advisory_findings": [], "test_result": {"verdict": "trusted-pass"}, "new_tests_written": true, "new_test_evidence": "4 new test blocks"},
    {"id": "T3", "description": "d", "agent": "code-implementer-agent", "wave": 2, "depends_on": [], "status": "pending", "review_status": "pending", "critical_findings": [], "advisory_findings": []}
  ],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": true, "reviews_complete": false, "blocked": false}}
}
EOF
run_gate >/dev/null 2>&1
CW=$(jq -r '.current_wave' "$GP")
T1S=$(jq -r '.tasks[] | select(.id=="T1") | .status' "$GP")
RC=$(jq -r '.wave_gates["1"].reviews_complete' "$GP")
W2=$(jq -r '.wave_gates["2"] // "missing"' "$GP")
[ "$CW" = "2" ]      && pass "advances to wave 2"            || fail "advances to wave 2" 2 "$CW"
[ "$T1S" = "completed" ] && pass "marks T1 completed"        || fail "marks T1 completed" completed "$T1S"
[ "$RC" = "true" ]   && pass "sets reviews_complete=true"    || fail "sets reviews_complete=true" true "$RC"
[ "$W2" != "missing" ] && pass "initializes wave 2 gate"     || fail "initializes wave 2 gate" object "$W2"
rm -rf "$SB"

# 3b. Blocks when critical findings exist.
SB="$(mktemp -d)"; mkdir -p "$SB/.claude/state"; GP="$SB/.claude/state/active_task_graph.json"
cat > "$GP" <<'EOF'
{
  "current_phase": "execute", "current_wave": 1,
  "phase_artifacts": {}, "skipped_phases": [], "spec_file": null, "plan_file": null,
  "tasks": [{"id": "T1", "description": "d", "agent": "code-implementer-agent", "wave": 1, "depends_on": [], "status": "implemented", "review_status": "blocked", "critical_findings": ["bug"], "advisory_findings": [], "test_result": {"verdict": "trusted-pass"}, "new_tests_written": true}],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": true, "reviews_complete": false, "blocked": true}}
}
EOF
run_gate >/dev/null 2>&1
[ $? -ne 0 ] && pass "blocks when critical findings exist" || fail "blocks when critical findings exist" non-zero 0
rm -rf "$SB"

# 9. Blocks when new_tests_written=false (and required).
SB="$(mktemp -d)"; mkdir -p "$SB/.claude/state"; GP="$SB/.claude/state/active_task_graph.json"
cat > "$GP" <<'EOF'
{
  "current_phase": "execute", "current_wave": 1,
  "phase_artifacts": {}, "skipped_phases": [], "spec_file": null, "plan_file": null,
  "tasks": [{"id": "T1", "description": "d", "agent": "code-implementer-agent", "wave": 1, "depends_on": [], "status": "implemented", "review_status": "passed", "critical_findings": [], "advisory_findings": [], "test_result": {"verdict": "trusted-pass"}, "new_tests_written": false}],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": null, "reviews_complete": false, "blocked": false}}
}
EOF
run_gate >/dev/null 2>&1
[ $? -ne 0 ] && pass "blocks when new_tests_written=false" || fail "blocks when new_tests_written=false" non-zero 0
rm -rf "$SB"

# 11a. Passes when new_tests_required=false.
SB="$(mktemp -d)"; mkdir -p "$SB/.claude/state"; GP="$SB/.claude/state/active_task_graph.json"
cat > "$GP" <<'EOF'
{
  "current_phase": "execute", "current_wave": 1, "github_issue": null,
  "phase_artifacts": {}, "skipped_phases": [], "spec_file": null, "plan_file": null,
  "tasks": [{"id": "T1", "description": "d", "agent": "code-implementer-agent", "wave": 1, "depends_on": [], "status": "implemented", "review_status": "passed", "critical_findings": [], "advisory_findings": [], "new_tests_required": false, "new_tests_written": false}],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": null, "reviews_complete": false, "blocked": false}}
}
EOF
run_gate 2>&1 | grep -q "All checks passed" && pass "passes when new_tests_required=false" || fail "passes when new_tests_required=false" "All checks passed" blocked
rm -rf "$SB"

# 11b. Mixed: one required=false, one required=true+written.
SB="$(mktemp -d)"; mkdir -p "$SB/.claude/state"; GP="$SB/.claude/state/active_task_graph.json"
cat > "$GP" <<'EOF'
{
  "current_phase": "execute", "current_wave": 1, "github_issue": null,
  "phase_artifacts": {}, "skipped_phases": [], "spec_file": null, "plan_file": null,
  "tasks": [
    {"id": "T1", "description": "d", "agent": "code-implementer-agent", "wave": 1, "depends_on": [], "status": "implemented", "review_status": "passed", "critical_findings": [], "advisory_findings": [], "new_tests_required": false, "new_tests_written": false},
    {"id": "T2", "description": "d", "agent": "code-implementer-agent", "wave": 1, "depends_on": [], "status": "implemented", "review_status": "passed", "critical_findings": [], "advisory_findings": [], "new_tests_required": true, "new_tests_written": true, "test_result": {"verdict": "trusted-pass"}, "new_test_evidence": "2 new @Test methods"}
  ],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": null, "reviews_complete": false, "blocked": false}}
}
EOF
run_gate 2>&1 | grep -q "All checks passed" && pass "mixed required false+true both pass" || fail "mixed required false+true both pass" "All checks passed" blocked
rm -rf "$SB"

# 11c. Blocks when new_tests_required=true but written=false.
SB="$(mktemp -d)"; mkdir -p "$SB/.claude/state"; GP="$SB/.claude/state/active_task_graph.json"
cat > "$GP" <<'EOF'
{
  "current_phase": "execute", "current_wave": 1,
  "phase_artifacts": {}, "skipped_phases": [], "spec_file": null, "plan_file": null,
  "tasks": [{"id": "T1", "description": "d", "agent": "code-implementer-agent", "wave": 1, "depends_on": [], "status": "implemented", "review_status": "passed", "critical_findings": [], "advisory_findings": [], "new_tests_required": true, "new_tests_written": false, "test_result": {"verdict": "trusted-pass"}}],
  "wave_gates": {"1": {"impl_complete": true, "tests_passed": null, "reviews_complete": false, "blocked": false}}
}
EOF
run_gate >/dev/null 2>&1
[ $? -ne 0 ] && pass "blocks when required=true but written=false" || fail "blocks when required=true but written=false" non-zero 0
rm -rf "$SB"
echo

# ---------------------------------------------------------------------------
# 19. populate-task-graph helper
# ---------------------------------------------------------------------------
echo "19. populate-task-graph helper"
SB="$(mktemp -d)"; mkdir -p "$SB/.claude/state"; GP="$SB/.claude/state/active_task_graph.json"
# plan.md present with NO model sections → executable-model bindings opt-out.
printf '# Plan\nDescriptive plan with no Lifecycles/Pipeline/Invariants sections.\n' > "$SB/plan.md"
cat > "$GP" <<'EOF'
{
  "current_phase": "execute",
  "phase_artifacts": {"brainstorm": "completed", "specify": "spec.md", "architecture": "plan.md"},
  "skipped_phases": [], "spec_file": "spec.md", "plan_file": "plan.md",
  "tasks": [], "wave_gates": {}
}
EOF
echo '{
  "plan_title": "Test Feature", "plan_file": "plan.md", "spec_file": "spec.md",
  "tasks": [
    {"id": "T1", "description": "First task",  "wave": 1, "agent": "code-implementer-agent", "depends_on": []},
    {"id": "T2", "description": "Second task", "wave": 1, "agent": "code-implementer-agent", "depends_on": []},
    {"id": "T3", "description": "Third task",  "wave": 2, "agent": "code-implementer-agent", "depends_on": ["T1"]}
  ]
}' | ( cd "$SB" && LOOM_STATE_PATH="$GP" bun "$CLI" helper populate-task-graph --issue 42 --repo owner/repo >/dev/null 2>&1 )
TC=$(jq '.tasks | length' "$GP")
CW=$(jq -r '.current_wave' "$GP")
ISS=$(jq -r '.github_issue' "$GP")
REPO=$(jq -r '.github_repo' "$GP")
PH=$(jq -r '.current_phase' "$GP")
W1=$(jq -r '.wave_gates["1"].impl_complete' "$GP")
W2=$(jq -r '.wave_gates["2"].impl_complete' "$GP")
[ "$TC" = "3" ]          && pass "3 tasks merged"              || fail "3 tasks merged" 3 "$TC"
[ "$CW" = "1" ]          && pass "current_wave=1"              || fail "current_wave=1" 1 "$CW"
[ "$ISS" = "42" ]        && pass "github_issue set"           || fail "github_issue set" 42 "$ISS"
[ "$REPO" = "owner/repo" ] && pass "github_repo set"          || fail "github_repo set" owner/repo "$REPO"
[ "$PH" = "execute" ]    && pass "preserves current_phase"    || fail "preserves current_phase" execute "$PH"
[ "$W1" = "false" ]      && pass "initializes wave 1 gate"     || fail "initializes wave 1 gate" false "$W1"
[ "$W2" = "false" ]      && pass "initializes wave 2 gate"     || fail "initializes wave 2 gate" false "$W2"
rm -rf "$SB"
echo

# ---------------------------------------------------------------------------
# 20. validate-task-graph helper (warning is advisory, not an error)
# ---------------------------------------------------------------------------
echo "20. validate-task-graph helper"
SB="$(mktemp -d)"
# plan.md present, no model sections → binding check opts out.
printf '# Plan\nno model sections\n' > "$SB/plan.md"
# Dummy state path avoids the git walk-up stderr noise (handler reads stdin, not state).
DUMMY="$SB/.claude/state/active_task_graph.json"; mkdir -p "$SB/.claude/state"
printf '{"current_phase":"init","phase_artifacts":{}}' > "$DUMMY"

CFG='{"plan_title":"Test","plan_file":"plan.md","spec_file":"spec.md","tasks":[{"id":"T1","description":"Update config for new env","wave":1,"agent":"code-implementer-agent","depends_on":[],"new_tests_required":false}]}'
OUT=$(echo "$CFG" | ( cd "$SB" && LOOM_STATE_PATH="$DUMMY" bun "$CLI" helper validate-task-graph 2>&1 ))
echo "$OUT" | grep -q "WARNING" && fail "no warning for config task + tests=false" "no WARNING" "$OUT" || pass "no warning for config task + tests=false"

SUS='{"plan_title":"Test","plan_file":"plan.md","spec_file":"spec.md","tasks":[{"id":"T1","description":"Implement user authentication with JWT","wave":1,"agent":"code-implementer-agent","depends_on":[],"new_tests_required":false}]}'
OUT=$(echo "$SUS" | ( cd "$SB" && LOOM_STATE_PATH="$DUMMY" bun "$CLI" helper validate-task-graph 2>&1 ))
echo "$OUT" | grep -q "WARNING" && pass "warns for impl task + tests=false" || fail "warns for impl task + tests=false" "contains WARNING" "$OUT"

echo "$SUS" | ( cd "$SB" && LOOM_STATE_PATH="$DUMMY" bun "$CLI" helper validate-task-graph >/dev/null 2>&1 )
[ $? -eq 0 ] && pass "warning does not fail validation (exit 0)" || fail "warning does not fail validation" 0 non-zero
rm -rf "$SB"
echo

# ---------------------------------------------------------------------------
# 7. block-direct-edits.sh shim
# ---------------------------------------------------------------------------
echo "7. block-direct-edits.sh shim"
SB="$(mktemp -d)"; mkdir -p "$SB/.claude/state"; GP="$SB/.claude/state/active_task_graph.json"
cat > "$GP" <<'EOF'
{"current_phase": "execute", "current_wave": 1, "phase_artifacts": {}, "skipped_phases": [], "spec_file": null, "plan_file": null, "tasks": [], "wave_gates": {"1": {"impl_complete": false, "tests_passed": null, "reviews_complete": false, "blocked": false}}}
EOF
bde() { echo "$1" | ( cd "$SB" && CLAUDE_PLUGIN_ROOT="$LOOM_ROOT" CLAUDE_PROJECT_DIR="$SB" LOOM_STATE_PATH="$GP" bash "$SHIMS/block-direct-edits.sh" >/dev/null 2>&1; echo $? ); }
[ "$(bde '{"tool_name":"Edit","tool_input":{"file_path":"t.ts"},"session_id":"s1"}')" = "2" ]  && pass "blocks Edit during orchestration"  || fail "blocks Edit during orchestration" 2 other
[ "$(bde '{"tool_name":"Write","tool_input":{"file_path":"t.ts"},"session_id":"s1"}')" = "2" ] && pass "blocks Write during orchestration" || fail "blocks Write during orchestration" 2 other
[ "$(bde '{"tool_name":"Read","tool_input":{"file_path":"t.ts"},"session_id":"s1"}')" = "0" ]  && pass "allows Read during orchestration"  || fail "allows Read during orchestration" 0 other
# No task graph → guard inactive (shim drains stdin, exits 0 before the CLI).
rm -f "$GP"
NGE=$(echo '{"tool_name":"Edit","tool_input":{"file_path":"t.ts"},"session_id":"s1"}' | ( cd "$SB" && CLAUDE_PLUGIN_ROOT="$LOOM_ROOT" CLAUDE_PROJECT_DIR="$SB" LOOM_STATE_PATH="$GP" bash "$SHIMS/block-direct-edits.sh" >/dev/null 2>&1; echo $? ))
[ "$NGE" = "0" ] && pass "allows Edit when no orchestration active" || fail "allows Edit when no orchestration active" 0 "$NGE"
rm -rf "$SB"
echo

# ---------------------------------------------------------------------------
# 15. validate-phase-order.sh shim
# ---------------------------------------------------------------------------
echo "15. validate-phase-order.sh shim"
SB="$(mktemp -d)"; mkdir -p "$SB/.claude/state" "$SB/.claude/specs/test-feature"; GP="$SB/.claude/state/active_task_graph.json"
vpo() { echo "$2" | ( cd "$SB" && CLAUDE_PLUGIN_ROOT="$LOOM_ROOT" CLAUDE_PROJECT_DIR="$SB" LOOM_STATE_PATH="$GP" bash "$SHIMS/validate-phase-order.sh" >/dev/null 2>&1; echo $? ); }

cat > "$GP" <<'EOF'
{"current_phase": "init", "phase_artifacts": {}, "skipped_phases": [], "spec_file": null, "plan_file": null, "current_wave": null, "tasks": [], "wave_gates": {}}
EOF
[ "$(vpo x '{"tool_name":"Task","tool_input":{"prompt":"Explore feature","subagent_type":"brainstorm-agent"}}')" = "0" ] && pass "allows brainstorm from init" || fail "allows brainstorm from init" 0 other
[ "$(vpo x '{"tool_name":"Task","tool_input":{"prompt":"Create spec","subagent_type":"specify-agent"}}')" = "2" ]      && pass "blocks specify from init"    || fail "blocks specify from init" 2 other

cat > "$GP" <<'EOF'
{"current_phase": "init", "phase_artifacts": {}, "skipped_phases": ["brainstorm"], "spec_file": null, "plan_file": null, "current_wave": null, "tasks": [], "wave_gates": {}}
EOF
[ "$(vpo x '{"tool_name":"Task","tool_input":{"prompt":"Create spec","subagent_type":"specify-agent"}}')" = "0" ] && pass "allows specify when brainstorm skipped" || fail "allows specify when brainstorm skipped" 0 other

cat > "$GP" <<'EOF'
{"current_phase": "specify", "phase_artifacts": {"brainstorm": "completed"}, "skipped_phases": [], "spec_file": null, "plan_file": null, "current_wave": null, "tasks": [], "wave_gates": {}}
EOF
[ "$(vpo x '{"tool_name":"Task","tool_input":{"prompt":"Design architecture","subagent_type":"architecture-agent"}}')" = "2" ] && pass "blocks architecture without spec" || fail "blocks architecture without spec" 2 other

# spec present, <= 3 markers → allowed
printf '# Test Spec\nSome requirements.\n[NEEDS CLARIFICATION]: One\n[NEEDS CLARIFICATION]: Two\n' > "$SB/.claude/specs/test-feature/spec.md"
cat > "$GP" <<'EOF'
{"current_phase": "specify", "phase_artifacts": {"brainstorm": "completed", "specify": ".claude/specs/test-feature/spec.md"}, "skipped_phases": [], "spec_file": ".claude/specs/test-feature/spec.md", "plan_file": null, "current_wave": null, "tasks": [], "wave_gates": {}}
EOF
[ "$(vpo x '{"tool_name":"Task","tool_input":{"prompt":"Design architecture","subagent_type":"architecture-agent"}}')" = "0" ] && pass "allows architecture with spec (markers <= 3)" || fail "allows architecture with spec (<=3)" 0 other

# spec present, > 3 markers → blocked
printf '# Test Spec\n[NEEDS CLARIFICATION]: One\n[NEEDS CLARIFICATION]: Two\n[NEEDS CLARIFICATION]: Three\n[NEEDS CLARIFICATION]: Four\n[NEEDS CLARIFICATION]: Five\n' > "$SB/.claude/specs/test-feature/spec.md"
[ "$(vpo x '{"tool_name":"Task","tool_input":{"prompt":"Design architecture","subagent_type":"architecture-agent"}}')" = "2" ] && pass "blocks architecture when markers > 3" || fail "blocks architecture (>3)" 2 other

# non-Task passthrough + unknown agent
[ "$(vpo x '{"tool_name":"Read","tool_input":{"file_path":"t.ts"}}')" = "0" ]                            && pass "ignores non-Task tools"    || fail "ignores non-Task tools" 0 other
[ "$(vpo x '{"tool_name":"Task","tool_input":{"prompt":"Run tests","subagent_type":"rogue-agent"}}')" = "2" ] && pass "blocks unknown agent types" || fail "blocks unknown agent types" 2 other
rm -rf "$SB"
echo

# ---------------------------------------------------------------------------
# 8. cleanup-stale-subagents.sh (SessionStart sweep, LOOM_SUBAGENT_DIR honored)
# ---------------------------------------------------------------------------
echo "8. cleanup-stale-subagents.sh (stale sweep)"
SB="$(mktemp -d)"; SUB="$SB/subagents"; mkdir -p "$SB/.claude/state" "$SUB"; GP="$SB/.claude/state/active_task_graph.json"
echo '{"current_phase": "execute", "phase_artifacts": {}, "skipped_phases": [], "spec_file": null, "plan_file": null, "tasks": [], "wave_gates": {}}' > "$GP"
echo "stale-agent" > "$SUB/old-session.active"
touch -t 202001010000 "$SUB/old-session.active"
echo "recent-agent" > "$SUB/new-session.active"
echo '{}' | CLAUDE_PLUGIN_ROOT="$LOOM_ROOT" CLAUDE_PROJECT_DIR="$SB" LOOM_SUBAGENT_DIR="$SUB" bash "$SHIMS/cleanup-stale-subagents.sh" >/dev/null 2>&1
[ ! -f "$SUB/old-session.active" ] && pass "cleans stale (>60min) files"    || fail "cleans stale (>60min) files" deleted "still exists"
[ -f "$SUB/new-session.active" ]   && pass "preserves recent (<60min) files" || fail "preserves recent files" preserved deleted
rm -rf "$SB"
echo

# ---------------------------------------------------------------------------
# 13. mark-subagent-active.sh (SubagentStart stores absolute .task_graph path)
# ---------------------------------------------------------------------------
echo "13. mark-subagent-active.sh (task_graph pointer)"
SB="$(mktemp -d)"; SUB="$SB/subagents"; mkdir -p "$SB/.claude/state" "$SUB"; GP="$SB/.claude/state/active_task_graph.json"
echo '{"current_phase": "execute", "phase_artifacts": {}, "skipped_phases": [], "spec_file": null, "plan_file": null, "tasks": [], "wave_gates": {}}' > "$GP"
echo '{"session_id":"store-path-session","agent_id":"agent-xyz","agent_type":"code-implementer-agent"}' | \
  ( cd "$SB" && CLAUDE_PLUGIN_ROOT="$LOOM_ROOT" CLAUDE_PROJECT_DIR="$SB" LOOM_SUBAGENT_DIR="$SUB" LOOM_STATE_PATH="$GP" bash "$SHIMS/mark-subagent-active.sh" >/dev/null 2>&1 )
if [ -f "$SUB/store-path-session.task_graph" ]; then
  STORED=$(cat "$SUB/store-path-session.task_graph")
  case "$STORED" in
    */active_task_graph.json) pass "stores path ending in active_task_graph.json";;
    *) fail "stores path ending in active_task_graph.json" "*/active_task_graph.json" "$STORED";;
  esac
  case "$STORED" in
    /*) pass "stored path is absolute";;
    *)  fail "stored path is absolute" "starts with /" "$STORED";;
  esac
else
  fail "creates .task_graph pointer" "file exists" "file not found"
  fail "stored path is absolute" "starts with /" "file not found"
fi
# No local graph → no pointer created.
NG="$SB/nograph"; mkdir -p "$NG"
echo '{"session_id":"no-graph-session","agent_id":"agent-abc","agent_type":"code-implementer-agent"}' | \
  ( cd "$NG" && CLAUDE_PLUGIN_ROOT="$LOOM_ROOT" CLAUDE_PROJECT_DIR="$NG" LOOM_SUBAGENT_DIR="$SUB" bash "$SHIMS/mark-subagent-active.sh" >/dev/null 2>&1 )
[ ! -f "$SUB/no-graph-session.task_graph" ] && pass "no pointer when no local graph" || fail "no pointer when no local graph" "file absent" "file created"
rm -rf "$SB"
echo

# ---------------------------------------------------------------------------
# 10. cleanup-subagent-flag via dispatch.sh
# ---------------------------------------------------------------------------
echo "10. cleanup-subagent-flag (via dispatch.sh)"
SB="$(mktemp -d)"; SUB="$SB/subagents"; mkdir -p "$SB/.claude/state" "$SUB"; GP="$SB/.claude/state/active_task_graph.json"
echo '{"current_phase": "execute", "current_wave": 1, "phase_artifacts": {}, "skipped_phases": [], "spec_file": null, "plan_file": null, "tasks": [], "wave_gates": {}}' > "$GP"
printf 'agent-aaa\nagent-bbb\n' > "$SUB/cleanup-test-session.active"
echo '{"session_id":"cleanup-test-session","agent_id":"agent-aaa","agent_type":"general-purpose"}' | \
  ( cd "$SB" && CLAUDE_PLUGIN_ROOT="$LOOM_ROOT" CLAUDE_PROJECT_DIR="$SB" LOOM_SUBAGENT_DIR="$SUB" LOOM_STATE_PATH="$GP" bash "$DISPATCH" >/dev/null 2>&1 )
if [ -f "$SUB/cleanup-test-session.active" ]; then
  REM=$(cat "$SUB/cleanup-test-session.active")
  echo "$REM" | grep -q "agent-bbb"   && pass "keeps other active agents"    || fail "keeps agent-bbb" agent-bbb "$REM"
  echo "$REM" | grep -q "agent-aaa"    && fail "removes completed agent" absent "$REM" || pass "removes completed agent"
else
  fail "roster preserved with remaining agent" "file exists with agent-bbb" "file deleted"
  fail "removes completed agent" absent "file deleted"
fi
rm -rf "$SB"
echo

# ---------------------------------------------------------------------------
# 16. advance-phase via dispatch.sh (brainstorm → specify)
# ---------------------------------------------------------------------------
echo "16. advance-phase brainstorm -> specify (via dispatch.sh)"
SB="$(mktemp -d)"; SUB="$SB/subagents"; mkdir -p "$SB/.claude/state" "$SB/.claude/specs/test-feature" "$SUB"; GP="$SB/.claude/state/active_task_graph.json"
cat > "$GP" <<'EOF'
{"current_phase": "init", "phase_artifacts": {}, "skipped_phases": [], "spec_file": null, "plan_file": null, "current_wave": null, "tasks": [], "wave_gates": {}}
EOF
echo "# Brainstorm" > "$SB/.claude/specs/test-feature/brainstorm.md"
echo "$GP" > "$SUB/advance-test-session.task_graph"
echo '{"session_id":"advance-test-session","agent_type":"brainstorm-agent","agent_transcript_path":"/nonexistent-transcript.jsonl"}' | \
  ( cd "$SB" && CLAUDE_PLUGIN_ROOT="$LOOM_ROOT" CLAUDE_PROJECT_DIR="$SB" LOOM_SUBAGENT_DIR="$SUB" LOOM_STATE_PATH="$GP" bash "$DISPATCH" >/dev/null 2>&1 )
NP=$(jq -r '.current_phase' "$GP")
BA=$(jq -r '.phase_artifacts.brainstorm // "missing"' "$GP")
[ "$NP" = "specify" ] && pass "advances brainstorm -> specify" || fail "advances brainstorm -> specify" specify "$NP"
case "$BA" in *brainstorm.md) pass "records brainstorm artifact";; *) fail "records brainstorm artifact" "*brainstorm.md" "$BA";; esac
rm -rf "$SB"
echo

# ---------------------------------------------------------------------------
echo "==========================================================="
echo -e "RESULT: ${GREEN}$PASS passed${NC}, $([ "$FAIL" = 0 ] && echo "0 failed" || echo -e "${RED}$FAIL failed${NC}")"
if [ "$FAIL" = 0 ]; then echo -e "${GREEN}INTEGRATION TESTS PASSED${NC}"; exit 0; else echo -e "${RED}INTEGRATION TESTS FAILED${NC}"; exit 1; fi
