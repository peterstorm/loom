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

# Captured stderr of the last run_gate / run_stop invocation, so assertions can
# distinguish a correct BLOCK from a fail-closed CRASH (both exit non-zero).
GATE_ERR="$TMP/last-gate.err"

# Run a PreToolUse Task gate; echo the exit code (0 = allow, 2 = block).
# stderr is captured to $GATE_ERR (NOT discarded) so a caller can assert the
# block MESSAGE, not merely the exit code — a fail-closed crash also exits 2.
#
# The CLI is invoked with cwd = $TMP so that advance-phase's cwd-relative plan
# fallbacks (`.claude/plans`, `.claude/specs`) resolve INSIDE the fixture, not
# against the loom repo's real plans dir. Without this, step 3's stale-plan trap
# would silently read the repo and pass/fail on coincidental repo contents.
run_gate() {
  local agent="$1" prompt="$2" rc=0
  printf '{"tool_name":"Task","tool_input":{"subagent_type":"%s","prompt":"%s"}}' "$agent" "$prompt" \
    | ( cd "$TMP" && bun "$CLI" pre-tool-use validate-phase-order ) >/dev/null 2>"$GATE_ERR" || rc=$?
  echo "$rc"
}

# Run a SubagentStop dispatch for a completed agent; echo the exit code.
# dispatch is NOT a fail-closed route, so a crash exits non-zero — callers assert
# rc = 0 to tell a genuine passthrough from a crashed no-op that leaves the phase
# coincidentally unchanged. Runs with cwd = $TMP (see run_gate).
run_stop() {
  local agent="$1" rc=0
  printf '{"agent_type":"%s","session_id":"%s","cwd":"%s"}' "$agent" "$SESSION" "$TMP" \
    | ( cd "$TMP" && bun "$CLI" subagent-stop dispatch ) >/dev/null 2>"$GATE_ERR" || rc=$?
  echo "$rc"
}

# Read the phase via the real JSON reader (jq), not a format-coupled grep/sed.
phase_now() { chmod u+r "$STATE" 2>/dev/null || true; jq -r '.current_phase' "$STATE"; }

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
# Assert BOTH the exit code AND the block message — a fail-closed crash also
# exits 2, so the message is what proves it was a real transition block.
if [ "$rc" = "2" ] && grep -q "Invalid phase transition" "$GATE_ERR"; then
  ok "BLOCKED with transition message (exit 2)"
else
  bad "expected block (exit 2 + 'Invalid phase transition'), got exit $rc / $(tr '\n' ' ' < "$GATE_ERR")"
fi

# ── 3. TRAP: panel agent stop does NOT advance, even with a stale same-date plan ─
# With cwd = $TMP the date-prefix fallback in resolveTransition genuinely reads
# this fixture: the stale plan below is the ONLY 2026-07-17-* file here, so IF a
# panel agent were ever mapped into PHASE_AGENT_MAP its completion would match
# (files.length === 1) and advance the phase. The passthrough that keeps the
# phase pinned is therefore load-bearing, not incidental.
echo "[3] subagent-stop: arch-designer-agent completion is passthrough (stale plan trap)"
printf '# stale plan\n' > "$PLANS_DIR/2026-07-17-stale.md"   # same date prefix as SLUG
write_state "architecture" "null"
src="$(run_stop arch-designer-agent)"
[ "$src" = "0" ] || bad "dispatch crashed (exit $src) — 'phase unchanged' would be a false pass"
after="$(phase_now)"
[ "$after" = "architecture" ] && ok "phase unchanged (still architecture)" || bad "phase advanced to '$after' — TRAP FIRED"

# ── 4. finalize architecture-agent ALLOWED ────────────────────────────────────
echo "[4] validate-phase-order: architecture-agent (finalize) in architecture phase"
rc="$(run_gate architecture-agent "finalize: approach gate over panel candidates")"
[ "$rc" = "0" ] && ok "ALLOWED (exit 0)" || bad "expected allow (exit 0), got exit $rc"

# ── 5. finalize architecture-agent stop ADVANCES to plan-alignment ────────────
# plan_file is left null so resolveTransition must derive the plan path from the
# spec_dir slug (`.claude/plans/2026-07-17-smoke-panel.md`, resolved against the
# $TMP cwd) — exercising the real slug-derive fallback, not a pre-set absolute.
echo "[5] subagent-stop: architecture-agent completion advances architecture → plan-alignment"
printf '# real plan\n' > "$PLANS_DIR/$SLUG.md"
write_state "architecture" "null"
src="$(run_stop architecture-agent)"
[ "$src" = "0" ] || bad "dispatch crashed (exit $src)"
after="$(phase_now)"
[ "$after" = "plan-alignment" ] && ok "phase advanced to plan-alignment" || bad "expected plan-alignment, got '$after'"

echo
echo "──────────────────────────────────────────"
echo "PASS: $PASS   FAIL: $FAIL"
[ "$FAIL" -eq 0 ] && { echo "Panel mode smoke test PASSED."; exit 0; } || { echo "Panel mode smoke test FAILED."; exit 1; }
