---
name: wave-gate
version: "2.1.0"
description: "Run after wave implementation complete. Executes test + spec-check + review gate sequence. Usage: /wave-gate"
---

# Wave Gate - Test, Spec & Review Sequence

Executes the gate sequence after all wave tasks reach "implemented". Verifies test evidence, checks spec alignment, spawns code reviewers, and advances waves.

**Run this after SubagentStop hook outputs "Wave N implementation complete".**

**Explicit model policy:** before every Agent spawn, run
`bun ${LOOM_DIR}/engine/src/cli.ts helper model-profiles agent --agent <name>`.
Claude Code passes `claudeCode.model` explicitly; Pi uses the generated agent
definition with the exact `pi` binding. Missing/mismatched models block — never
inherit the orchestrator's current model.

**Resolve the active package first** (if not already set from `/loom`). Claude
Code expands the shared-source token; Loom's Pi adapter renders it from the
extension module's `import.meta.url`:
```bash
LOOM_DIR="${CLAUDE_PLUGIN_ROOT}"
test -f "$LOOM_DIR/engine/src/cli.ts" || { echo "FATAL: active Loom package is incomplete: $LOOM_DIR"; exit 1; }
```
Never infer package identity from cwd or another harness's install cache.

**Important:** State file writes via Bash are blocked by `guard-state-file`. All state mutations happen through SubagentStop hooks and whitelisted helper scripts. Read access (jq, cat) is allowed.

---

## Sequence

### Step 1: Verify State

```bash
jq '{wave: .current_wave, impl_complete: .wave_gates[.current_wave | tostring].impl_complete}' .claude/state/active_task_graph.json
```

Abort if `impl_complete != true`.

### Step 2: Verify Test Evidence

Test evidence is set **automatically** by the `update-task-status` SubagentStop hook when implementation agents complete. It resolves each task's `test_result` — a trusted verdict from the evidence ledger (`{"verdict": "trusted-pass"}` / `{"verdict": "trusted-fail"}`) when execution-time ground truth exists, or a labeled `{"verdict": "untrusted", "passed": ..., "label": ...}` when only transcript pass markers (Maven, Node, Vitest, pytest) are available — plus a human-readable `test_evidence` line.

**Check evidence status (read-only):**
```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper mark-tests-passed
```

This prints per-task evidence status. Exit 0 = all tasks have evidence, exit 1 = missing.

**If evidence missing** → re-spawn the implementation agent for that task. The agent MUST run tests and must produce ledger evidence (a real Bash test run) or transcript pass markers.

If evidence is present but a task still carries a failed proof from an older Pi
completion path, reconcile the aggregate from its persisted completion/test/write
evidence and current artifact bytes before re-running implementation:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper reconcile-implementation-proof --wave "<WAVE>"
```

The helper does not manufacture evidence: a task remains pending and prints its
exact failed obligations when completion, test provenance, new tests, or an
attributed declared-artifact byte change is still missing.

**New test verification:** The `update-task-status` SubagentStop hook also checks that agents wrote NEW test methods (not just reran existing). It diffs against the per-task `start_sha` baseline (set by PreToolUse hook) to scope detection to each task's changes. Both a passing `test_result` and `new_tests_written == true` are required for the wave gate to pass.

**Do NOT manually run tests or set test flags.** The guard hook blocks direct state file writes. Evidence can only come from agent execution → SubagentStop hook extraction.

### Step 3: Build Review Packets and Spawn Verification (Parallel)

Before any reviewer starts, create one immutable Review Packet per Task. The
packet binds the Task, proof obligations, base/head revisions, exact diff and
postimages, declared/modified paths, and plan context. Postimages preserve their
original bytes: valid text is stored as `utf8`, while binary content is `base64`;
the digest always hashes the decoded/original bytes. Reviewers MUST read only
the packet's manifest-listed scope; never fall back to all wave changes or scan
the live worktree.

```bash
mkdir -p ".claude/reviews/packets"
REVIEW_PACKET_DIR="$(mktemp -d ".claude/reviews/packets/run.XXXXXXXXXX")"
bun ${LOOM_DIR}/engine/src/cli.ts helper review-packet create \
  --task "<TASK_ID>" \
  --output "$REVIEW_PACKET_DIR/<TASK_ID>.json"
```

Run `create` once for each Task needing review. It canonicalizes tool-recorded
absolute paths only when they are inside the current repository (legacy state
included), rejects traversal/external/symlink paths, fails on an empty scope,
and refuses to overwrite a packet. Retain each concrete packet path;
shell variables do not persist across Bash calls. Verify before spawning:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper review-packet verify \
  --packet ".claude/reviews/packets/<RUN>/<TASK_ID>.json"
```

Spawn **spec-check AND code reviewers** in a single message with multiple Agent calls.

**Get wave info** (self-contained jq — the guard blocks `WAVE=$(jq … state)`
capture-into-variable, and shell variables do not persist across Bash tool
calls anyway, so read the values directly):
```bash
# Current wave number:
jq -r '.current_wave' .claude/state/active_task_graph.json
# Task IDs in the current wave (wave resolved inside the same jq program):
jq -r '.current_wave as $w | .tasks[] | select(.wave == $w) | .id' .claude/state/active_task_graph.json | tr '\n' ','
```

**Get wave changes:**
```bash
BASE=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's|origin/||' || echo "main")
git diff --name-only $BASE...HEAD
```

**Get tasks needing review:**
```bash
jq -r '.current_wave as $w | .tasks[] | select(.wave == $w) | select(.review_status == "pending" or .review_status == "blocked") | .id' .claude/state/active_task_graph.json
```

**Spawn ALL in parallel (single message, multiple Agent calls):**

1. **Spec-check invoker** (always, once per wave):
```markdown
## Spec Alignment Check
**Wave:** {wave}
**Tasks:** {task_ids}

Invoke /spec-check to verify implementation aligns with specification.
Output format required:
- SPEC_CHECK_WAVE: {wave}
- CRITICAL/HIGH/MEDIUM findings
- SPEC_CHECK_CRITICAL_COUNT: N
- SPEC_CHECK_VERDICT: PASSED | BLOCKED
```

2. **Review agents per task** (for each task needing review, spawn ALL in parallel):
   - `loom:code-reviewer` — style, patterns, best practices
   - `loom:silent-failure-hunter` — error handling, silent swallowing
   - `loom:pr-test-analyzer` — test coverage and quality
   - `loom:type-design-analyzer` — type safety and design
   - `loom:comment-analyzer` — comment accuracy and completeness

Each review agent gets the same prompt:
````markdown
## Task: {task_id}
**Description:** {task description}

Review Packet: {review_packet_path}
Task: {task_id}

Read and verify the Review Packet, then review exactly its scoped artifacts.
Do not discover a broader live-worktree scope. Produce a Machine Summary with
CRITICAL_COUNT, CRITICAL, and ADVISORY lines.

Also emit a fenced ```findings JSON block inside the Machine Summary: one entry
per finding as {"severity": "critical"|"advisory", "file": path|null,
"line": number|null, "claim": "the single assertion to refute"}, in the same
order as your CRITICAL/ADVISORY lines. Never invent an id. If you cannot locate
a finding, use null rather than guessing — a wrong location is worse than none.
````

The engine derives stable identity from reviewer agent and emission order. The
block adds preferred file/line metadata; without it the marker lines are parsed
instead and the findings remain adjudicable with null locations — degraded, not
broken.

**What happens automatically on completion:**

| Agent | SubagentStop Hook | Effect |
|-------|-------------------|--------|
| spec-check-invoker | `store-spec-check-findings` | Sets `spec_check.critical_count`, `spec_check.verdict` |
| code-reviewer | `store-reviewer-findings` | Merges findings into task `review_status` |
| silent-failure-hunter | `store-reviewer-findings` | Merges findings into task `review_status` |
| pr-test-analyzer | `store-reviewer-findings` | Merges findings into task `review_status` |
| type-design-analyzer | `store-reviewer-findings` | Merges findings into task `review_status` |
| comment-analyzer | `store-reviewer-findings` | Merges findings into task `review_status` |

**Task-to-review mapping algorithm:**
1. Read `task.file_list` and `task.files_modified` through `helper review-packet create`.
2. The helper canonicalizes their union and snapshots every scoped path.
3. Empty scope is an error that must be repaired in decomposition; there is NO broad fallback.
4. Pass only `{review_packet_path}` to each review agent.

### Step 3.5: Refutation Panel (adversarial review)

Five reviewers produce findings; nothing adjudicates them. A plausible-but-wrong
critical finding costs a real remediation cycle. This step fans N verifiers —
each with a **distinct lens** — across **all** of the wave's critical findings,
and kills a finding only when a threshold of them refutes it.

**Only critical findings are verified.** Advisories do not block the gate, so
refuting one saves nothing while the quota it burns is real. Refuted findings
are **recorded, not deleted** — a wrong refutation must stay auditable.

**Skip this step entirely when the wave has zero critical findings** — the panel
would have nothing to adjudicate. The `// 0` is load-bearing: `add` over an empty
array yields `null`, which does not compare equal to `0` and would send you into
a panel run on an empty set:
```bash
jq -r '[.current_wave as $w | .tasks[] | select(.wave == $w) | (.critical_findings // []) | length] | add // 0' .claude/state/active_task_graph.json
```

`brief` (Step 3.5.1) enforces this too and will refuse to build an empty or
partial finding set, so a mis-read here fails loudly rather than producing a
green panel that adjudicated nothing.

#### 3.5.0 — Create a run-scoped artifact boundary

```bash
REVIEW_RUNS_DIR=".claude/reviews/panel-runs"
mkdir -p "$REVIEW_RUNS_DIR" || exit 1
REVIEW_RUN_DIR="$(mktemp -d "$REVIEW_RUNS_DIR/run.XXXXXXXXXX")" || exit 1
printf '%s\n' "$REVIEW_RUN_DIR"
```

Retain the printed path and substitute its concrete value in later calls; shell
variables do not persist across Bash tool calls. Never reuse an existing run
directory — old runs remain as audit data but are never read implicitly.

#### 3.5.1 — Build the brief (engine-authored)

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper review-panel brief \
  --runs-root ".claude/reviews/panel-runs" \
  --run-dir "<review-run-dir>" \
  --wave "<N>"
```

The engine reads the wave's critical findings from state and writes `brief.md`,
`brief.json`, and one `findings/finding-<id>.json` artifact per finding. The
same operation also accepts `--standalone <aggregate.json>` for the standalone
`/review-pr` and `/review-and-fix` adapter; the wave gate MUST use `--wave` and
must never pass both source flags. You do
**not** assemble this by hand: the findings already exist in the task graph, and
a hand-built brief could quietly omit an inconvenient critical.

`brief` proves its own completeness and **fails** rather than building a set the
panel cannot honestly adjudicate — a wave with no tasks (check `--wave` against
`.current_wave`), a wave with no criticals (skip the step), or a wave whose
criticals lack structured identity (re-run the reviewers, or repair the graph
with `helper validate-task-graph --fix`). An empty brief would otherwise satisfy
every downstream length and coverage rule vacuously and report
"0 survived, 0 refuted" — indistinguishable from a panel that upheld nothing.

#### 3.5.2 — Fix the finding and lens sets

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper review-panel manifest \
  --runs-root ".claude/reviews/panel-runs" \
  --run-dir "<review-run-dir>"
```

Writes and immediately re-validates `manifest.json`, binding the run id, the
brief paths, the exact lens list, and every finding's run-scoped path. This
manifest is the sole finding-set authority for all later stages — a verifier can
neither invent a finding nor skip one. Stop on failure.

Read back the selected lenses (derived from the brief's signals, never chosen by
hand):
```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper review-panel lenses \
  --runs-root ".claude/reviews/panel-runs" \
  --manifest "<review-run-dir>/manifest.json"
```

`reproduction` and `intent` are always included. Both signals then match a
finding's **path or claim text**, symmetrically: auth/crypto/injection pulls in
`security`, and a test path or a claim about tests pulls in `test-coverage`. The
claim is matched for both because `file` is `null` on every finding the line
scraper produced — while `test-coverage` keyed off the path alone, a wave whose
findings were entirely test-coverage claims could never pull in the lens that
judges them. The table order in
[review-lenses.md](../references/review-lenses.md) fills the rest, so an
unsignalled panel gets `blast-radius` third: cause, intent, consequence.

Default panel size is 3. Pass `--lenses N` (2–5) to `manifest` to change it —
**only to `manifest`**. The manifest records the size, and every later operation
recovers it from the file rather than needing the flag threaded through.

**The size is fixed for the life of the run.** Once `manifest.json` records a
lens count, re-running `manifest` without `--lenses` keeps it, and a `--lenses`
that disagrees is a hard error — start a new run directory instead. Re-deriving
the lens SET does not protect the size on its own: `selectReviewLenses` returns
nested prefixes, so a shorter lens list reproduces its own derivation exactly
and passes the name-by-name comparison. A shrunken panel would be adjudicated
under a lower absolute refutation bar, with the surplus verdicts ignored. The
`tally` also rejects a verdicts directory holding more `verdict-N.json` files
than the panel has lenses, for the same reason.

#### 3.5.3 — Spawn the verifiers (parallel, headless)

The executable Panel Program owns verifier count/order, one-retry policy, and
LLM Profile assignment. Build a program document from the exact manifest ids
and ordered lenses:

```json
{
  "input": {
    "criticalFindingIds": ["<finding id 1>", "<finding id N>"],
    "lenses": ["<lens 1>", "<lens N>"]
  },
  "events": []
}
```

Pipe it to:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper panel-program refutation
```

Execute only the returned action. After each verifier result, append its
canonical `spawn-outcome` event and replay the whole document. The program emits
`tally` only after every exact slot succeeds; a failed second attempt emits
`blocked`. Completion order cannot change the next action.

**Load template:** Read `{LOOM_DIR}/commands/templates/review-verify.md`. For
each selected lens, substitute `{lens_name}`, `{lens_prompt}` (that lens's
section from `{LOOM_DIR}/references/review-lenses.md`),
`{finding_manifest_path}`, and `{brief_file_path}`.

**Spawn the exact `review-verifier-agent` batch returned by the Panel Program in ONE message** (parallel Agent calls), using each request's resolved `modelProfile`.
Validate each raw output before it reaches the tally — **`verdict-N.json` must
hold lens N**, in the manifest's lens order:

```bash
printf '%s' "$RAW_VERIFIER_OUTPUT" | bun ${LOOM_DIR}/engine/src/cli.ts helper review-panel verdict \
  --lens "$EXACT_LENS" \
  --runs-root ".claude/reviews/panel-runs" \
  --manifest "<review-run-dir>/manifest.json" \
  > "<review-run-dir>/verdicts/verdict-1.json"
```

Perform each validation in the same Bash call that defines the shown shell
variables. The helper requires valid JSON, a lens drawn from the selected set,
exact lens identity, every manifest finding exactly once, no foreign or
duplicate findings, a verdict of `refuted`/`upheld`/`uncertain`, and non-empty
reasoning; it strips curly braces from validated prose and emits canonical JSON.
Re-spawn only an invalid verifier with diagnostics, once; if still invalid, stop.

#### 3.5.4 — Tally (deterministic, no agent)

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper review-panel tally \
  --runs-root ".claude/reviews/panel-runs" \
  --manifest "<review-run-dir>/manifest.json"
```

`tally` re-reads and re-validates **every** verdict file from the run directory
(it does not trust Step 3.5.3's output), atomically claims the run and publishes
run-scoped `outcomes.json` before updating task state, reads `verdict-N.json` as
**lens N**, and
rejects any file whose `criterion` does not match that slot, then verifies the
collected set is exactly the selected lenses with no duplicates or omissions, and
adjudicates:

- A finding **survives** unless at least `threshold` verifiers refuted it. The
  threshold is a strict majority of the panel (2 of 3, 3 of 5, 2 of 2), and that
  majority is a **floor, not just a default**: `--threshold` may only RAISE the
  bar. A value below the majority is rejected — a panel where one lens can kill a
  critical on its own is a weaker panel wearing the same name.
- `uncertain` counts toward **neither** side.
- **Ties favor keeping the finding** — a false positive costs a cycle, a false
  negative ships a bug.

Refuted findings move out of the task's `critical_findings` into
`refuted_findings`, carrying the refuting lenses and their reasoning. A task
whose criticals were **all** refuted moves from `blocked` to `passed` — the only
place that demotion **adjudicates** anything, because deciding whether the block
stands is this panel's entire purpose. (The manual `store-review-findings`
override and `complete-wave-gate`'s advancement also write `passed`; neither
adjudicates a finding.)

Any failure is fatal: stop and report. Only then does Step 5 count criticals.

**Include the outcome in the GH comment** (Step 4): list refuted findings with
the lenses that killed them and why. A refutation nobody can see is a deletion.

### Step 4: Post GH Comment

After all verification agents complete, read status and post summary:

```bash
gh issue comment {ISSUE} --body "$(cat <<'EOF'
## Wave {N} Verification

### Spec Alignment
**Status:** {PASSED | BLOCKED}
{if blocked: list critical findings}

### Code Review

#### T1: {description}
**Status:** PASSED | BLOCKED - {N} critical, {N} advisory
**Critical:**
- {surviving critical findings list, if any}
**Refuted by the panel:**
- {refuted finding} — refuted by {lenses}: {reasoning}
**Advisory:**
- {ALL advisory findings — always include, even for PASSED tasks}

#### T2: {description}
...

---
**Wave Status:** PASSED - Ready to advance | BLOCKED - fix issues
EOF
)"
```

**If GH comment fails** (rate limit, auth, network):
- Log summary to `.claude/reviews/wave-{N}-review.md` as fallback (NOT under `.claude/state/` — that directory is guarded against every write path)
- Proceed with gate logic - don't block on comment failure
- Retry comment post after gate decision

### Step 4b: Triage & Fix Relevant Advisories

Critical findings block the gate (Step 5). Advisory findings do **not** block — but they must not be silently dropped. Classifying and reporting every advisory is a mandatory workflow step before advancement; it is not an additional deterministic gate condition, and `complete-wave-gate` blocks only on unresolved critical findings.

**Read the advisories** (self-contained jq — the wave is resolved inside the
program; `WAVE=$(jq … state)` is blocked by the guard):
```bash
jq -r '.current_wave as $w | .tasks[] | select(.wave == $w) | select((.advisory_findings // []) | length > 0) | {id, advisory_findings}' .claude/state/active_task_graph.json
```

**Classify each advisory:**
- **Relevant** — in scope for the task, actionable, and consistent with project standards (the repo's `CLAUDE.md` / conventions) → **fix it**.
- **Not relevant** — out-of-scope refactor, nitpick that contradicts an established project convention, false positive, or work deliberately deferred to a later wave → record a one-line reason, leave it.

**Fix relevant advisories** by spawning a fix subagent (the orchestrator's Edit/Write are blocked by `block-direct-edits`). Give it the advisory text + file context and have it make the **minimal** change, then re-run `/wave-gate` so the fix is re-reviewed.

**Non-blocking:** if a relevant advisory can't be fixed cleanly (breaks tests, needs an upstream change), defer it with a reason rather than holding the wave. Every advisory must end as *fixed*, *deferred (reason)*, or *dismissed (reason)* — never silently ignored.

### Step 5: Advance

Call `complete-wave-gate` — it handles ALL verification and advancement:

```bash
bun ${LOOM_DIR}/engine/src/cli.ts helper complete-wave-gate
```

The helper performs **seven checks** before advancing (in evaluation order):
1. **Implementation proof** — every wave task must have status `implemented`/`completed` and `proof.state == "satisfied"`; the gate never manufactures completion from pending or failed proof
2. **Per-task test evidence** — all wave tasks must have a passing `test_result` (`{"verdict": "trusted-pass"}`, or an untrusted result with `passed: true`); tasks declaring `new_tests_required == false` are exempt
3. **New tests written** — all wave tasks must have `new_tests_written == true` OR `new_tests_required == false`
4. **Per-task review status** — every wave task's `review_status` must be `passed` or `blocked` (`pending`, absent, or `evidence_capture_failed` all fail the check)
5. **Spec alignment** — `spec_check.critical_count == 0`
6. **No critical findings** — code review `critical_findings` count must be 0 (findings the Step 3.5 panel refuted have already moved to `refuted_findings` and no longer count)
7. **Lifecycle machine artifacts** — every lifecycle machine file the plan binds to this wave's tasks must exist on disk (at the declared path or a suffix-matched task `file_list` path); no plan in state skips the check, but a plan that is named yet unreadable **fails the gate** (fail-closed)

If any check fails, the helper exits with error and the wave does NOT advance. Fix the issue and re-run `/wave-gate`.

On success: marks tasks "completed", updates GH issue checkboxes, advances to next wave.

---

## Re-run After Fixes

When issues fixed, run `/wave-gate` again. It will:
- Skip test verification if evidence already present
- Re-run spec-check (always runs, overwrites previous)
- Re-review ONLY tasks with `review_status == "blocked"`
- Advance when all clear

---

## Handling Failures

### Spec-Check Failures

| Symptom | Cause | Recovery |
|---------|-------|----------|
| No SPEC_CHECK_CRITICAL_COUNT | Output malformed | Re-spawn spec-check-invoker |
| spec_check.verdict missing | Hook parse failed | Check hook output, re-spawn |
| CRITICAL findings | Spec drift detected | Fix drift, re-run /wave-gate |

**Debugging:**
```bash
# Check spec-check status
jq '.spec_check' .claude/state/active_task_graph.json
```

### Review Failures

| Symptom | Cause | Recovery |
|---------|-------|----------|
| No output from reviewer | Agent crashed/timed out | Re-spawn that specific reviewer |
| Malformed output | Skill parsing issue | Re-spawn with explicit format reminder |
| review_status still "pending" | Hook didn't fire/parse | Check hook output, re-spawn reviewer |

**Debugging:**
```bash
# Check per-task review status
jq '.tasks[] | {id, review_status, test_result}' .claude/state/active_task_graph.json

# Check wave tasks (wave resolved inside jq — the guard blocks WAVE=$(jq … state))
jq -r '.current_wave as $w | .tasks[] | select(.wave == $w) | .id' .claude/state/active_task_graph.json
```

---

## Constraints

- MUST spawn spec-check AND review agents in parallel (single message)
- MUST use `spec-check-invoker` agent for spec alignment
- MUST spawn review sub-agents directly (`code-reviewer`, `silent-failure-hunter`, etc.) per task
- MUST run the refutation panel (Step 3.5) whenever the wave has critical findings, and MUST spawn all verifiers in a single message
- MUST report refuted findings in the GH comment — a refutation nobody can see is a deletion
- NEVER hand-build the finding brief or manifest; the engine authors both from state
- MUST post GH comment before advancing
- MUST classify and report advisory findings before advancing — this workflow obligation is not a `complete-wave-gate` condition; advisories remain non-blocking and may be fixed, deferred, or dismissed with a reason
- NEVER advance if spec-check has critical findings
- NEVER advance if code review has critical findings
- NEVER manually write to state file (guard hook blocks it)
- All status comes from SubagentStop hooks — cannot be set manually
- `complete-wave-gate` is the ONLY path to advance waves
