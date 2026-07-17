#!/usr/bin/env bash
#
# Smoke test for architecture panel mode (/loom --panel).
#
# Drives the REAL loom hook CLI (not the unit-test harness) through the panel
# lifecycle to prove the wiring end-to-end:
#
#   1. validate-phase-order ALLOWS a panel agent (arch-designer-agent) spawn
#      while current_phase = architecture with spec.md present.
#   2. validate-phase-order BLOCKS the same panel agent during execute phase
#      (architecture is not a valid target from execute).
#   3. subagent-stop dispatch for a panel agent is a PASSTHROUGH — it does NOT
#      advance the phase, even with a stale same-date-prefix plan on disk
#      (the design-constraint-2 trap).
#   4. validate-phase-order ALLOWS the finalize architecture-agent spawn.
#   5. subagent-stop dispatch for architecture-agent DOES advance the phase
#      architecture → plan-alignment (panel produces exactly one plan.md, same
#      contract as standard mode).
#
# Usage: ./scripts/smoke-panel-mode.sh
# Exit 0 = all assertions passed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOOM_DIR="$(dirname "$SCRIPT_DIR")"
CLI="$LOOM_DIR/engine/src/cli.ts"

command -v bun >/dev/null || { echo "FATAL: bun not found (need it to run the hook CLI)"; exit 1; }

TMP="$(mktemp -d)"
trap 'chmod -R u+w "$TMP" 2>/dev/null || true; rm -rf "$TMP"' EXIT

SLUG="2026-07-17-smoke-panel"
SPEC_DIR="$TMP/.claude/specs/$SLUG"
PLANS_DIR="$TMP/.claude/plans"
STATE="$TMP/.claude/state/active_task_graph.json"

export LOOM_STATE_PATH="$STATE"
export LOOM_SUBAGENT_DIR="$TMP/subagents"   # isolate from any real session
SESSION="smoke-session-1"

mkdir -p "$SPEC_DIR" "$PLANS_DIR" "$TMP/.claude/state" "$LOOM_SUBAGENT_DIR"

# Spec with zero NEEDS CLARIFICATION markers → architecture gate is satisfied.
printf '# Smoke spec\n\nFR-001: do the thing.\n' > "$SPEC_DIR/spec.md"

PASS=0
FAIL=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

# Write the state file at the given phase (chmod dance mirrors StateManager).
write_state() {
  local phase="$1" plan_file="$2"
  [ -f "$STATE" ] && chmod u+w "$STATE" 2>/dev/null || true
  cat > "$STATE" <<JSON
{
  "current_phase": "$phase",
  "phase_artifacts": {},
  "skipped_phases": ["brainstorm", "specify", "clarify"],
  "spec_dir": "$SPEC_DIR",
  "spec_file": "$SPEC_DIR/spec.md",
  "plan_file": $plan_file,
  "tasks": [],
  "current_wave": 1,
  "wave_gates": {}
}
JSON
  chmod 444 "$STATE"
}

# Run a PreToolUse Task gate; echo the exit code (0 = allow, 2 = block).
run_gate() {
  local agent="$1" prompt="$2" rc=0
  printf '{"tool_name":"Task","tool_input":{"subagent_type":"%s","prompt":"%s"}}' "$agent" "$prompt" \
    | bun "$CLI" pre-tool-use validate-phase-order >/dev/null 2>&1 || rc=$?
  echo "$rc"
}

# Run a SubagentStop dispatch for a completed agent.
run_stop() {
  local agent="$1"
  printf '{"agent_type":"%s","session_id":"%s","cwd":"%s"}' "$agent" "$SESSION" "$TMP" \
    | bun "$CLI" subagent-stop dispatch >/dev/null 2>&1 || true
}

phase_now() { chmod u+r "$STATE" 2>/dev/null || true; grep -o '"current_phase": *"[^"]*"' "$STATE" | head -1 | sed 's/.*"\([a-z-]*\)"$/\1/'; }

echo "Panel-mode smoke test (driving the real hook CLI)"
echo "state: $STATE"
echo

# ── 1. panel agent ALLOWED in architecture phase ──────────────────────────────
echo "[1] validate-phase-order: arch-designer-agent in architecture phase"
write_state "architecture" "null"
rc="$(run_gate arch-designer-agent "design a candidate via the simplicity-first lens")"
[ "$rc" = "0" ] && ok "ALLOWED (exit 0)" || bad "expected allow (exit 0), got exit $rc"

# also the interviewer and judge
for a in arch-interviewer-agent arch-judge-agent; do
  rc="$(run_gate "$a" "panel stage for $a")"
  [ "$rc" = "0" ] && ok "$a ALLOWED (exit 0)" || bad "$a expected allow, got exit $rc"
done

# ── 2. panel agent BLOCKED in execute phase ───────────────────────────────────
echo "[2] validate-phase-order: arch-designer-agent during execute phase"
write_state "execute" "null"
rc="$(run_gate arch-designer-agent "design a candidate")"
[ "$rc" = "2" ] && ok "BLOCKED (exit 2)" || bad "expected block (exit 2), got exit $rc"

# ── 3. TRAP: panel agent stop does NOT advance, even with a stale same-date plan ─
echo "[3] subagent-stop: arch-designer-agent completion is passthrough (stale plan trap)"
printf '# stale plan\n' > "$PLANS_DIR/2026-07-17-stale.md"   # same date prefix as SLUG
write_state "architecture" "null"
run_stop arch-designer-agent
after="$(phase_now)"
[ "$after" = "architecture" ] && ok "phase unchanged (still architecture)" || bad "phase advanced to '$after' — TRAP FIRED"

# ── 4. finalize architecture-agent ALLOWED ────────────────────────────────────
echo "[4] validate-phase-order: architecture-agent (finalize) in architecture phase"
rc="$(run_gate architecture-agent "finalize: approach gate over panel candidates")"
[ "$rc" = "0" ] && ok "ALLOWED (exit 0)" || bad "expected allow (exit 0), got exit $rc"

# ── 5. finalize architecture-agent stop ADVANCES to plan-alignment ────────────
echo "[5] subagent-stop: architecture-agent completion advances architecture → plan-alignment"
printf '# real plan\n' > "$PLANS_DIR/$SLUG.md"
write_state "architecture" "\"$PLANS_DIR/$SLUG.md\""
run_stop architecture-agent
after="$(phase_now)"
[ "$after" = "plan-alignment" ] && ok "phase advanced to plan-alignment" || bad "expected plan-alignment, got '$after'"

echo
echo "──────────────────────────────────────────"
echo "PASS: $PASS   FAIL: $FAIL"
[ "$FAIL" -eq 0 ] && { echo "Panel mode smoke test PASSED."; exit 0; } || { echo "Panel mode smoke test FAILED."; exit 1; }
