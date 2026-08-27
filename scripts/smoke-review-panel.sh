#!/usr/bin/env bash
#
# Smoke test for the wave gate's adversarial review panel.
#
# Drives the REAL loom hook CLI (not the unit-test harness) through the whole
# refutation lifecycle to prove the wiring end-to-end:
#
#   1. `review-panel brief` reads the wave's CRITICAL findings out of state and
#      writes the run-scoped brief + per-finding artifacts. Advisories are
#      excluded — they never enter the panel.
#   2. `review-panel manifest` fixes the finding set and the lens set, and
#      `lenses` reports the same list (signal-driven: an auth path pulls in the
#      `security` lens).
#   3. `review-panel verdict` accepts a well-formed verifier output, and REJECTS
#      one that skipped a finding — a verifier can neither invent nor skip.
#   4. `review-panel tally` adjudicates from disk, moves a majority-refuted
#      finding into `refuted_findings` (recorded, not deleted), and leaves an
#      under-threshold finding standing.
#   5. validate-phase-order ALLOWS review-verifier-agent during execute.
#   6. subagent-stop dispatch for review-verifier-agent is a PASSTHROUGH — it
#      must NOT be parsed for findings it never emits.
#
# Usage: ./scripts/smoke-review-panel.sh
# Exit 0 = all assertions passed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOOM_DIR="$(dirname "$SCRIPT_DIR")"
CLI="$LOOM_DIR/engine/src/cli.ts"

command -v bun >/dev/null || { echo "FATAL: bun not found (need it to run the hook CLI)"; exit 1; }
command -v jq  >/dev/null || { echo "FATAL: jq not found (needed to read assertions out of state)"; exit 1; }

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

SLUG="2026-08-02-smoke-review-panel"
STATE="$TMP/.claude/state/active_task_graph.json"
SPEC_DIR="$TMP/.claude/specs/$SLUG"
PLAN_FILE="$TMP/.claude/plans/$SLUG.md"
RUNS_ROOT_REL=".claude/reviews/panel-runs"
RUN_REL="$RUNS_ROOT_REL/run.smoke"
RUN_DIR="$TMP/$RUN_REL"

export LOOM_STATE_PATH=".claude/state/active_task_graph.json"
export LOOM_SUBAGENT_DIR="$TMP/subagents"   # isolate from any real session
SESSION="smoke-review-session-1"

mkdir -p "$(dirname "$STATE")" "$SPEC_DIR" "$(dirname "$PLAN_FILE")" "$RUN_DIR" "$LOOM_SUBAGENT_DIR"

# The execute phase's artifact gate needs a plan and a plan-alignment report on
# disk. Without them, step 5's ALLOW assertion would fail for a reason that has
# nothing to do with verifier recognition.
printf '# Smoke spec\n\nFR-001: do the thing.\n'        > "$SPEC_DIR/spec.md"
printf '# Plan alignment\n\nNo gaps.\n'                 > "$SPEC_DIR/plan-alignment.md"
printf '# Smoke plan\n\n## Components\n\nOne thing.\n'  > "$PLAN_FILE"

PASS=0
FAIL=0
ok()  { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

F1="T1:code-reviewer-1"
F2="T1:silent-failure-hunter-1"

# Two criticals and one advisory on one implemented, blocked wave-1 task. The
# first critical sits on an auth path, which is the signal that pulls the
# `security` lens into the panel.
write_state() {
  if [ -f "$STATE" ]; then chmod u+w "$STATE"; fi
  cat > "$STATE" <<JSON
{
  "current_phase": "execute",
  "phase_artifacts": { "architecture": "$PLAN_FILE" },
  "skipped_phases": ["brainstorm", "specify", "clarify"],
  "spec_dir": "$SPEC_DIR",
  "spec_file": "$SPEC_DIR/spec.md",
  "plan_file": "$PLAN_FILE",
  "current_wave": 1,
  "wave_gates": { "1": { "impl_complete": true, "tests_passed": true, "reviews_complete": false, "blocked": true } },
  "tasks": [
    {
      "id": "T1",
      "description": "smoke task",
      "agent": "code-implementer-agent",
      "wave": 1,
      "status": "implemented",
      "depends_on": [],
      "review_status": "blocked",
      "findings": [
        { "id": "code-reviewer-1", "agent": "code-reviewer", "severity": "critical", "file": "src/auth/token.ts", "line": 42, "claim": "unchecked cast in the token reducer" },
        { "id": "code-reviewer-2", "agent": "code-reviewer", "severity": "advisory", "file": null, "line": null, "claim": "prefer a named constant" },
        { "id": "silent-failure-hunter-1", "agent": "silent-failure-hunter", "severity": "critical", "file": "src/x.ts", "line": 7, "claim": "catch block swallows the error" }
      ],
      "critical_findings": ["unchecked cast in the token reducer", "catch block swallows the error"],
      "advisory_findings": ["prefer a named constant"]
    }
  ]
}
JSON
  chmod 444 "$STATE"
}

# Captured stderr of the last helper/gate invocation, so an assertion can tell a
# contract rejection from a crash (both exit non-zero).
ERR="$TMP/last.err"

# Run a review-panel helper with cwd = $TMP, so the runs-root containment check
# resolves inside the fixture. stdin is fed from $2 (default empty) because the
# CLI reads stdin for every helper route and would otherwise block.
helper() {
  local input="${REVIEW_STDIN:-}" rc=0
  printf '%s' "$input" \
    | ( cd "$TMP" && bun "$CLI" helper review-panel "$@" ) >"$TMP/last.out" 2>"$ERR" || rc=$?
  echo "$rc"
}

# Run a PreToolUse Task gate; echo the exit code (0 = allow, 2 = block).
run_gate() {
  local agent="$1" prompt="$2" rc=0 payload
  payload="$(jq -nc --arg a "$agent" --arg p "$prompt" \
    '{tool_name:"Task",tool_input:{subagent_type:$a,prompt:$p}}')" \
    || { echo "FATAL: jq failed building the run_gate payload for agent '$agent'" >&2; exit 1; }
  printf '%s' "$payload" \
    | ( cd "$TMP" && bun "$CLI" pre-tool-use validate-phase-order ) >/dev/null 2>"$ERR" || rc=$?
  echo "$rc"
}

# Run a SubagentStop dispatch for a completed agent; echo the exit code.
run_stop() {
  local agent="$1" rc=0 payload
  payload="$(jq -nc --arg a "$agent" --arg i "smoke-$agent" --arg s "$SESSION" --arg c "$TMP" \
    '{agent_type:$a,agent_id:$i,session_id:$s,cwd:$c}')" \
    || { echo "FATAL: jq failed building the run_stop payload for agent '$agent'" >&2; exit 1; }
  printf '%s' "$payload" \
    | ( cd "$TMP" && bun "$CLI" subagent-stop dispatch ) >/dev/null 2>"$ERR" || rc=$?
  echo "$rc"
}

# Read a jq expression off the task graph. A failed/empty read is fatal rather
# than silently comparing against "" — a swallowed read is a false PASS.
state_q() {
  if [ -f "$STATE" ]; then chmod u+r "$STATE"; fi
  local v
  v="$(jq -r "$1" "$STATE")" \
    || { echo "FATAL: could not query state with: $1" >&2; exit 1; }
  printf '%s' "$v"
}

# Feed one lens's raw verifier output through `verdict` into its canonical slot.
# $1 = lens, $2 = slot index (1-based), $3/$4 = the two verdict words.
write_verdict() {
  local lens="$1" slot="$2" v1="$3" v2="$4" rc payload
  payload="$(jq -nc --arg l "$lens" --arg f1 "$F1" --arg f2 "$F2" --arg v1 "$v1" --arg v2 "$v2" \
    '{criterion:$l,verdicts:[{finding_id:$f1,verdict:$v1,reasoning:("\($l) on f1")},{finding_id:$f2,verdict:$v2,reasoning:("\($l) on f2")}]}')" \
    || { echo "FATAL: jq failed building the verdict payload for lens '$lens'" >&2; exit 1; }
  rc="$(REVIEW_STDIN="$payload" helper verdict --lens "$lens" --runs-root "$RUNS_ROOT_REL" --manifest "$RUN_REL/manifest.json")"
  [ "$rc" = "0" ] || { echo "FATAL: verdict rejected valid output for lens '$lens': $(tr '\n' ' ' < "$ERR")" >&2; exit 1; }
  cp "$TMP/last.out" "$RUN_DIR/verdicts/verdict-$slot.json"
}

echo "Review-panel smoke test (driving the real hook CLI)"
echo "state: $STATE"
echo

write_state

# ── 1. brief: engine-authored, criticals only ─────────────────────────────────
echo "[1] review-panel brief"
rc="$(helper brief --runs-root "$RUNS_ROOT_REL" --run-dir "$RUN_REL" --wave 1)"
if [ "$rc" = "0" ] && [ -s "$RUN_DIR/brief.json" ] && [ -s "$RUN_DIR/brief.md" ]; then
  ok "brief written (exit 0)"
else
  bad "expected brief to succeed, got exit $rc / $(tr '\n' ' ' < "$ERR")"
fi

if [ "$(jq -r '[.findings[].id] | join(",")' "$RUN_DIR/brief.json")" = "$F1,$F2" ]; then
  ok "brief holds exactly the two critical findings, task-scoped"
else
  bad "brief finding ids wrong: $(jq -c '[.findings[].id]' "$RUN_DIR/brief.json")"
fi

# Guarded on the file FIRST: grep exits 2 on a missing path, which the bare
# negative branch read as "the advisory is absent" and reported as a pass.
if [ ! -s "$RUN_DIR/brief.json" ]; then
  bad "brief.json missing or empty — cannot prove the advisory was excluded"
elif grep -q "prefer a named constant" "$RUN_DIR/brief.json"; then
  bad "advisory leaked into the brief — advisories must skip the panel"
else
  ok "advisory excluded from the brief"
fi

if [ -s "$RUN_DIR/findings/finding-T1-code-reviewer-1.json" ]; then
  ok "per-finding artifact written"
else
  bad "expected a run-scoped artifact per finding"
fi

# ── 2. manifest + lenses: signal-driven, fixed before any verifier spawns ─────
echo "[2] review-panel manifest / lenses"
rc="$(helper manifest --runs-root "$RUNS_ROOT_REL" --run-dir "$RUN_REL")"
[ "$rc" = "0" ] && ok "manifest written and re-validated (exit 0)" \
  || bad "expected manifest to succeed, got exit $rc / $(tr '\n' ' ' < "$ERR")"

rc="$(helper lenses --runs-root "$RUNS_ROOT_REL" --manifest "$RUN_REL/manifest.json")"
LENSES="$(jq -r 'join(",")' "$TMP/last.out" 2>/dev/null || echo "")"
if [ "$rc" = "0" ] && [ "$LENSES" = "reproduction,intent,security" ]; then
  ok "lenses derived from the brief's signals: $LENSES"
else
  bad "expected reproduction,intent,security; got exit $rc / '$LENSES'"
fi

# A tampered manifest that drops a finding must not survive re-validation.
cp "$RUN_DIR/manifest.json" "$TMP/manifest.bak"
jq '.findings |= [.[0]]' "$TMP/manifest.bak" > "$RUN_DIR/manifest.json"
rc="$(helper lenses --runs-root "$RUNS_ROOT_REL" --manifest "$RUN_REL/manifest.json")"
if [ "$rc" != "0" ] && grep -q "review manifest contract failed" "$ERR"; then
  ok "tampered manifest (finding dropped) REJECTED"
else
  bad "expected a manifest contract failure, got exit $rc / $(tr '\n' ' ' < "$ERR")"
fi
cp "$TMP/manifest.bak" "$RUN_DIR/manifest.json"

# ── 3. verdict: a verifier can neither invent nor skip a finding ──────────────
echo "[3] review-panel verdict"
SKIPPED="$(jq -nc --arg f1 "$F1" '{criterion:"intent",verdicts:[{finding_id:$f1,verdict:"refuted",reasoning:"x"}]}')"
rc="$(REVIEW_STDIN="$SKIPPED" helper verdict --lens intent --runs-root "$RUNS_ROOT_REL" --manifest "$RUN_REL/manifest.json")"
# "verdicts is missing finding", not "is missing finding": the shorter string is
# also a substring of the MANIFEST diagnostic ("manifest is missing finding:"),
# so a tampered manifest surviving into this step passed the assertion while the
# real failure was two steps upstream.
if [ "$rc" != "0" ] && grep -q "verdicts is missing finding" "$ERR"; then
  ok "verifier that skipped a finding REJECTED"
else
  bad "expected a missing-finding rejection, got exit $rc / $(tr '\n' ' ' < "$ERR")"
fi

INVENTED="$(jq -nc --arg f1 "$F1" --arg f2 "$F2" \
  '{criterion:"intent",verdicts:[{finding_id:$f1,verdict:"refuted",reasoning:"x"},{finding_id:$f2,verdict:"refuted",reasoning:"y"},{finding_id:"T9:code-reviewer-7",verdict:"refuted",reasoning:"z"}]}')"
rc="$(REVIEW_STDIN="$INVENTED" helper verdict --lens intent --runs-root "$RUNS_ROOT_REL" --manifest "$RUN_REL/manifest.json")"
if [ "$rc" != "0" ] && grep -q "has unknown finding" "$ERR"; then
  ok "verifier that INVENTED a finding REJECTED"
else
  bad "expected an unknown-finding rejection, got exit $rc / $(tr '\n' ' ' < "$ERR")"
fi

STRAY="$(jq -nc --arg l "blast-radius" --arg f1 "$F1" --arg f2 "$F2" \
  '{criterion:$l,verdicts:[{finding_id:$f1,verdict:"refuted",reasoning:"x"},{finding_id:$f2,verdict:"refuted",reasoning:"y"}]}')"
rc="$(REVIEW_STDIN="$STRAY" helper verdict --lens blast-radius --runs-root "$RUNS_ROOT_REL" --manifest "$RUN_REL/manifest.json")"
if [ "$rc" != "0" ] && grep -q "must be one of the selected lenses" "$ERR"; then
  ok "verdict from an unselected lens REJECTED"
else
  bad "expected an unselected-lens rejection, got exit $rc / $(tr '\n' ' ' < "$ERR")"
fi

# 2 of 3 refute F1 (kills it); 1 of 3 refutes F2 (under threshold, survives).
write_verdict reproduction 1 refuted upheld
write_verdict intent       2 refuted refuted
write_verdict security     3 uncertain upheld
ok "three canonical verdicts written through the contract"

# ── 4. tally: adjudicate from disk, record rather than delete ─────────────────
echo "[4] review-panel tally"
rc="$(helper tally --runs-root "$RUNS_ROOT_REL" --manifest "$RUN_REL/manifest.json")"
if [ "$rc" = "0" ] && [ "$(jq -r '.surviving' "$TMP/last.out")" = "1" ] && [ "$(jq -r '.refuted' "$TMP/last.out")" = "1" ]; then
  ok "tally: 1 surviving, 1 refuted (threshold $(jq -r '.threshold' "$TMP/last.out"))"
else
  bad "expected 1 surviving / 1 refuted, got exit $rc / $(tr '\n' ' ' < "$TMP/last.out")"
fi

if [ "$(state_q '.tasks[0].critical_findings | join("|")')" = "catch block swallows the error" ]; then
  ok "refuted critical removed from critical_findings; the under-threshold one stands"
else
  bad "critical_findings wrong: $(state_q '.tasks[0].critical_findings | tojson')"
fi

if [ "$(state_q '.tasks[0].refuted_findings | length')" = "1" ] \
   && [ "$(state_q '[.tasks[0].refuted_findings[0].refutations[].lens] | join(",")')" = "reproduction,intent" ] \
   && [ "$(state_q '[.tasks[0].refuted_findings[0].refutations[] | select(.reason != "")] | length')" = "2" ]; then
  ok "refutation RECORDED with its refuting lenses and reasoning, not deleted"
else
  bad "refuted_findings wrong: $(state_q '.tasks[0].refuted_findings | tojson')"
fi

if [ "$(state_q '.tasks[0].findings | map(.id) | join(",")')" = "code-reviewer-2,silent-failure-hunter-1" ]; then
  ok "authoritative findings array stayed in lockstep with its derived views"
else
  bad "findings array wrong: $(state_q '.tasks[0].findings | map(.id) | tojson')"
fi

if [ "$(state_q '.tasks[0].review_status')" = "blocked" ]; then
  ok "one critical survived, so the block stands"
else
  bad "expected review_status=blocked, got $(state_q '.tasks[0].review_status')"
fi

if [ "$(state_q '.tasks[0].advisory_findings | join("|")')" = "prefer a named constant" ]; then
  ok "advisories untouched by the panel"
else
  bad "advisory_findings wrong: $(state_q '.tasks[0].advisory_findings | tojson')"
fi

# ── 5/6. the verifier agent's harness wiring ──────────────────────────────────
echo "[5] validate-phase-order: review-verifier-agent during execute"
# Deliberately regex-NEUTRAL prompt: "review"/"design"/"spec" could match
# detectPhase's prompt-regex fallbacks, so this proves the REVIEW_PANEL_AGENTS
# recognition path specifically.
rc="$(run_gate review-verifier-agent "adjudicate the items in the manifest")"
[ "$rc" = "0" ] && ok "ALLOWED (exit 0)" \
  || bad "expected allow (exit 0), got exit $rc / $(tr '\n' ' ' < "$ERR")"

echo "[6] subagent-stop: review-verifier-agent completion is a passthrough"
BEFORE="$(state_q '.tasks[0].review_status')"
rc="$(run_stop review-verifier-agent)"
AFTER="$(state_q '.tasks[0].review_status')"
# In REVIEW_SUB_AGENTS the verifier's transcript would be parsed for a
# CRITICAL_COUNT it never emits, flipping the task to evidence_capture_failed —
# a passing wave blocked by the agent that was there to unblock it.
if [ "$rc" = "0" ] && [ "$AFTER" = "$BEFORE" ]; then
  ok "review_status unchanged ($AFTER) — not parsed for findings it never emits"
else
  bad "expected passthrough leaving review_status=$BEFORE, got exit $rc / status=$AFTER"
fi

echo
echo "──────────────────────────────────────────"
echo "PASS: $PASS   FAIL: $FAIL"
if [ "$FAIL" -ne 0 ]; then
  echo "Review-panel smoke test FAILED."
  exit 1
fi
echo "Review-panel smoke test PASSED."
