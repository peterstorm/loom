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
#   3. validate-phase-order BLOCKS panel agents during plan-alignment loop-back.
#   4. subagent-stop dispatch for a panel agent is a PASSTHROUGH — it does NOT
#      advance the phase, even with a stale same-date-prefix plan on disk.
#   5. validate-phase-order ALLOWS the finalize architecture-agent spawn.
#   6. subagent-stop dispatch for architecture-agent DOES advance the phase
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
command -v jq >/dev/null || { echo "FATAL: jq not found (needed by phase_now to read current_phase from state)"; exit 1; }

TMP="$(mktemp -d)"
cleanup() {
  local rc=$? cleanup_failed=0
  trap - EXIT
  if ! chmod -R u+w "$TMP"; then
    echo "FATAL: could not make smoke fixture writable for cleanup: $TMP" >&2
    cleanup_failed=1
  fi
  if ! rm -rf "$TMP"; then
    echo "FATAL: could not remove smoke fixture: $TMP" >&2
    cleanup_failed=1
  fi
  # Preserve the primary failure code; cleanup only turns an otherwise green
  # run into a failure.
  if [ "$rc" -eq 0 ] && [ "$cleanup_failed" -ne 0 ]; then rc=1; fi
  exit "$rc"
}
trap cleanup EXIT

SLUG="2026-07-17-smoke-panel"
SPEC_DIR="$TMP/.claude/specs/$SLUG"
PLANS_DIR="$TMP/.claude/plans"
STATE="$TMP/.claude/state/active_task_graph.json"

export LOOM_STATE_PATH="$STATE"
export LOOM_SUBAGENT_DIR="$TMP/subagents"   # isolate from any real session
SESSION="smoke-session-1"

mkdir -p "$SPEC_DIR" "$PLANS_DIR" "$TMP/.claude/state" "$LOOM_SUBAGENT_DIR"

# advance-phase resolves the task graph session-FIRST (a `$SESSION.task_graph`
# pointer under LOOM_SUBAGENT_DIR), falling back to LOOM_STATE_PATH only when no
# pointer exists. This test relies on that fallback, so assert the pointer is
# absent — a stray pointer would silently retarget every stop and make the phase
# assertions below pass/fail for reasons unrelated to panel logic.
[ ! -e "$LOOM_SUBAGENT_DIR/$SESSION.task_graph" ] \
  || { echo "FATAL: unexpected session pointer for $SESSION — test would not exercise LOOM_STATE_PATH"; exit 1; }

# Spec with zero NEEDS CLARIFICATION markers → architecture gate is satisfied.
printf '# Smoke spec\n\nFR-001: do the thing.\n' > "$SPEC_DIR/spec.md"

PASS=0
FAIL=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

# Write the state file at the given phase (chmod dance mirrors StateManager).
write_state() {
  local phase="$1" plan_file="$2"
  # Explicit if (not `[ -f ] && chmod || true`): a real chmod failure must abort
  # loudly under set -e, not be swallowed and surface three steps later as a
  # confusing phase mismatch. When the file is absent there is nothing to unlock.
  if [ -f "$STATE" ]; then chmod u+w "$STATE"; fi
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
# The payload is built with jq --arg (not printf) so agent/prompt are correctly
# JSON-escaped: a prompt containing `"` or `\` would otherwise produce malformed
# JSON that validate-phase-order fail-closes on (exit 2), which an allow-case
# assertion would misread as a block.
run_gate() {
  local agent="$1" prompt="$2" rc=0 payload
  # Build the JSON payload FIRST, into a variable, so a jq failure is attributed to
  # payload construction (fatal below) rather than swallowed. Under `set -o pipefail`
  # a jq error inside the pipe would surface as the pipeline's exit code, and the
  # allow/block assertion would misread jq's exit (2/5) as a real CLI block/crash.
  payload="$(jq -nc --arg a "$agent" --arg p "$prompt" \
    '{tool_name:"Task",tool_input:{subagent_type:$a,prompt:$p}}')" \
    || { echo "FATAL: jq failed building the run_gate payload for agent '$agent'" >&2; exit 1; }
  printf '%s' "$payload" \
    | ( cd "$TMP" && bun "$CLI" pre-tool-use validate-phase-order ) >/dev/null 2>"$GATE_ERR" || rc=$?
  echo "$rc"
}

# Run a SubagentStop dispatch for a completed agent; echo the exit code.
# dispatch is NOT a fail-closed route, so a crash exits non-zero — callers assert
# rc = 0 to tell a genuine passthrough from a crashed no-op that leaves the phase
# coincidentally unchanged. Runs with cwd = $TMP (see run_gate).
run_stop() {
  local agent="$1" rc=0 payload
  # Same pipefail-attribution guard as run_gate: construct the payload first so a
  # jq failure is fatal-and-labeled, not misread as a dispatch crash (rc != 0).
  payload="$(jq -nc --arg a "$agent" --arg s "$SESSION" --arg c "$TMP" \
    '{agent_type:$a,session_id:$s,cwd:$c}')" \
    || { echo "FATAL: jq failed building the run_stop payload for agent '$agent'" >&2; exit 1; }
  printf '%s' "$payload" \
    | ( cd "$TMP" && bun "$CLI" subagent-stop dispatch ) >/dev/null 2>"$GATE_ERR" || rc=$?
  echo "$rc"
}

# Read the phase via the real JSON reader (jq), not a format-coupled grep/sed.
# chmod failure aborts loudly (no `|| true`) and an empty/absent phase is fatal
# rather than silently comparing to "" — a swallowed read would otherwise let a
# phase assertion pass on stale/unreadable state (a false PASS).
phase_now() {
  if [ -f "$STATE" ]; then chmod u+r "$STATE"; fi
  local p
  p="$(jq -r '.current_phase' "$STATE")"
  [ -n "$p" ] && [ "$p" != "null" ] \
    || { echo "FATAL: could not read current_phase from $STATE" >&2; exit 1; }
  printf '%s' "$p"
}

echo "Panel-mode smoke test (driving the real hook CLI)"
echo "state: $STATE"
echo

# ── 1. panel agent ALLOWED in architecture phase ──────────────────────────────
echo "[1] validate-phase-order: arch-designer-agent in architecture phase"
write_state "architecture" "null"
# Deliberately regex-NEUTRAL prompt: "design"/"architecture"/"plan.md" would each
# match detectPhase's architecture prompt-regex fallback, so a prompt containing
# them could pass even if ARCH_PANEL_AGENTS recognition were broken — a false
# green. This prompt matches no detectPhase regex, so the allow proves the panel
# recognition path (validate-phase-order.ts:57) specifically.
rc="$(run_gate arch-designer-agent "candidate under the simplicity-first lens")"
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
# Assert BOTH the exit code AND panel-phase block message — a fail-closed crash
# also exits 2, so the message proves the explicit panel current-phase gate ran.
if [ "$rc" = "2" ] && grep -q "panel agents may run only during the architecture phase" "$GATE_ERR"; then
  ok "arch-designer-agent BLOCKED with panel-phase message (exit 2)"
else
  bad "expected panel-phase block (exit 2), got exit $rc / $(tr '\n' ' ' < "$GATE_ERR")"
fi

# All three panel roles share the gate, so all must block in execute.
for a in arch-interviewer-agent arch-judge-agent; do
  rc="$(run_gate "$a" "panel stage for $a")"
  if [ "$rc" = "2" ] && grep -q "panel agents may run only during the architecture phase" "$GATE_ERR"; then
    ok "$a BLOCKED with panel-phase message (exit 2)"
  else
    bad "$a expected panel-phase block (exit 2), got exit $rc / $(tr '\n' ' ' < "$GATE_ERR")"
  fi
done

# ── 3. panel agents BLOCKED during standard plan-alignment loop-back ──────────
echo "[3] validate-phase-order: panel agent during plan-alignment loop-back"
write_state "plan-alignment" "null"
rc="$(run_gate arch-designer-agent "candidate under the simplicity-first lens")"
if [ "$rc" = "2" ] && grep -q "panel agents may run only during the architecture phase" "$GATE_ERR"; then
  ok "arch-designer-agent BLOCKED from re-panel loop-back (exit 2)"
else
  bad "expected panel-only phase block, got exit $rc / $(tr '\n' ' ' < "$GATE_ERR")"
fi

# ── 4. TRAP: panel agent stop does NOT advance, even with a stale same-date plan ─
# With cwd = $TMP the date-prefix fallback in resolveTransition genuinely reads
# this fixture: the stale plan below is the ONLY 2026-07-17-* file here, so IF a
# panel agent were ever mapped into PHASE_AGENT_MAP its completion would match
# (files.length === 1) and advance the phase. The passthrough that keeps the
# phase pinned is therefore load-bearing, not incidental.
echo "[4] subagent-stop: arch-designer-agent completion is passthrough (stale plan trap)"
printf '# stale plan\n' > "$PLANS_DIR/2026-07-17-stale.md"   # same date prefix as SLUG
write_state "architecture" "null"
src="$(run_stop arch-designer-agent)"
# Gate the phase assertion on a clean dispatch: a crash (exit != 0) leaves the
# phase at "architecture" for the WRONG reason (it never ran), so asserting
# "phase unchanged" here would print a spurious green ✓ next to the crash's ✗.
if [ "$src" != "0" ]; then
  bad "dispatch crashed (exit $src) — 'phase unchanged' would be a false pass"
else
  after="$(phase_now)"
  [ "$after" = "architecture" ] && ok "phase unchanged (still architecture)" || bad "phase advanced to '$after' — TRAP FIRED"
fi

# ── 5. finalize architecture-agent ALLOWED ────────────────────────────────────
echo "[5] validate-phase-order: architecture-agent (finalize) in architecture phase"
rc="$(run_gate architecture-agent "finalize: approach gate over panel candidates")"
[ "$rc" = "0" ] && ok "ALLOWED (exit 0)" || bad "expected allow (exit 0), got exit $rc"

# ── 6. finalize architecture-agent stop ADVANCES to plan-alignment ────────────
# plan_file is left null so resolveTransition must derive the plan path from the
# spec_dir slug (`.claude/plans/2026-07-17-smoke-panel.md`, resolved against the
# $TMP cwd) — exercising the real slug-derive fallback, not a pre-set absolute.
echo "[6] subagent-stop: architecture-agent completion advances architecture → plan-alignment"
printf '# real plan\n' > "$PLANS_DIR/$SLUG.md"
write_state "architecture" "null"
src="$(run_stop architecture-agent)"
# Same crash-gating as step 3: only assert the transition when dispatch ran clean.
if [ "$src" != "0" ]; then
  bad "dispatch crashed (exit $src)"
else
  after="$(phase_now)"
  [ "$after" = "plan-alignment" ] && ok "phase advanced to plan-alignment" || bad "expected plan-alignment, got '$after'"
fi

echo
echo "──────────────────────────────────────────"
echo "PASS: $PASS   FAIL: $FAIL"
[ "$FAIL" -eq 0 ] && { echo "Panel mode smoke test PASSED."; exit 0; } || { echo "Panel mode smoke test FAILED."; exit 1; }
