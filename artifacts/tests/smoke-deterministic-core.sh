#!/bin/bash
# ============================================================================
# Loom deterministic-core smoke test
# ============================================================================
# Drives the REAL production hook entry points end-to-end, exactly as Claude
# Code invokes them: a bash shim (hooks/scripts/*.sh) execs
# `bun engine/src/cli.ts <hookType> <handler>`, reads a tool-call JSON on stdin,
# and maps the decision to an exit code (2 = block, 0 = allow/passthrough).
#
# This complements the unit suite (engine/tests, 1500+ vitest cases, run with
# `cd engine && bun test`). Unit tests prove the pure logic; this proves the
# wiring — shims, stdin buffering, JSON parsing, fail-closed exit routing, and
# config path resolution — actually holds when run as a real hook.
#
# Scope (what a smoke test CAN prove without live LLM agents):
#   A. guard-state-file       — the fail-closed state/ledger write guard
#   B. lint-file              — immediate-tier invariant enforcement on edit
#   C. validate-task-execution— wave-order & dependency gates
#   D. enforce-phase-tools    — the phase machine's tool gates (write-before-read)
#
# Out of scope (needs the live orchestrated pipeline or heavy session/epoch
# machinery — covered by engine/tests instead):
#   - the full brainstorm→…→execute agent pipeline (needs real subagents)
#   - the evidence-ledger trusted-pass vs untrusted verdict (needs a recorded
#     TestRun with a fresh report artifact + fold/judge; see
#     engine/tests/machine/*.test.ts and engine/src/machine/test-report.ts)
#
# Usage:   bash artifacts/tests/smoke-deterministic-core.sh
# Requires: bun on PATH.
# ============================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOOM_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SHIMS="$LOOM_ROOT/hooks/scripts"

GREEN='\033[0;32m'; RED='\033[0;31m'; DIM='\033[2m'; NC='\033[0m'
PASS=0; FAIL=0
ok()  { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS+1)); }
bad() { echo -e "  ${RED}✗ FAIL${NC} $1"; FAIL=$((FAIL+1)); }
# assert <expected-exit> <actual-exit> <label>
assert() { if [ "$1" = "$2" ]; then ok "$3 ${DIM}(exit $2)${NC}"; else bad "$3 — expected exit $1, got $2"; fi; }

command -v bun >/dev/null 2>&1 || { echo "bun not found on PATH — cannot run smoke test"; exit 1; }
[ -f "$LOOM_ROOT/engine/src/cli.ts" ] || { echo "engine/src/cli.ts not found at $LOOM_ROOT"; exit 1; }

# JSON-encode a Bash command safely (no quoting games) via bun.
guard_json() { CMD="$1" bun -e 'process.stdout.write(JSON.stringify({session_id:"smoke",tool_name:"Bash",tool_input:{command:process.env.CMD}}))'; }

echo "=== Loom deterministic-core smoke test ==="
echo "    driving real hooks under $LOOM_ROOT"
echo

# ---------------------------------------------------------------------------
# A. guard-state-file — fail-closed guard on the state file & evidence ledger
# ---------------------------------------------------------------------------
echo "A. guard-state-file (fail-closed state/ledger write guard)"
SB="$(mktemp -d)"; mkdir -p "$SB/.claude/state"
echo '{"current_phase":"execute","phase_artifacts":{},"tasks":[]}' > "$SB/.claude/state/active_task_graph.json"  # makes guard ACTIVE
echo 'SENTINEL-DO-NOT-DELETE' > "$SB/.claude/state/ledger.txt"                                                   # protected asset

run_guard() { # $1 = command → echoes exit code
  guard_json "$1" | ( cd "$SB" && CLAUDE_PLUGIN_ROOT="$LOOM_ROOT" CLAUDE_PROJECT_DIR="$SB" bash "$SHIMS/guard-state-file.sh" >/dev/null 2>&1; echo $? )
}

# A0. Prove the threat is real: unguarded bash resolves the exploit and deletes state.
ATK="$(mktemp -d)"; mkdir -p "$ATK/.claude/state"; echo x > "$ATK/.claude/state/ledger.txt"
( cd "$ATK" && bash -c 'rm -rf .claude/stat$(printf e)' )
if [ -d "$ATK/.claude/state" ]; then bad "unguarded exploit did NOT delete state (test invalid)"; else ok "threat is real: unguarded \`rm -rf .claude/stat\$(printf e)\` DELETED .claude/state"; fi
rm -rf "$ATK"

# A1. Guard BLOCKS the round-26 completion exploit and its variants.
assert 2 "$(run_guard 'rm -rf .claude/stat$(printf e)')"          "block completion exploit \$(printf e)"
assert 2 "$(run_guard 'rm -rf .claude/stat`printf e`')"           "block completion exploit (backtick)"
assert 2 "$(run_guard 'rm -rf .claude/stat${x:-$(printf e)}')"    "block completion nested in default word"
assert 2 "$(run_guard 'rm -rf .claude/stat${PWD:+$(printf e)}')"  "block completion in alternate-form word"
# A2. Regression: prior-round vectors still blocked.
assert 2 "$(run_guard 'echo FORGED > .claude/state/active_task_graph.json')" "block direct redirect forge"
assert 2 "$(run_guard 'rm .claude/stat$(:)e/active_task_graph.json')"        "block empty-substitution fragmentation"
assert 2 "$(run_guard 'rm -rf ${PWD:+.claude/state/active_task_graph.json}')" "block alternate-form literal"
# A3. Precision: legitimate reads & out-of-scope commands still ALLOW.
assert 0 "$(run_guard 'jq . .claude/state/active_task_graph.json')"          "allow read-only jq of state"
assert 0 "$(run_guard 'cat .claude/stat$(printf e)/active_task_graph.json')" "allow read through completing substitution"
assert 0 "$(run_guard 'npm install && echo done')"                          "allow out-of-scope command"
# A4. Fail-closed on malformed input.
assert 2 "$( printf '{"tool_input":{"command":{"evil":1}}}' | ( cd "$SB" && CLAUDE_PLUGIN_ROOT="$LOOM_ROOT" CLAUDE_PROJECT_DIR="$SB" bash "$SHIMS/guard-state-file.sh" >/dev/null 2>&1; echo $? ) )" "fail closed on non-string command"
# A5. Protected asset survived the barrage.
grep -q SENTINEL "$SB/.claude/state/ledger.txt" 2>/dev/null && ok "state ledger intact after all attempts" || bad "state ledger missing/altered"
rm -rf "$SB"
echo

# ---------------------------------------------------------------------------
# B. lint-file — immediate-tier invariant enforcement on every edit
# ---------------------------------------------------------------------------
echo "B. lint-file (immediate-tier invariant enforcement, shipped no-any-type rule)"
SB="$(mktemp -d)"
printf 'export const bad: any = 1;\n'    > "$SB/violation.ts"
printf 'export const good: number = 1;\n' > "$SB/clean.ts"
lint() { printf '{"tool_name":"Write","tool_input":{"file_path":"%s"}}' "$1" | ( CLAUDE_PLUGIN_ROOT="$LOOM_ROOT" bash "$SHIMS/lint-file.sh" >/dev/null 2>&1; echo $? ); }
assert 2 "$(lint "$SB/violation.ts")" "block .ts edit that violates a checkable invariant (: any)"
assert 0 "$(lint "$SB/clean.ts")"     "allow clean .ts edit"
rm -rf "$SB"
echo

# ---------------------------------------------------------------------------
# C. validate-task-execution — wave-order & dependency gates
# ---------------------------------------------------------------------------
echo "C. validate-task-execution (wave-order & dependency gates)"
SB="$(mktemp -d)"; mkdir -p "$SB/.claude/state"
cat > "$SB/.claude/state/active_task_graph.json" <<'EOF'
{"current_phase":"execute","current_wave":1,"phase_artifacts":{},
 "tasks":[{"id":"T1","wave":1,"status":"pending","depends_on":[]},
          {"id":"T2","wave":2,"status":"pending","depends_on":["T1"]},
          {"id":"T3","wave":1,"status":"pending","depends_on":["T2"]}],
 "wave_gates":{}}
EOF
vtx() { printf '{"tool_name":"Task","tool_input":{"description":"%s","prompt":"Task ID: %s"}}' "$1" "$1" | ( cd "$SB" && CLAUDE_PLUGIN_ROOT="$LOOM_ROOT" CLAUDE_PROJECT_DIR="$SB" bash "$SHIMS/validate-task-execution.sh" >/dev/null 2>&1; echo $? ); }
assert 0 "$(vtx T1)" "allow T1 (wave 1 == current wave)"
assert 2 "$(vtx T2)" "block T2 (wave 2 > current wave 1)"
assert 2 "$(vtx T3)" "block T3 (dependency T2 not complete)"
rm -rf "$SB"
echo

# ---------------------------------------------------------------------------
# D. enforce-phase-tools — the phase machine's tool gates
# ---------------------------------------------------------------------------
echo "D. enforce-phase-tools (phase machine tool gates, shipped code-implementer machine)"
SB="$(mktemp -d)"; SUB="$SB/subagents"; mkdir -p "$SUB"; SESS="smoke-sess"
printf 'impl-1\tcode-implementer-agent\t1720000000000\n' > "$SUB/$SESS.machine"  # binding
printf 'impl-1\n'                                          > "$SUB/$SESS.active"   # sole-active roster
gate() { printf '{"session_id":"%s","tool_name":"%s","tool_input":{"file_path":"x.ts"},"tool_use_id":"c1"}' "$SESS" "$1" \
  | ( LOOM_SUBAGENT_DIR="$SUB" LOOM_MACHINES_DIR="$LOOM_ROOT/machines" CLAUDE_PLUGIN_ROOT="$LOOM_ROOT" bash "$SHIMS/enforce-phase-tools.sh" >/dev/null 2>&1; echo $? ); }
assert 2 "$(gate Write)" "block Write in initial read-context phase (write-before-read)"
assert 0 "$(gate Read)"  "allow Read (not an enforced tool)"
rm -f "$SUB/$SESS.machine" "$SUB/$SESS.active"
assert 0 "$(gate Write)" "allow Write in an ungated session (no binding)"
rm -rf "$SB"
echo

# ---------------------------------------------------------------------------
echo "==========================================================="
echo -e "RESULT: ${GREEN}$PASS passed${NC}, $([ "$FAIL" = 0 ] && echo "0 failed" || echo -e "${RED}$FAIL failed${NC}")"
if [ "$FAIL" = 0 ]; then echo -e "${GREEN}SMOKE TEST PASSED${NC}"; exit 0; else echo -e "${RED}SMOKE TEST FAILED${NC}"; exit 1; fi
