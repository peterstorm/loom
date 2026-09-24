# PR Remediation Plan — Round 8 (review-fix-20260921T133316Z-1a8e8743)

**Branch:** `fix/abandoned-gate-terminal-outcome` (candidate HEAD at review start: `1a8e8743`,
the round-7 remediation commit, clean tree)

**Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20260921T133316Z-1a8e8743`
(result digest `ed35e6e89d6a79b6faacef2d9705b4a30725db282a562af13327a02174efa404`)

Reviewer admission evidence retained in the run: seven reviewers were batched in three
admission waves (≤3 concurrent per operator argument). Two bounded retries occurred
inside this run — comment-analyzer attempt 1 was aborted (operator-cancelled after a
stall; `exitCode=1`, `stopReason=aborted`) and re-admitted as attempt 2; and
silent-failure-hunter attempt 1 was rejected on payload extraction and re-admitted as
attempt 2. Both attempt-2 captures are the canonical payloads in `result.json`.

**Scope:** the review's frozen scope is the engine-derived changed-path union of 118 paths
at `1a8e8743` (recorded in the run's `result.json`). Every file this remediation touches
is inside that frozen scope **except** the two paths named in the remediation start input
`supportPaths`: this plan file and `engine/tests/core/proof-obligations.test.ts` (the
pr-test-analyzer-2 pins: the kernel equality swap's regression directions had no
fixtures, and the test file sits outside the changed-path union because round 7 changed
only the module).

**Engine counts (inspection renderer):** emitted/admitted 6 critical, 15 advisory;
after refutation 6 surviving critical, 0 refuted critical, 15 advisory.

**Refutation panel:** three lenses (reproduction, intent, security) × 6 criticals =
18 verdicts, all upheld. Four reviewers (code-reviewer, silent-failure-hunter,
pr-test-analyzer, architecture-tech-lead) each reproduced the defect empirically against
both `1a8e8743` and `69cd1e83`; comment-analyzer and code-simplifier corroborated by
static delta. Panel transcripts retained in the run.

**Advisory policy publication (P5, matching runtime):**
`policy-20260921T153429Z-1a8e8743`, disposition digest
`aed9e97ab67e6ba1714d88079c52c9b4e0ebce89701fb640f275548db964090f`, revision
`{"kind":"initial"}`, 15/15 entries published against source digest
`ed35e6e89d6a79b6faacef2d9705b4a30725db282a562af13327a02174efa404`.

## Surviving critical dispositions (mandatory)

### `code-reviewer-1`, `silent-failure-hunter-1`, `pr-test-analyzer-1`, `comment-analyzer-1`, `architecture-tech-lead-1`, `code-simplifier-1` — disposition: `repaired` → Declared Repair Group `group.repair.plan-artifact-ambiguity-guard`

All six surviving criticals name ONE root cause and are repaired by one group.

- **Root cause (DECLARED):** round 7's code-simplifier-5 extraction of the
  `advance-phase` architecture-arm probe maze (`resolvePlanArtifact`/`derivedPlanCandidate`
  in `engine/src/handlers/subagent-stop/advance-phase.ts:153-162`) silently dropped the
  `files.length === 1` ambiguity refusal that `69cd1e83` line ~297 enforced: where the
  pre-extraction code refused with `no readable plan artifact is available inside
  .claude/plans` when zero or multiple readable plan artifacts existed, the extracted
  `derivedPlanCandidate` destructures `const [only] = readdirSync(...).filter(...)` and
  returns the FIRST readdir-order entry — so on the architecture→plan-alignment
  transition a multi-artifact `.claude/plans` directory advances the phase against an
  arbitrary (readdir-order-dependent) plan artifact instead of refusing. This is a
  behavior regression introduced BY the previous round's remediation, reproduced
  empirically by four reviewers (including the multi-match case that exists in this
  repository itself: `2026-09-21-pr-remediation-round6.md` and
  `2026-09-21-pr-remediation-round7.md`).
- **Invariant (DECLARED):** the architecture→plan-alignment transition requires EXACTLY
  ONE readable plan artifact inside `.claude/plans`; zero or multiple matches refuse with
  the pre-extraction diagnostic `no readable plan artifact is available inside
  ${PLAN_ARTIFACT_DIR}` (zero-match prose preserved; the same refusal now also covers the
  ambiguity case, exactly as `69cd1e83` did). A revert to first-of-N adoption turns the
  new pin red.
- **Siblings (DECLARED, paths-declared):** the ambiguity semantics live in exactly one
  module — `engine/src/handlers/subagent-stop/advance-phase.ts` (`derivedPlanCandidate`,
  consumed by `resolvePlanArtifact` on the architecture transition). The probe-order,
  literals, and error modes of the pre-extraction maze are otherwise preserved (round 7
  pinned them). Grep for `.claude/plans` readers finds no second adoption site.
  No sibling is unresolved or out of scope.
- **Selected check:** `project:verify` (enrolled root verify command; required report
  `.loom/completion-reports/verify.junit.xml`).
- **Historical RED (DECLARED):** with the guard reverted to the regressed first-of-N
  adoption (the `=== 1` comparison loosened to `>= 1`), the new advance-phase test fails —
  the transition advances against an arbitrary entry instead of refusing — so the verify
  run is red against the vulnerable behavior. Reference: the ambiguous-match refusal pin
  in `engine/tests/handlers/subagent-stop/advance-phase.test.ts` (validated by mutation:
  only the new pin goes red; every pre-existing pin stays green).
- All named repair-group files (`advance-phase.ts`, `advance-phase.test.ts`) are inside
  the frozen review scope.

## Refuted criticals audit

`result.json.refuted_critical_findings` is **empty** — no refuted critical Finding exists
in this run, so there is nothing retained as refuted and nothing excluded from repair.
(The refutation panel upheld all 18 lens verdicts; evidence retained in the run's panel
transcripts.)

## Advisory dispositions (published policy `policy-20260921T153429Z-1a8e8743`, revision initial)

**Accepted (10):** code-reviewer-2, pr-test-analyzer-2, pr-test-analyzer-3,
pr-test-analyzer-4, type-design-analyzer-1, comment-analyzer-2, comment-analyzer-3,
architecture-tech-lead-3, code-simplifier-2, code-simplifier-4.

- code-reviewer-2 + pr-test-analyzer-2 (same subject): the round-7 sfh-1 enriched
  integrity refusal in `context-packet-projection.ts` shipped assertion-free; two pins
  now drive it — a byte-flipped fixed context yields the enriched refusal naming
  `fixedContext[0].digest`, and a 10k-character hostile key yields the refusal containing
  the `…[truncated]` marker instead of the full key (the latter also pins
  architecture-tech-lead-3's bounded-interpolation repair below).
- pr-test-analyzer-3: the round-7 sfh-2 kernel-equality swap's two unpinned semantic
  deltas get explicit fixtures in `engine/tests/core/proof-obligations.test.ts` —
  key-order-permuted but structurally-equal aggregate evidence is ACCEPTED (widening arm:
  textual equality would refuse), and the kernel reads an own undefined-valued key as
  distinct from an absent key (narrowing arm: pinned at the `canonicalStructuralEquals`
  seam, where the discriminating behavior lives; through `parseTaskProof` the
  element-parse exact-record arm refuses the same shape first, and both layers fail
  closed). Both directions RED-validated by mutation.
- pr-test-analyzer-4: the leader-reaped arm's remaining classifications get pins in
  `engine/tests/orchestration/completion-check-runner.integration.test.ts`, reusing the
  `exit-before-close` fixture and the established `process.kill` probe-mock machinery —
  cancelled-after-dissolution classifies as `cancelled` without signalling; the
  already-gone fast path classifies a late timeout as an observed run (the timeout
  recorded,
  not a refusal); the unobservable-identity probe error and the unavailable-parent-close
  race both refuse `termination-unconfirmed` without signalling. Each pin RED-validated
  by mutation (cancelled early-return dropped; fast-path `timedOut` bit flipped; both
  refusal messages mutated). The parent-close pin's timing margins are hardened
  (8000ms pipe-holder vs. 400ms hard-kill race) so a fully loaded suite cannot flake it.
- type-design-analyzer-1 (minimal accepted form): `parseWaveSpecCheckDocumentAuthority`
  accepted any non-null string path, including blank ones; it now refuses empty and
  whitespace-only paths with a new `path-blank` rejection fact, decorated by the State
  File load guard as `wave_review_epoch.specCheckDocuments.<member>.path must not be
  blank when present`. Engine mints are unaffected (authority is minted from a real read
  at a real path; `null` is the explicit no-document state), so the refusal only ever
  fires on hand-edit or corruption. Pinned in
  `engine/tests/core/wave-spec-check-documents-grammar.test.ts` (parser-level facts +
  load-guard prose), RED-validated by mutation. The canonical-grammar path mint is the
  recorded follow-up (see deferred tda-2).
- comment-analyzer-2: `settledProcessGroupRefusal`'s JSDoc claimed the parent-closed
  prose is "byte-pinned" when the suite pins it with `expect.stringContaining`
  (substring); the doc now states the real pin strength and names the three integration
  fragments.
- comment-analyzer-3: the durable round-7 plan record's "no third copy" grep sentence is
  false — `.claude/plans/2026-09-21-pr-remediation-round7.md` now records the third
  textual occurrence (`engine/src/state-manager.ts:2703`) and the semantic distinction
  (successor registration after a tombstone, outside the retirement acceptance arm) so
  future sibling re-validation is not surprised.
- architecture-tech-lead-3: the projection integrity refusal interpolated the parser's
  attacker-influenced field/message unbounded; the orchestration-contract facade gains
  `boundDiagnosticMessage` (kernel bounded-prose budget, exported with rationale) and the
  projection now bounds the interpolated refusal prose — pinned by the hostile-key test
  above.
- code-simplifier-2: the dead `leaderMessage` field drops from `EpermEscalationDecision`
  (type + two mints + the two policy-test pins) so the ADT carries exactly what the
  caller consumes; no behavior change (`completion-check-policy.test.ts` updated in the
  same change).
- code-simplifier-4: the comment orphaned by round 7's re-export removal is deleted and
  its load-bearing clause folds into `parseContextPacket`'s JSDoc
  (`context-packets.ts`); pure comment-shape change, all 32 packet tests green.

**Deferred (5, reasons DECLARED in the published policy record):**
silent-failure-hunter-2 (surfacing an unresolvable merge-base through `deriveChangedPaths`
changes the frozen registration authority surface — narrow-precondition scope-completeness
hardening for a dedicated pass), type-design-analyzer-2 (task wire-shape restructure —
three optional lineage fields into one optional record ripples through
implementation-retry, the writers, the load validator and persistence tests; both runtime
enforcement layers already fail closed), type-design-analyzer-3 (checkpoint-identity
vocabulary unification — renaming `lifecycleCheckpointDigest` across the wave-gate
machine arms, bindings and pinned tests for zero runtime benefit), architecture-tech-lead-2
(extracting the closed-phase settle and parent-close helpers inside the signal-safety
ladder — a nontrivial refactor of fresh containment code in the same round that proved an
allegedly behavior-preserving extraction regressed), code-simplifier-3 (same subject as
architecture-tech-lead-2; deferred with it for the same declared reason).

**Dismissed (0).**

## Accepted-advisory implementation notes

All accepted advisory fixes touch files inside the frozen review scope except the pta-3
fixture file named in `supportPaths`; none adds a new source file. No pinned refusal prose
moves (the tda-1 repair ADDS a rejection fact and its decorated prose, pinned by new
tests; the atl-3 repair bounds an existing refusal's interpolation, pinned by the
hostile-key test).

## Validation commands (development runs — not P3 evidence)

- `cd engine && npx tsc --noEmit` (typecheck — clean)
- Targeted: `cd engine && env -u PI_CODING_AGENT npx vitest run
  tests/handlers/subagent-stop/advance-phase.test.ts
  tests/core/context-packet-projection.test.ts tests/core/proof-obligations.test.ts
  tests/core/proof-obligations-property.test.ts
  tests/orchestration/completion-check-runner.integration.test.ts
  tests/orchestration/completion-check-policy.test.ts
  tests/core/wave-spec-check-documents-grammar.test.ts
  tests/core/context-packets*.test.ts` — all green.
- Full-suite triage evidence (development run): two full `npx vitest run` passes on the
  IDENTICAL remediated tree produced 38 failures/13 files and 58 failures/16 files —
  nondeterministic load variance with no source change between runs. Every failure is
  either a per-test 5s timeout blown under CPU starvation (file durations 111–377s under
  parallel load vs. seconds in isolation) or a vitest-worker RPC timeout, plus two
  non-timeout failures: the pre-existing load-induced report-observation flake in
  `completion-check-runner.integration.test.ts` (raw-outcome seam; green in isolation),
  and this plan's own parent-close pin timing fragility — FIXED by hardening the fixture
  margins (see pr-test-analyzer-4). Spot-checked isolated reruns: the three largest
  failing files (`verification-command`, `machine-purity`, `reviewer-protocol-native`)
  pass 576/576 in isolation; the integration file passes 38/38 in isolation. After the
  new timing failure was fixed, the remaining observed full-suite failures were
  attributed to pre-existing environment/load nondeterminism; every test covering the
  touched modules passes repeatedly in isolation.

The registered remediation runner must freshly observe `project:verify` and its exact
structured report; development runs above never substitute for it.

## Expected remediation start input

```json
{
  "sourceRunsRoot": ".claude/reviews/review-and-fix-runs",
  "sourceRun": "review-fix-20260921T133316Z-1a8e8743",
  "supportPaths": [
    ".claude/plans/2026-09-21-pr-remediation-round8.md",
    "engine/tests/core/proof-obligations.test.ts"
  ],
  "defectFamily": { "kind": "declared-defect-family-accounting", "…": "one group as declared above" }
}
```
