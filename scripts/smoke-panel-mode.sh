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
# Steps 1-6 are the phase gating AROUND the panel. Steps 7-11 are the panel
# itself — the `helper panel-contract` chain the orchestrator walks:
#
#   7. `interview` canonicalizes the interviewer's markdown digest to JSON, and
#      REJECTS a truncated one.
#   8. `manifest` binds the candidate set to the run, and REJECTS a manifest
#      missing a designer that never ran.
#   9. `criteria` DERIVES the judge criteria from the validated digest — the
#      orchestrator never chooses them.
#  10. `verdict` canonicalizes one judge's output per criterion, and REJECTS a
#      criterion the digest does not derive and a judge that skipped candidates.
#  11. `aggregate` re-reads every verdict from disk and ranks, and REJECTS a
#      verdict in the wrong slot or a panel with a missing verdict.
#
# What steps 7-11 add over tests/handlers/helpers/panel-contract.test.ts, which
# already drives each operation through this same CLI: that test hand-builds an
# independent fixture per operation, so it cannot catch a step whose canonical
# OUTPUT is not valid INPUT to the next. Here the chain composes for real —
# `interview.json` is the stdout of `interview`, the `--criterion` flags are the
# stdout of `criteria`, and each `verdict-N.json` is the stdout of `verdict`.
# That seam is what `commands/loom.md` walks an orchestrator across, and it is
# the one thing neither the unit tests nor the prose drift-guards can prove.
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

# SubagentStop Hooks require exact session TaskGraph authority. Publish the same
# pointer SessionStart establishes; local LOOM_STATE_PATH fallback is reserved
# for non-session helpers and must not authorize these writes.
printf '%s' "$STATE" > "$LOOM_SUBAGENT_DIR/$SESSION.task_graph"

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
  payload="$(jq -nc --arg a "$agent" --arg i "smoke-$agent" --arg s "$SESSION" --arg c "$TMP" \
    '{agent_type:$a,agent_id:$i,session_id:$s,cwd:$c}')" \
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
# green. This prompt matches no detectPhase regex, so the allow proves the
# explicit ARCH_PANEL_AGENTS recognition branch specifically.
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

# ══════════════════════════════════════════════════════════════════════════════
# The panel-contract chain: every step consumes the PREVIOUS step's real output
# ══════════════════════════════════════════════════════════════════════════════
#
# Steps 1-6 prove the phase gating around the panel. These prove the panel
# itself, and specifically the thing no unit test can: that the chain COMPOSES.
#
# tests/handlers/helpers/panel-contract.test.ts already drives each operation
# through the real CLI — but it hand-builds an independent fixture for each one.
# That cannot catch a step whose canonical output is not valid input to the next
# step, which is exactly the seam `commands/loom.md` walks an orchestrator
# across. Here `interview.json` IS the stdout of `interview`, the `--criterion`
# flags ARE the stdout of `criteria`, and each `verdict-N.json` IS the stdout of
# `verdict`. Nothing is hand-written that the engine can produce.

RUNS_ROOT="$TMP/.claude/architecture/panel-runs"
RUN_DIR="$RUNS_ROOT/run.smoke"
MANIFEST="$RUN_DIR/manifest.json"
DESIGNERS=3
CONTRACT_ERR="$TMP/last-contract.err"
CONTRACT_OUT="$TMP/last-contract.out"

mkdir -p "$RUN_DIR/candidates" "$RUN_DIR/verdicts"

# Run a panel-contract helper; echo the exit code. stdout/stderr land in files
# so a caller can assert on canonical output AND tell a contract rejection from
# a crash (both exit non-zero). cwd = $TMP for the same containment reason as
# run_gate.
contract() {
  local input="${PANEL_STDIN:-}" rc=0
  printf '%s' "$input" \
    | ( cd "$TMP" && bun "$CLI" helper panel-contract "$@" ) >"$CONTRACT_OUT" 2>"$CONTRACT_ERR" || rc=$?
  echo "$rc"
}

CONTRACT_ARGS=(--runs-root "$RUNS_ROOT" --manifest "$MANIFEST" --designers "$DESIGNERS")

# The interviewer's markdown digest. `simplicity` + `brownfield` are the signals
# that decide both the lens set and the criteria below, so they are load-bearing
# fixture values, not filler.
DIGEST_MD="$RUN_DIR/interview.md"
cat > "$DIGEST_MD" <<'DIGEST'
**Primary axis:** simplicity
**Testability bar:** pure functional core
**Sensitive boundaries:** none
**Codebase maturity:** brownfield
**Codebase constraints:** existing engine boundaries
**Error-handling philosophy:** Either/Result end-to-end
**Concurrency & state:** stateless
**Data & persistence:** none
**Tech preferences:** TypeScript
**Observability:** diagnostics
**Backwards compatibility:** preserve CLI
**Deployment:** none
**Out-of-scope:** state migration
**Executable-model signal:** none
DIGEST

# ── 7. interview: markdown digest → canonical JSON ────────────────────────────
echo "[7] panel-contract interview: digest → canonical JSON"
rc="$(PANEL_STDIN="$(cat "$DIGEST_MD")" contract interview)"
if [ "$rc" != "0" ]; then
  bad "interview rejected a well-formed digest: $(tr '\n' ' ' < "$CONTRACT_ERR")"
else
  # The canonical output IS the file every later step reads. Hand-writing it
  # here would hide a drift between what `interview` emits and what
  # `parseInterviewDigestJson` accepts on the way back in.
  cp "$CONTRACT_OUT" "$RUN_DIR/interview.json"
  axis="$(jq -r '.primaryAxis' "$RUN_DIR/interview.json")" \
    || { echo "FATAL: could not read primaryAxis from canonical interview" >&2; exit 1; }
  [ "$axis" = "simplicity" ] && ok "canonical digest round-trips (primaryAxis=simplicity)" \
    || bad "expected primaryAxis=simplicity, got '$axis'"
fi

rc="$(PANEL_STDIN='**Primary axis:** simplicity' contract interview)"
if [ "$rc" = "0" ]; then
  bad "interview ACCEPTED a digest missing thirteen fields"
elif grep -q "interview digest contract failed" "$CONTRACT_ERR"; then
  ok "truncated digest REJECTED with a contract diagnostic"
else
  bad "truncated digest failed, but not as a contract rejection: $(tr '\n' ' ' < "$CONTRACT_ERR")"
fi

# ── 8. manifest: the candidate set is fixed before any judge runs ─────────────
echo "[8] panel-contract manifest: candidate set bound to the run"
# Lens selection is DERIVED from the digest: the two baselines, then
# `codebase-conventionist` because maturity is brownfield. An orchestrator that
# guessed a different set would fail the manifest comparison below.
LENSES=(simplicity-first type-driven-fp codebase-conventionist)
for lens in "${LENSES[@]}"; do
  printf '# candidate: %s\n' "$lens" > "$RUN_DIR/candidates/candidate-$lens.md"
done

write_manifest() {
  jq -nc \
    --arg run_id "run.smoke" \
    --arg interview_file "$DIGEST_MD" \
    --arg interview_json "$RUN_DIR/interview.json" \
    --arg dir "$RUN_DIR/candidates" \
    --args '
      {
        run_id: $run_id,
        interview_file: $interview_file,
        interview_json: $interview_json,
        candidates: [$ARGS.positional[] | {
          lens: .,
          path: ($dir + "/candidate-" + . + ".md"),
          filename: ("candidate-" + . + ".md")
        }]
      }' "$@" > "$MANIFEST" \
    || { echo "FATAL: jq failed building the panel manifest" >&2; exit 1; }
}

write_manifest "${LENSES[@]}"
rc="$(contract manifest "${CONTRACT_ARGS[@]}")"
[ "$rc" = "0" ] && ok "manifest validated against the derived lens set" \
  || bad "manifest rejected a well-formed candidate set: $(tr '\n' ' ' < "$CONTRACT_ERR")"

# A designer that never ran is the failure the manifest exists to prevent: two
# candidates would satisfy every later length check vacuously and the panel
# would silently become a two-way vote.
write_manifest simplicity-first type-driven-fp
rc="$(contract manifest "${CONTRACT_ARGS[@]}")"
if [ "$rc" = "0" ]; then
  bad "manifest ACCEPTED a dropped candidate — the panel would shrink silently"
elif grep -q "panel manifest contract failed" "$CONTRACT_ERR"; then
  ok "manifest with a dropped candidate REJECTED"
else
  bad "dropped-candidate manifest failed, but not as a contract rejection"
fi
write_manifest "${LENSES[@]}"

# ── 9. criteria: derived from the digest, not supplied by the caller ──────────
echo "[9] panel-contract criteria: derived from the validated digest"
rc="$(contract criteria "${CONTRACT_ARGS[@]}")"
if [ "$rc" != "0" ]; then
  bad "criteria failed on a validated run: $(tr '\n' ' ' < "$CONTRACT_ERR")"
  CRITERIA=()
else
  # Read the criteria the ENGINE derived, and drive the judges off them. The
  # orchestrator never chooses these — that is the whole point of deriving them.
  mapfile -t CRITERIA < <(jq -r '.[]' "$CONTRACT_OUT") \
    || { echo "FATAL: could not read derived criteria" >&2; exit 1; }
  if [ "${#CRITERIA[@]}" = "3" ] \
    && [ "${CRITERIA[0]}" = "simplicity" ] \
    && [ "${CRITERIA[1]}" = "pure functional core" ]; then
    ok "criteria derived from digest signals: ${CRITERIA[*]}"
  else
    bad "unexpected derived criteria: ${CRITERIA[*]}"
  fi
fi

# ── 10. verdict: one judge per criterion, through the contract ────────────────
echo "[10] panel-contract verdict: judge output canonicalized per criterion"

# $1 = criterion, $2..$4 = scores for the three candidates in LENSES order.
# Rankings must be emitted in non-increasing score order, which is itself part
# of the contract, so the payload is sorted before it is submitted.
judge_payload() {
  local criterion="$1" s1="$2" s2="$3" s4="$4"
  jq -nc --arg c "$criterion" \
    --arg a "candidate-${LENSES[0]}.md" --argjson as "$s1" \
    --arg b "candidate-${LENSES[1]}.md" --argjson bs "$s2" \
    --arg d "candidate-${LENSES[2]}.md" --argjson ds "$s4" \
    '{criterion:$c, rankings: ([
        {candidate:$a, score:$as, fatal_flaw:null, strongest_idea:"clear seams"},
        {candidate:$b, score:$bs, fatal_flaw:null, strongest_idea:"illegal states unrepresentable"},
        {candidate:$d, score:$ds, fatal_flaw:null, strongest_idea:"matches existing boundaries"}
      ] | sort_by(-.score))}'
}

if [ "${#CRITERIA[@]}" = "3" ]; then
  # type-driven-fp wins two criteria and ties the third — a clear aggregate
  # winner, so the ranking assertion in step 11 is not decided by a tie-break.
  SCORES=("8 9 7" "6 9 7" "7 8 8")
  slot=1
  chain_ok=1
  for criterion in "${CRITERIA[@]}"; do
    # shellcheck disable=SC2086
    payload="$(judge_payload "$criterion" ${SCORES[$((slot-1))]})" \
      || { echo "FATAL: jq failed building the judge payload for '$criterion'" >&2; exit 1; }
    rc="$(PANEL_STDIN="$payload" contract verdict --criterion "$criterion" "${CONTRACT_ARGS[@]}")"
    if [ "$rc" != "0" ]; then
      bad "verdict rejected valid judge output for '$criterion': $(tr '\n' ' ' < "$CONTRACT_ERR")"
      chain_ok=0
      break
    fi
    # Canonical stdout, not the raw payload — a judge's output reaches the
    # aggregate ONLY through the contract that sanitized it.
    cp "$CONTRACT_OUT" "$RUN_DIR/verdicts/verdict-$slot.json"
    slot=$((slot+1))
  done
  [ "$chain_ok" = "1" ] && ok "three canonical verdicts written through the contract" || true
else
  bad "skipping verdict chain — criteria step did not produce three criteria"
  chain_ok=0
fi

# A criterion this digest does not derive must be refused at the verdict step,
# where the orchestrator can still fix it — not at aggregate, where the
# diagnostic could not say which step lied.
payload="$(judge_payload "elegance" 5 5 5)"
rc="$(PANEL_STDIN="$payload" contract verdict --criterion "elegance" "${CONTRACT_ARGS[@]}")"
if [ "$rc" = "0" ]; then
  bad "verdict ACCEPTED a criterion the digest never derived"
elif grep -q "judge verdict contract failed" "$CONTRACT_ERR"; then
  ok "undeclared criterion REJECTED at the verdict step"
else
  bad "undeclared criterion failed, but not as a contract rejection"
fi

# A judge that scored only two of three candidates would make the aggregate a
# partial vote that still ranks cleanly.
payload="$(jq -nc --arg c "${CRITERIA[0]:-simplicity}" --arg a "candidate-${LENSES[0]}.md" \
  '{criterion:$c, rankings:[{candidate:$a, score:9, fatal_flaw:null, strongest_idea:"only one"}]}')"
rc="$(PANEL_STDIN="$payload" contract verdict --criterion "${CRITERIA[0]:-simplicity}" "${CONTRACT_ARGS[@]}")"
if [ "$rc" = "0" ]; then
  bad "verdict ACCEPTED a judge that skipped two candidates"
elif grep -q "judge verdict contract failed" "$CONTRACT_ERR"; then
  ok "judge that skipped candidates REJECTED"
else
  bad "judge that skipped candidates failed, but not as a contract rejection: $(tr '\n' ' ' < "$CONTRACT_ERR")"
fi

# ── 11. aggregate: re-read from disk and rank ─────────────────────────────────
echo "[11] panel-contract aggregate: deterministic ranking from disk"
if [ "${chain_ok:-0}" != "1" ]; then
  bad "skipping aggregate — the verdict chain did not complete"
else
  rc="$(contract aggregate "${CONTRACT_ARGS[@]}")"
  if [ "$rc" != "0" ]; then
    bad "aggregate failed on a complete verdict set: $(tr '\n' ' ' < "$CONTRACT_ERR")"
  else
    winner="$(jq -r '.ranking[0].candidate' "$CONTRACT_OUT")"
    total="$(jq -r '.ranking[0].total_score' "$CONTRACT_OUT")"
    [ "$winner" = "candidate-${LENSES[1]}.md" ] && [ "$total" = "26" ] \
      && ok "ranked from disk: $winner wins with $total (9+9+8)" \
      || bad "expected candidate-${LENSES[1]}.md at 26, got '$winner' at '$total'"

    ranked_count="$(jq -r '.ranking | length' "$CONTRACT_OUT")"
    [ "$ranked_count" = "3" ] && ok "every candidate ranked, none dropped" \
      || bad "expected 3 ranked candidates, got $ranked_count"
  fi

  # The slot binding: verdict-N.json is read as criterion N. Swapping two files
  # must be a hard error, not a silent mis-adjudication that still ranks.
  mv "$RUN_DIR/verdicts/verdict-1.json" "$TMP/held.json"
  cp "$RUN_DIR/verdicts/verdict-2.json" "$RUN_DIR/verdicts/verdict-1.json"
  rc="$(contract aggregate "${CONTRACT_ARGS[@]}")"
  if [ "$rc" = "0" ]; then
    bad "aggregate ACCEPTED a verdict written into the wrong slot"
  elif grep -q "panel verdicts contract failed" "$CONTRACT_ERR"; then
    ok "verdict in the wrong criterion slot REJECTED"
  else
    bad "wrong-slot verdict failed, but not as a verdicts contract rejection: $(tr '\n' ' ' < "$CONTRACT_ERR")"
  fi
  cp "$TMP/held.json" "$RUN_DIR/verdicts/verdict-1.json"

  # A judge that never ran leaves a gap. An empty item set satisfies every
  # length rule vacuously, so this must fail loudly rather than rank two-thirds
  # of a panel as if it were the whole thing.
  rm "$RUN_DIR/verdicts/verdict-3.json"
  rc="$(contract aggregate "${CONTRACT_ARGS[@]}")"
  if [ "$rc" = "0" ]; then
    bad "aggregate ACCEPTED a panel with a missing verdict"
  elif grep -q "panel verdicts contract failed" "$CONTRACT_ERR"; then
    ok "missing verdict REJECTED — a partial panel ranks nothing"
  else
    bad "missing verdict failed, but not as a verdicts contract rejection: $(tr '\n' ' ' < "$CONTRACT_ERR")"
  fi
fi

echo
echo "──────────────────────────────────────────"
echo "PASS: $PASS   FAIL: $FAIL"
[ "$FAIL" -eq 0 ] && { echo "Panel mode smoke test PASSED."; exit 0; } || { echo "Panel mode smoke test FAILED."; exit 1; }
