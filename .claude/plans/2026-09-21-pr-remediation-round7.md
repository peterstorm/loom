# PR Remediation Plan — Round 7 (review-fix-20260921T081120Z-69cd1e83)

**Branch:** `fix/abandoned-gate-terminal-outcome` (candidate HEAD at review start: `69cd1e83`, clean tree)

**Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20260921T081120Z-69cd1e83`
(result digest `2c259009133cf9e0ce08b348e4c85bb7a5571ed3151919dfc44e9381330580ab`)

Two earlier same-day standalone-review runs were terminally blocked by reviewer-output
admission failures and are durable evidence, superseded in order:

- `review-fix-20260921T074630Z-69cd1e83` → superseded by `review-fix-20260921T075620Z-69cd1e83`
  (comment-analyzer exhausted its bounded retry: attempt 1 finding outside frozen scope,
  attempt 2 schema-conformance failure — empty `preconditions` tuple).
- `review-fix-20260921T075620Z-69cd1e83` → superseded by
  `review-fix-20260921T081120Z-69cd1e83` (silent-failure-hunter exhausted its bounded
  retry: attempt 1 ambiguous extraction, attempt 2 malformed JSON — missing closing brace).

**Scope:** the review's frozen scope is the engine-derived changed-path union of 114 paths
at `69cd1e83` (recorded in the run's `result.json`). Every file this remediation touches
is inside that frozen scope **except** the four paths named in the remediation start
input `supportPaths`: this plan file, `engine/tests/handlers/helpers/upgrade-spec-trace.test.ts`,
`engine/tests/fixtures/completion-process.mjs`, and `pi/transcript-adapter.ts` (the
code-simplifier-3 retarget: the Pi transcript adapter imported `boundedThrownCause`
through the successor-registration re-export and now imports the kernel directly).

**Engine counts (inspection renderer):** emitted/admitted 2 critical, 22 advisory;
after refutation 2 surviving critical, 0 refuted critical, 22 advisory.

**Advisory policy publication (P5, matching runtime):**
`policy-20260921T090400Z-69cd1e83`, disposition digest
`13eb9d5be1a65443be00996193bae870f17b4bf76f0dcaf4404cf81724284a56`, revision
`{"kind":"initial"}`, 22/22 entries published against source digest
`2c259009133cf9e0ce08b348e4c85bb7a5571ed3151919dfc44e9381330580ab`.

## Surviving critical dispositions (mandatory)

### `pr-test-analyzer-1` — disposition: `repaired` → Declared Repair Group `group.repair.tombstone-retirement-pins`

- **Root cause (DECLARED):** the terminal-abandoned tombstone acceptance arm of spec-trace
  Wave Gate retirement shipped with zero discriminating coverage: both retirement-proof
  copies gate on `active.terminalOutcome !== null && active.terminalOutcome.kind !==
  "terminal-abandoned"` (`engine/src/handlers/helpers/upgrade-spec-trace.ts:124-126` writer
  side; the same narrowing in `engine/src/core/spec-trace-migration.ts` reader side), but
  every retirement-flow fixture sets `terminalOutcome: null`, and no test drives
  `--retire-abandoned-run` against a `terminal-abandoned`, `done`, or `terminal-blocked`
  tombstone — so reverting the acceptance condition or flipping its polarity leaves the
  full suite green.
- **Invariant (DECLARED):** a graph whose `active_wave_gate.terminalOutcome` is the
  `terminal-abandoned` tombstone retires through `helper upgrade-spec-trace
  --retire-abandoned-run` (writer state accepted by the reader), while `done` and
  `terminal-blocked` tombstones still refuse with "requires nonterminal active run"; a
  polarity revert of either copy turns the suite red.
- **Siblings (DECLARED, paths-declared):** the narrowing exists in exactly two copies —
  `engine/src/handlers/helpers/upgrade-spec-trace.ts` (writer-side proof) and
  `engine/src/core/spec-trace-migration.ts` (reader-side preparation). The new pins drive
  the full helper, which executes both copies; both sibling paths are `repaired` by the
  same test additions. (Grep also surfaces a THIRD textual occurrence of the same
  narrowing — `engine/src/state-manager.ts:2703` — but that copy governs successor
  registration after a tombstone ("must be explicitly migrated"), a different decision
  from the retirement acceptance arm this group declares, so it is outside the group;
  recorded here so a future re-validation of the declared grep is not surprised by it.)
  No sibling is unresolved or out of scope.
- **Selected check:** `project:verify` (enrolled root verify command; required report
  `.loom/completion-reports/verify.junit.xml`).
- **Historical RED (DECLARED):** with the acceptance condition reverted to its pre-D1
  form (refuse any non-null `terminalOutcome`), the new tombstone-acceptance test fails
  ("requires nonterminal active run" refusal instead of retirement), so the verify run is
  red against the vulnerable behavior. Reference: the new tests in
  `engine/tests/handlers/helpers/upgrade-spec-trace.test.ts`.
- **Support path:** `engine/tests/handlers/helpers/upgrade-spec-trace.test.ts` is outside
  the frozen review scope and is named in the remediation start input.

### `type-design-analyzer-1` — disposition: `repaired` → Declared Repair Group `group.repair.leader-reaped-containment`

- **Root cause (DECLARED):** `terminateProcessGroup`'s post-SIGTERM decisions infer group
  ownership from probe values without the knowable reaping-phase bit (the spawned child's
  `exit` event, which Node reaps before `close`): in the leader-reaped phase a
  positive-PID probe success names a recycled pid, yet the EPERM correlation arm reads
  leader-present as "provably ours" and escalates SIGKILL, and the catch-all
  group-present arm escalates with no leader correlation at all — both contradicting the
  module's own recycled-leader rule enforced one function away
  (`observeClosedProcessGroup`). The parent-close path (which observes only
  `error`/`close`, never `exit`) already implements the correct post-reap polarity and is
  unchanged by this repair.
- **Invariant (DECLARED):** once the spawned check's `exit` has been observed, the
  numeric group id is no longer identity-bound and the runner makes no further
  negative-PGID signal — it classifies and waits exactly like the closed-parent path
  (`observeClosedProcessGroup`/`waitForClosedProcessGroup`) and reports
  `termination-unconfirmed`/`process-tree-survived` fail-closed; SIGKILL escalation
  remains authorized only while the leader is un-reaped. The decision is a pure,
  phase-explicit function with an exhaustive discriminated-union match, unit-pinned, and
  an integration test drives the real exit-before-close interleaving proving zero signals
  after `exit`.
- **Siblings (DECLARED, paths-declared):** the negative-PGID signalling decisions live in
  one module (`engine/src/orchestration/completion-check-runner.ts`) and one signalling
  primitive (`signalProcessGroup`): the EPERM correlation arm and the catch-all
  group-present arm inside `terminateProcessGroup` are both gated by the new phase
  decision; `observeClosedProcessGroup`/`waitForClosedProcessGroup` (post-close
  classifier) already implement the reaped-phase rule and are pinned by the existing
  policy suite — repaired in place, unchanged in contract. No other engine or Pi module
  issues negative-PGID signals (grep: `process.kill(-` occurs only in this module).
  No sibling is unresolved or out of scope.
- **Selected check:** `project:verify` (same enrolled command/report).
- **Historical RED (DECLARED):** with the reaped-phase gate reverted (escalate regardless
  of phase), the new integration test fails — signals are sent to the group after the
  child's `exit` — so the verify run is red against the vulnerable behavior. Reference:
  the new integration test in
  `engine/tests/orchestration/completion-check-runner.integration.test.ts` and the new
  decision-table pins in `engine/tests/orchestration/completion-check-policy.test.ts`.
- Both test files are inside the frozen review scope.

## Refuted criticals audit

`result.json.refuted_critical_findings` is **empty** — no refuted critical Finding exists
in this run, so there is nothing retained as refuted and nothing excluded from repair.
(The refutation panel DID assess both criticals: pr-test-analyzer-1 upheld 3/3
(reproduction, intent, security lenses); type-design-analyzer-1 upheld 2/3 with the
reproduction lens refuting the concrete cross-process SIGKILL delivery — the strict
majority upheld the phase-provenance gap, so the Finding survives as a critical and is
repaired above. Refutation evidence is retained in the run's panel transcripts.)

## Advisory dispositions (published policy `policy-20260921T090400Z-69cd1e83`, revision initial)

**Accepted (17):** code-reviewer-1, silent-failure-hunter-1, silent-failure-hunter-2,
pr-test-analyzer-2, comment-analyzer-1, comment-analyzer-2, comment-analyzer-3,
comment-analyzer-4, comment-analyzer-5, code-simplifier-1, code-simplifier-2,
code-simplifier-3, code-simplifier-4, code-simplifier-5, code-simplifier-6,
code-simplifier-7, code-simplifier-8.

- code-reviewer-1 + comment-analyzer-1/2/3/4: same-file containment-policy doc/invariant
  corrections implemented together with the `type-design-analyzer-1` critical repair
  (scoped invariant, corrected escalation enumeration, provenance-grounded wording,
  caller-matching wait doc).
- silent-failure-hunter-1: `projectContextPacket` integrity refusal carries the parser's
  field-level diagnostic instead of one generic sentence.
- silent-failure-hunter-2: `sameValue` in `core/proof-obligations.ts` uses the kernel
  `canonicalStructuralEquals` instead of JSON.stringify equality.
- pr-test-analyzer-2: attest-side `invalid-lineage` and `attestation-context-invalid`
  arms plus their rendered prose pinned in the existing attest-implementation aggregate
  sweep (in-scope test file). Two corrupt-lineage variants drive the aggregate's
  `invalid-lineage` arm (receipt-parse refusal; protocol/history disagreement on the
  canonical escalation lineage). The aggregate's `attestation-context-invalid` arm is
  **defensively unreachable** with the current rewrite — `attestedTask` overwrites every
  input the context derivation reads (flag, proof, policy) and the Task id is already
  proven by the earlier lineage disposition — so its refusal prose is pinned through
  `renderImplementationLifecycleError` and the derivation's own refusals stay pinned
  dispatch-side; removing the dead arm is an interface decision recorded for a future
  distill pass, not taken under this advisory.
- code-simplifier-1: one parameterized decode→encodeByteSection→exactness helper replaces
  the duplicated tails in `standalone-successor-registration.ts` (pinned refusal prose
  stays byte-identical).
- code-simplifier-2 + code-simplifier-3: `boundedPacketCause` alias and the
  successor-registration re-export of `boundedThrownCause` collapsed; consumers import
  the kernel directly (one capture, one name) — including the sibling adapters
  (`standalone-evidence.ts`, `helpers.ts`) and the out-of-scope Pi transcript adapter.
- code-simplifier-4: the nested ternary building the termination-unconfirmed refusal in
  `completion-check-runner.ts` flattens to an exhaustive switch (pinned prose bytes
  preserved).
- code-simplifier-5: the `advance-phase` architecture-arm probe maze extracts to a named
  `resolvePlanArtifact` helper (probe order, literals, and error modes preserved).
- code-simplifier-6: the provably-true `parseArtifactByteLength` guard in
  `buildContextPacket`'s section verification reduces to the direct
  length+digest equality (identical refusal prose).
- code-simplifier-7: the dead `BoundedThrownCause` type export drops its export keyword.
- code-simplifier-8: the six-fold `process.kill` spy scaffold in the containment-policy
  suite collapses to one `expectNoSignal` helper (assertion strength unchanged); the
  critical repair's new pins reuse it.

**Deferred (5, reasons DECLARED in the published policy record):**
architecture-tech-lead-1 (TASK_GRAPH_PATH binding-time unification — cross-cutting
11-site re-timing of state identity, latent drift only), architecture-tech-lead-2
(helpers.ts single-consumer machinery split — family-wide import-surface restructuring),
architecture-tech-lead-3 (wave-gate-machine core voluming — 2,967-line 4-region split),
architecture-tech-lead-4 (Pi spawn ledger extraction — Pi-shell changes require /reload),
code-simplifier-9 (single-parse diff projection — interface-bound utils/git.ts surface
change, deepen territory).

**Dismissed (0).**

## Accepted-advisory implementation notes

All accepted advisory fixes touch files inside the frozen review scope; none adds a new
file. Pinned refusal prose that any repair moves stays byte-identical unless the pinning
test is updated in the same change (none of the accepted advisories require prose
changes; the sfh-1 diagnostic enrichment extends a refusal message that is not
byte-pinned — verified against `engine/tests/core/context-packet-projection.test.ts`).

## Validation commands (development runs — not P3 evidence)

- `cd engine && npx tsc --noEmit` (typecheck)
- `cd engine && npx vitest run tests/orchestration/completion-check-policy.test.ts
  tests/orchestration/completion-check-runner.integration.test.ts
  tests/handlers/helpers/upgrade-spec-trace.test.ts tests/core/context-packet-projection.test.ts
  tests/core/proof-obligations*.test.ts tests/handlers/helpers/attest-implementation.test.ts
  tests/core/bounded-thrown-cause.test.ts tests/handlers/subagent-stop/advance-phase.test.ts
  tests/core/context-packet-byte-grammar.test.ts` (targeted)
- Full suite before staging: root verify command (same enrolled `project:verify`), which
  must pass with the enrolled JUnit report emitted.
- Full-suite triage evidence (development run): one full `npx vitest run` showed 51
  failures in 17 files; a stashed-change baseline at HEAD `69cd1e83` failed 37 tests
  across 14 of the same 17 files under identical conditions, and isolated reruns on the
  remediated tree pass every file except `reviewer-protocol-history.test.ts`, whose
  gzip-metadata determinism arm also fails at HEAD in isolation. All full-suite failures
  are pre-existing environment/load nondeterminism; every test covering the touched
  modules passes repeatedly in isolation.

The registered remediation runner must freshly observe `project:verify` and its exact
structured report; development runs above never substitute for it.

## Expected remediation start input

```json
{
  "sourceRunsRoot": ".claude/reviews/review-and-fix-runs",
  "sourceRun": "review-fix-20260921T081120Z-69cd1e83",
  "supportPaths": [
    ".claude/plans/2026-09-21-pr-remediation-round7.md",
    "engine/tests/handlers/helpers/upgrade-spec-trace.test.ts",
    "engine/tests/fixtures/completion-process.mjs",
    "pi/transcript-adapter.ts"
  ],
  "defectFamily": { "kind": "declared-defect-family-accounting", "…": "two groups as declared above" }
}
```
