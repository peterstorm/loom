# Refutation Panel Robustness — incident analysis & fix spec

Date: 2026-08-16 (updated after the wave-gate recurrence, same day)
Status: **A, D, E, G shipped. C and F still open. B deferred.**

| Fix | State | Notes |
|-----|-------|-------|
| A — verdict parser tolerates prose + one bare object | **shipped** | `review-panel.ts`; verified against both incidents' transcript shape |
| G — verifier retry prompt carries its diagnostic | **shipped** | NEW, see RC6 |
| D — verifier contract hardening | **shipped** | Pi bindings re-rendered |
| E — reviewer claim identity | **shipped** | incl. `architecture-tech-lead.md`, which had no such rule at all |
| C — durable blocked state for the refutation phase | open | |
| F — `retire` for a terminally blocked wave-gate run | open | |
| B — non-voting "unavailable" lens slots | deferred | |

A related defect in the same class was found and fixed on the **reviewer** side
while investigating a third terminal block (run `run.BFPks1Bkj1` in this repo):
the standalone reviewer retry prompt lost its rejection diagnostic on any resume
after the one that recorded it, and its fallback text blamed the frozen-scope
validator unconditionally. See RC6.

## Incidents

### Incident 1 — standalone review run r44 (original)

Trigger: cortex `fix/llm-background-load-guardrails` standalone review run **r44**
(`.claude/reviews/review-and-fix-runs/r44` in the cortex repo, kind `simplify`,
15-file scope, base `8f88663` → head `1ea0438`).
r44 is terminally stuck in `awaiting-refutation`; no `result.json` can be
published from it. A fresh run (r45) was started, its reviewer batch published,
held unspawned pending the fixes below.

1. Reviewer batch: 3/3 captured and semantically accepted (code-reviewer,
   architecture-tech-lead, code-simplifier).
2. Aggregation: 1 critical (`code-simplifier-1`: `edgeRowsToEdges` omits
   `last_failed_at`), 8 advisory claims (4 are a dedup-bloat pair, see RC4).
3. Refutation Panel: 3 lenses (reproduction, intent, blast-radius), threshold 2
   (strict majority).
4. Attempt 1: reproduction and blast-radius emitted pure JSON → accepted.
   The **intent** verifier emitted *prose + a bare top-level JSON object, no
   fence* — violating the "pure JSON only" contract in its own agent definition
   (`agents/review-verifier-agent.md`) — → parse rejected → engine issued the
   frozen attempt-2 (its only recovery path).
5. Attempt 2: same verifier, same shape (prose + bare JSON) → parse rejected.
6. Every subsequent `resume` re-derives the same hard error:
   `refutation verdict is not valid JSON and contains no single json fence`
   (exit 1, no JSON action). The run can never be advanced or declared blocked.

### Incident 2 — wave-gate run `20260816T044401Z-restart-wave4` (recurrence)

Trigger: chatbot repo, feature `multi-service-booking`, **Wave 4 wave gate**
(`.claude/reviews/wave-gate-runs/20260816T044401Z-restart-wave4`).
The run is terminally blocked with the identical diagnostic
`refutation verdict is not valid JSON and contains no single json fence`.

Facts (verified in the run directory):

- Wave 4 = tasks T11 + T17; wave reviewers completed (T11 review passed, T17
  review blocked on 1 active critical `T17:code-reviewer-3`: 3 stale
  mock-based integration tests failing under the canonical unit pass —
  independently confirmed by running the tests).
- Refutation panel: 3 lenses (reproduction, intent, test-coverage).
- **All four captured verdict transcripts are prose + bare JSON with zero json
  fences** (both attempts of the reproduction slot, plus attempt-1 of the other
  two slots). The engine loop processes slots in publication order; the
  first slot (reproduction) exhausted both attempts unparseable → panel state
  machine `terminal-blocked` → the other two verdicts were never even
  evaluated. The panel never tallied.
- Unlike r44, the wave-gate facade does emit a typed `blocked` action
  (`resumeWaveGateFacade` → `waveBlocked(diagnostic.message)`). The runbook
  instruction for `blocked` is "stop and report. Do not bypass or
  reconstruct." — and there is **no engine operation that can retire a
  terminally blocked wave-gate run** (see RC5). The wave is stuck: fixing the
  3 tests and re-reviewing is impossible without first destroying the whole
  task graph (`cleanup-state`).

## Root causes

### RC1 (trigger) — verifier output-contract flake
`review-verifier-agent` says "Output ONLY valid JSON to stdout" but
high-thinking models intermittently emit analysis prose plus the JSON object.
Incident 1: 1 of 3 verifiers flaked. Incident 2: **3 of 3 flaked** (4/4
transcripts unparseable). The flake is a probability, not a possibility;
with enough panels it is a certainty.

### RC2 (structural) — complete-roster proof vs. majority threshold
`proveRefutationRoster` (`engine/src/core/panel-program.ts`) requires an
**accepted verdict for every lens slot** (`parseCompleteRoster` —
`incomplete-roster` otherwise), while survival needs only a strict majority
(`defaultRefutationThreshold`, 2 of 3). The threshold buys **zero resilience**:
with N lenses you must parse N verdicts to vote on floor(N/2)+1. One slot that
exhausts both attempts unparseable makes the tally unreachable and kills the
whole run — burning all reviewer calls plus N verifier calls plus the retry.

### RC3 (recovery gap, standalone) — refutation block is not durable
- `submitRefutationVerdict` (`engine/src/core/panel-program.ts`) *does*
  produce a well-formed terminal action on attempt-2 rejection:
  `action.kind === "refutation-blocked"` with a diagnostic.
- The facade (`resumeStandaloneFacade`,
  `engine/src/handlers/helpers/programs/standalone.ts`, awaiting-refutation
  branch) converts it to a bare `failed(message)` — exit 1, **no
  machine-state transition, no checkpoint write, no `blocked` action**.
- The standalone machine already has the machinery the reviewer phase uses:
  `result-rejected` (attempt 2) → `terminal-blocked` state, and resume maps
  `terminal-blocked`/`recoverable-blocked` → `{ kind: "blocked" }`. The
  refutation phase has **no declared blocked event**: `"awaiting-refutation"`
  accepts only `refutation-completed` and `recoverable-effect-failed`.
- Consequence: the run is a zombie (Incident 1). The skill contract says the
  parent executes only `spawn-batch` / `await-user` / `blocked` / `done` —
  this failure is none of them, so the operator has no supported next step
  from inside the workflow.

### RC4 (secondary) — advisory claim dedup bloat
`architecture-tech-lead` reworded its claims between the Machine Summary
`ADVISORY:` marker lines and the fenced `findings` block. The engine
reconciles by value, so both variants survive: 4 advisories where there are 2
(the marker-derived ones lose file/line, arriving as `file: null, line: null`).
**Correction (verified while shipping E):** the contract did NOT say this for
this agent. Six of the seven Machine Summary agents carried "Write the same
claim text in both places"; `agents/architecture-tech-lead.md` carried no such
rule at all — so the agent that produced the bloat was the one never told not
to. E adds it there and strengthens the other six to "BYTE-IDENTICAL". Not
fatal, but inflates parent triage.

### RC5 (recovery gap, wave-gate) — a terminally blocked wave-gate run has no retirement path

Incident 2 proved the wave-gate side of the recovery gap. When a wave-gate run
reaches `terminal-blocked` at any post-reviewer stage (refutation panel
dead-end; spec-check attempt-2 exhaustion — the spec-check slot is not in
`slot_authority`, so it is outside `exhaustedWaveReviewerAttempts`; any future
post-reviewer dead-end), the run is unrecoverable by any sanctioned operation:

- `resume` — deterministic; re-derives the same `blocked` action forever.
- `restart` — refuses: it is scoped to **exhausted wave-reviewer slots** and
  derives them from `task.review_run.slot_authority`. At the point of the
  block, wave-reviewer packets are already closed (tasks carry
  `review_status` + findings, no `review_run`), so the exhausted-slot set is
  empty → engine error `the active Wave Gate has no outstanding reviewer
  slots to restart` (observed live). It would also not cover spec-check or
  refutation exhaustion even mid-collection.
- `recover-orphan` — requires the active Run Directory to be *missing*;
  deleting it is explicitly forbidden, so this is unreachable for a
  terminal-blocked run.
- `start` (fresh run directory) — `registerActiveWaveGate` throws
  `Active Wave Gate run <id> already owns wave <n>` while the blocked run's
  registration has `terminalOutcome: null`. The only retirement transitions
  are completion, restart, and orphan recovery — none applicable.
- `cleanup-state` — deletes the entire task graph: all findings
  (383 resolved / 59 refuted in the affected run's graph), wave-gate history,
  baselines, and the review audit trail. A sledgehammer for a one-panel
  dead-end; the runbook's emergency path ("then fix manually / rebuild from
  the GH issue") accepts that loss by design, which is exactly what makes RC5
  a defect rather than a feature.

Net effect: the "fix the critical → re-review the wave" loop — the normal
remediation cycle the gate exists to run — is impossible once the panel
dead-ends, short of destroying the whole orchestration state.

### RC6 (amplifier, NEW) — a retry that re-asks the identical question

RC1 says the output-contract flake is a probability. What made it *fatal* is
that neither retry path told the agent anything had gone wrong:

- **Verifiers**: `executableRefutationRequests` built one task string per
  request with no attempt awareness, so attempt 2's prompt was byte-identical to
  attempt 1's — no rejection notice, no diagnostic. This is the mechanism behind
  "attempt 2: same verifier, same shape" in BOTH incidents. The engine re-asked
  the identical question and got the identical answer.
- **Reviewers**: `standaloneRetryTask` did carry a diagnostic, but
  `resumeStandaloneFacade` sourced it from the pass-local `rejected` array. Any
  resume that merely re-issued an already-recorded retry had an empty `rejected`
  set, so the prompt fell back to text that blamed the frozen-scope validator
  unconditionally — telling a reviewer refused for a missing Machine Summary to
  fix its scope. Observed live in `run.BFPks1Bkj1`: slots 3 and 6 were both
  refused for `CRITICAL_COUNT marker not found`, both got the scope text, and
  slot 6 failed attempt 2 identically and terminal-blocked the run.

Fix A makes the verifier flake non-fatal; RC6's fix makes the retry itself
worth spending. They are independent: A stops the refusal, G makes any residual
refusal self-correcting. Fixed in G.

## Fix requirements

### A — Verdict parser tolerates prose + exactly one bare top-level JSON object (SHIPPED)

Site: `refutationVerdictJson` (`engine/src/core/review-panel.ts`).
Current accepted shapes: (1) entire payload is JSON; (2) exactly one
```` ```json ```` fence with no competing verdict-like object outside it.

Add a third branch: no fence, whole-payload parse fails, but the payload
contains **exactly one** balanced top-level JSON object carrying a
`criterion` or `verdicts` key, with **no** competing such object anywhere else
→ accept that object (raw transcript preserved unchanged). 0 or ≥2 candidates
still fail closed, with a diagnostic naming the ambiguity.

The balanced-brace scan already exists as the boolean
`containsCompetingVerdictObject`; refactor it into
`findTopLevelVerdictObjects(text): readonly span[]` and use it for both the
competing-check (existing branch) and the new extraction. Unicode-escaped key
spellings must keep being detected as competitors (post-`JSON.parse`
`Object.hasOwn` already does this — keep it).

A alone would have saved both incidents: every transcript in both contains
exactly one such object.

Tests: `engine/tests/core/review-panel.test.ts` — prose+bare object accepted;
prose+two objects rejected (ambiguous); prose+object inside a code fence +
competing object rejected; fenced-branch behavior unchanged; escaped-key
competitor still detected.

### C — Durable blocked state for the refutation phase (standalone)

Sites: `engine/src/core/standalone-review-machine.ts` +
`engine/src/handlers/helpers/programs/standalone.ts`.

1. Declare a new machine event `refutation-blocked` (carries slotId,
   requestId, attempt=2, message) in `"awaiting-refutation"`'s transition
   table, with a strict event parser mirroring `result-rejected`.
2. Reduce it to the existing `terminal-blocked` state. Extend the `failed`
   record with a `phase: "reviewer" | "refutation"` discriminator; the
   checkpoint replay parser must keep accepting the legacy 4-key record
   (pre-existing checkpoints) and read it as `phase: "reviewer"`.
3. In `resumeStandaloneFacade`, when the refutation verdict submission yields
   the `refutation-blocked` action, reduce the machine, **write the
   checkpoint**, and return `{ kind: "blocked", ... }` instead of
   `failed(...)`.

Tests: machine transition test (declared + monotonic from terminal-blocked)
and a resume facade test simulating an exhausted refutation slot asserting a
`blocked` action and a durable checkpoint.

### D — Verifier agent contract hardening (SHIPPED)

`agents/review-verifier-agent.md`: make the output rule maximally salient —
"Your FINAL message must be exactly one JSON object and nothing else. No
preamble, no postscript, no code fences." (The current rule exists but is
buried under a heading.) Reduces RC1 probability; A makes a residual flake
non-fatal. Re-render Pi bindings via `scripts/sync-pi-agents.sh` (the
agent-digest binding changes with the definition).

### E — Reviewer claim identity (prompt-only) (SHIPPED)

`agents/architecture-tech-lead.md` (and siblings sharing the Machine Summary
block): restate that each `CRITICAL:`/`ADVISORY:` marker line must be
**byte-identical** to the matching `claim` in the fenced `findings` block —
reworded claims arrive as duplicate findings with null locations.

### F — `retire` operation for a terminally blocked wave-gate run (NEW, from Incident 2)

Closes RC5. A new `helper orchestration retire` operation, shaped like
`restart`/`recover-orphan` (atomic retire + replacement, one state
transaction, returns the replacement's `spawn-batch`):

    helper orchestration retire --runs-root <root> --run <blocked-run-directory>
                                --new-run <fresh-replacement-run-directory>
                                [--reason <operator context>]

Preconditions (all fail-closed):

1. `<run>` is the protected `active_wave_gate` run (exact runId/wave/
   authorityDigest match) and is registered as a `wave-gate` program.
2. The engine **re-derives** the run's next action via
   `resumeWaveGateFacade`; it must be a `blocked` action. A run that can
   still make progress (`spawn-batch`/`await-user`) is not retirable — this
   is what keeps retire from orphaning a live run.
3. The replacement directory is a fresh, pristine direct child.
4. No review or implementation subagent is active for this Task Graph
   (same liveness check as `recover-orphan`).

Effect (one locked StateManager transaction + run-directory audit):

- Append a `wave_gate_history` entry, kind `retired-wave-gate`
  (runId, wave, authorityDigest, revision, diagnostic, reason, retiredAt).
  History parsing (`state-manager.ts` / `types.ts`) must accept the new kind
  alongside `completed-wave-gate`, and `registerActiveWaveGate`'s
  "wave already completed" check must apply **only to completed entries** —
  a retired wave is re-reviewable, a completed wave is not. Re-registering a
  retired runId stays forbidden.
- Clear `active_wave_gate` **and** `wave_review_epoch` (the epoch is
  run-scoped; a stale epoch makes a fresh run dead-end in the
  spec-check-attempt-1 derivation).
- Install the replacement registration (fresh runId, same wave/taskIds) and
  its program registration; record a `retire` audit field on the replacement
  program (`previousRunId`, diagnostic, reason) mirroring `restart`'s audit.
- Write a `wave-gate-retired` checkpoint to the OLD run directory (audit
  evidence; the old run stays on disk, never deleted).

Then resume the replacement and return its action. The replacement re-derives
`initialBatchMissingOrPartial` (no epoch, no `review_run` on closed tasks) →
issues a fresh full reviewer batch (spec-check + per-task roster) at the
tasks' current `review_generation` with fresh packets that embed
`priorFindings: task.findings` — so the new generation re-adjudicates every
prior finding (a now-fixed critical gets marked resolved by the reviewers;
genuinely still-present criticals roll the refutation panel again).

Crash-window/idempotency: re-invocation after a committed retire must
reconcile (old run in history as retired + replacement registered/active →
return the replacement's resume action), mirroring `restart`'s
`completedRestart`/`alreadyRestarted` paths.

Tests: retire of a blocked run (history entry + cleared epoch/active + fresh
batch returned); refusal of a non-blocked run; refusal of a missing/mismatched
active run; refusal with an active subagent; idempotent re-invocation;
`registerActiveWaveGate` accepts a new wave-4 run after wave 4 was retired but
still refuses after wave 4 was completed.

Runbook: document `retire` in `commands/wave-gate.md` (when: `blocked`
diagnostic from a post-reviewer stage where `restart` does not apply —
refutation terminal-blocked, spec-check exhaustion; semantics; old directory
preserved as audit evidence; never `cleanup-state` for this).

### G — Retry prompts must name what was refused (SHIPPED)

Closes RC6. Two sites, one defect class:

1. **Refutation verifiers** (`executableRefutationRequests`,
   `handlers/helpers/programs/standalone.ts`) built the attempt-2 task text with
   no attempt awareness at all — a verifier's retry prompt was **byte-identical**
   to attempt 1. It now routes attempt-2 requests through `refutationRetryTask`,
   which quotes the engine's own parse diagnostic and restates the
   one-JSON-object contract. Both the standalone and wave-gate call sites pass
   the diagnostic, sourced from the step's `refutation-verdict-rejected` event.
   No schema change: the panel re-derives its full event prefix from the durable
   transcripts on every resume, so the message is regenerated deterministically.
2. **Standalone reviewers** (`standaloneRetryTask`,
   `handlers/helpers/programs/helpers.ts`) — see RC6.

Tests: `orchestration.test.ts` asserts the attempt-2 refutation task quotes the
diagnostic, restates the contract, and differs from attempt 1;
`standalone-review.test.ts` covers diagnostic durability across a checkpoint
round trip; the façade smoke test asserts a resume-issued reviewer retry task is
byte-equal to the same-pass one.

### B — (DEFERRED, design decision) Roster semantics for exhausted lenses

The true fix for "one flake kills the run": an exhausted lens slot settles as
a non-voting **"unavailable"** status instead of blocking roster proof; the
tally runs over available lenses with threshold = strict majority of
**available**, requiring ≥2 available lenses for a valid decision (otherwise a
structured block), and the decision record names the unavailable lenses with
their rejection diagnostics.

Scope: touches `proveRefutationRoster`, `tallyRefutationPanel`,
`defaultRefutationThreshold`, the panel checkpoint schema, **and the shared
wave-gate path** (same `panel-program` module). Own change, own review. With
A (flake becomes non-fatal), C (standalone dead-end becomes a typed blocked),
and F (wave-gate dead-end becomes retirable), B is no longer urgent — but it
removes the last way a single malformed transcript can waste a full wave of
review spend.

## Validation plan

1. Loom: full `bun test` (engine) green, `tsc --noEmit` no new errors.
2. New unit tests per A/C/F as listed.
3. Engine change bumps the runtime revision (content-addressed over
   engine/src + pi + lockfiles) → **Pi `/reload` required** before the loom
   CLI can drive any run again.
4. Recover the chatbot Wave 4 run: `retire`
   `20260816T044401Z-restart-wave4` into a fresh run → spawn the replacement
   batch → drive to completion. The 3 stale test mocks
   (`tests/integration/data-export-flow.test.ts` phase-3 verify row,
   `tests/integration/erasure-flow.test.ts` verify row + leads
   `conversation_id`) get fixed by a fix subagent **before** the replacement
   run's reviewers read the tree, so the new generation re-adjudicates
   `T17:code-reviewer-3` as resolved.
5. Cortex r45 (already started, batch published, unspawned) can then be
   spawned/resumed under the new revision: with A, a prose-wrapped verdict
   parses instead of dead-ending; with C, any residual dead-end is a durable,
   reportable `blocked`.

## Known consequences of the incidents

- r44's reviewer transcripts and parseable refutation verdicts remain durable
  in its run directory; the critical (`edgeRowsToEdges` omits `last_failed_at`)
  was upheld 2/2 on parseable lenses, and the third transcript (unparseable,
  intent lens) also concluded upheld. r44 still cannot publish `result.json`;
  r45 is the authoritative run for remediation planning.
- Wave 4's run directory (`20260816T044401Z-restart-wave4`) remains durable
  audit evidence after retire. Its 4 unparseable refutation transcripts all
  substantively concluded "upheld" on `T17:code-reviewer-3`, and the finding
  was independently verified by running the 3 failing tests — the critical is
  real and must be fixed (stale mocks) regardless of adjudication.
- Wasted LLM spend from flakes: 1 extra verifier attempt (r44) + 4 verdict
  transcripts that could never count (wave 4), plus the pending full
  re-review of wave 4.
