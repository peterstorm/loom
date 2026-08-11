# PR Remediation — Adjudicated Standalone Review (Round 34)

- **Branch:** `feat/architecture-panel-mode-plan` (base `main`)
- **Standalone run directory:** `.claude/reviews/review-and-fix-runs/run.9EsbvowhUb`
- **Scope:** 315 paths, frozen in `session.json` (315 files, +85086/-3420 vs `main`)
- **Reviewers:** `code-reviewer`, `silent-failure-hunter`, `pr-test-analyzer`,
  `type-design-analyzer`, `comment-analyzer`, `architecture-tech-lead`
- **Panel:** 3 lenses (`reproduction`, `intent`, `security`), refutation threshold 2
- **Adjudication:** 29 surviving criticals, **0 refuted**, 32 advisories

The 29 surviving ids collapse to **19 distinct defects**: ten ids are engine-preserved
duplicates, where a reviewer emitted the same defect once as a terse `CRITICAL:`
marker line (`file: null`) and once as a located `findings`-block claim. Fixing the
defect discharges every id that covers it.

Validation commands: `cd engine && bunx tsc --noEmit` and `cd engine && npm test`
(`test:unit` = vitest, `test:smoke` = the four `scripts/smoke-*.sh` harnesses).

---

## Surviving critical fixes

### P1 — Silent failures / fail-open behaviour (production code)

#### C1. `readCheckpoint`'s bare catch collapses a tampered checkpoint into "never ran"
- **Ids:** `silent-failure-hunter-1`, `silent-failure-hunter-6`
- **Agent:** silent-failure-hunter · **File:** `engine/src/orchestration/run-directory-handle.ts:315`
- **Claim:** `catch { return null }` swallows every read failure, not just `ENOENT`.
  `resumeProgram` returns the replayed state immediately on a `null` checkpoint
  (`fugue-program-runtime.ts:363`), so an `ELOOP` from a checkpoint path swapped to a
  symlink — precisely the attack `no-follow-fs` exists to refuse — or an `EACCES`/`EIO`
  on a valid checkpoint skips the checkpoint-vs-replay corruption check entirely.
  The sibling `readReceipt` in the same file (line 618) documents the opposite policy:
  "Collapsing the two would let a truncated receipt read as never ran."
- **Fix:** discriminate `ENOENT` exactly as `readReceipt` does. Return `null` only for
  `ENOENT`; rethrow anything else so the journal's caller fails closed.
- **Validation:** `bunx vitest run tests/orchestration` plus a new test proving a
  checkpoint replaced by a symlink surfaces an error rather than `null`.

#### C2. An interrupted foreground test run keeps its partial green report
- **Ids:** `silent-failure-hunter-2`, `silent-failure-hunter-7`
- **Agent:** silent-failure-hunter · **File:** `engine/src/machine/extract-evidence.ts:648`
- **Claim:** `report: classified.isBackgrounded ? null : report` nulls the report only for
  a backgrounded segment. `extractBashOutcome` already returns `exit: null` for
  `o.interrupted === true` (line 535), and `judgeTestRun` maps `exit === null` beside a
  green report to `trusted-pass` (`test-report.ts:139`). A timed-out or killed foreground
  suite therefore reaches the exact state the backgrounded guard was written to prevent:
  per-class XML from the classes that happened to finish reads `total > 0, failed = 0`.
- **Fix:** carry the interrupted flag out of `extractBashOutcome` and null the report for
  an interrupted run as well. The completeness precondition is the same one the
  backgrounded comment already states; it just was not applied to the second case that
  breaks it.
- **Validation:** `bunx vitest run tests/machine` plus a regression test mirroring
  `extract-evidence.test.ts`'s existing "drops even a parsed green report for a
  backgrounded test" for the interrupted case.

#### C3. `repair-task-graph` installs state without the executable-model binding gate
- **Ids:** `silent-failure-hunter-3`, `silent-failure-hunter-8`
- **Agent:** silent-failure-hunter · **File:** `engine/src/handlers/helpers/repair-task-graph.ts:28`
- **Claim:** `prepareTaskGraphRepair` runs `fixFull` → `validateFull` → `parseTaskGraph`
  and never calls `checkPlanModelBindings`; that check lives only in
  `validate-task-graph`'s CLI body (lines 741/763), not in the shared `validateFull`.
  The helper then installs through `manager.replace`, bypassing `StateManager.load()`
  by design. This falsifies `populate-task-graph.ts:148`'s own claim to be "the only
  whitelisted helper that populates tasks into active_task_graph.json, so bindings are
  enforced here fail-closed", and `repair-task-graph`'s own docstring promise to
  "reject any remaining invariant violation".
- **Fix:** call `checkPlanModelBindings` inside `prepareTaskGraphRepair` and fold its
  violations into the existing `errors` array, so a binding-violating graph is refused
  rather than installed.
- **Validation:** `bunx vitest run tests/handlers` plus a test proving a repairable graph
  carrying a drifted model binding is refused with the binding error.

#### C4. `declaredCount` takes the first marker, letting an echoed count erase findings
- **Ids:** `code-reviewer-3`, `code-reviewer-9`
- **Agent:** code-reviewer · **File:** `engine/src/core/review-output.ts:247`
- **Claim:** `declaredCount` uses a non-global `text.match`, returning the FIRST
  `<SEVERITY>_COUNT:` in the text, and `scrapeLegacyFindings` applies it to the whole
  transcript. The same module documents the opposite convention twice —
  `parseMachineSummary` "Uses the LAST match to skip skill-template echoes that precede
  real output" (line 256) and `lastMarker` (line 519) loops to keep the last. An agent
  that echoes the skill template's `CRITICAL_COUNT: 0` before its real
  `CRITICAL_COUNT: 1` resolves to zero criticals, and `reconcileFindings`'s shortfall
  backstop is gated on `count > 0` so it never fires.
- **Fix:** make `declaredCount` keep the last match, matching its two siblings.
- **Validation:** `bunx vitest run tests/core` plus a regression test with an echoed
  count preceding the real one.

#### C5. `mkdirSync(recursive)` follows symlinks inside an O_NOFOLLOW-anchored module
- **Ids:** `code-reviewer-4`, `code-reviewer-10`
- **Agent:** code-reviewer · **File:** `engine/src/orchestration/run-directory-handle.ts:168,398,473`
- **Claim:** these three sites hand a path string to the kernel while the module exists
  to open one component at a time under `O_NOFOLLOW`; `ensureRelativeDirectoryNoFollow`
  (`no-follow-fs.ts:75`) is the anchored primitive already used correctly by
  `panel-run.ts:305`. A symlinked intermediate component under the run directory is
  traversed and directories are created at the link's target before the subsequent
  anchored write correctly refuses — the side effect has already happened.
- **Fix:** route all three through `ensureRelativeDirectoryNoFollow`, anchored on a
  descriptor for the run directory, and close the descriptor in a `finally`.
- **Validation:** `bunx vitest run tests/orchestration` plus a test planting a symlinked
  intermediate directory and asserting nothing is created at its target.

### P2 — Correctness bugs in the pure core

#### C6. `canonicalStructuralEquals` memoizes "visited", not "equal"
- **Ids:** `code-reviewer-1`, `code-reviewer-7`
- **Agent:** code-reviewer · **File:** `engine/src/core/orchestration-contract.ts:54`
- **Claim:** `pairAlreadyCompared` records a `(left, right)` pair on first visit
  regardless of the comparison's outcome and never unwinds it. `matchOnce` (line 66)
  deliberately tolerates a FAILED speculative sub-comparison while trying candidates,
  so a pair registered by a rejected candidate match answers `true` the next time it is
  encountered anywhere in the structure. Two structurally different values then compare
  equal. The function gates checkpoint/state consistency at
  `standalone-review-machine.ts:204,236,274,1103,1197,1274`, so a false "equal" lets a
  mismatched checkpoint pass a check that should reject it.
- **Fix:** scope the memo to the active recursion path — record the pair before
  recursing and remove it when the comparison completes — so it terminates cycles
  (its documented purpose) without leaking a speculative result across siblings.
- **Validation:** `bunx vitest run tests/core/canonical-structural-equals.test.ts` plus a
  regression test using a Set whose members share object references across fields.

#### C7. `rosterAuthorityErrors` never checks slot order against lens/criteria order
- **Ids:** `code-reviewer-2`, `code-reviewer-8`
- **Agent:** code-reviewer · **File:** `engine/src/core/panel-program.ts:1002`
- **Claim:** the function validates run id, program, slot count and per-slot role, but
  every downstream lookup pairs `roster.orderedSlots[i]` with `candidateLenses[i]` /
  `judgeCriteria[i]` positionally (lines 1730-1743, 1792, 1996, 2033, 2059), so slot
  ORDER is load-bearing and unvalidated. `parseExactRoster` preserves input order
  verbatim, and the slots and lenses are independently-ordered fields of the same
  untrusted checkpoint input.
- **Panel note:** the `reproduction` lens refuted this — per-payload criterion/lens
  equality checks turn a reordering into a `request-binding-mismatch` rejection at submit
  time. `intent` upheld it (nothing declares order free) and `security` was `uncertain`,
  so it survives 1-1 under "ties favor keeping the finding". The fix is therefore
  written as making the ordering invariant explicit at the authority boundary rather
  than as repairing a live misattribution.
- **Fix:** carry the expected ordered lens/criterion list into `rosterAuthorityErrors`
  and reject a roster whose slot order does not match it, so the positional pairing is
  proven at parse time instead of relying on a downstream rejection.
- **Validation:** `bunx vitest run tests/core/panel-program.test.ts` plus a test feeding a
  reordered roster and asserting a parse-time rejection.

#### C8. Concurrent `appendEvent` calls can mint colliding sequence numbers
- **Ids:** `architecture-tech-lead-1`, `architecture-tech-lead-5`
- **Agent:** architecture-tech-lead · **Files:**
  `engine/src/orchestration/run-directory-handle.ts:299`,
  `engine/src/orchestration/fugue-program-runtime.ts:151`
- **Claim:** `sequence` is derived from an unlocked directory-listing snapshot
  (`events.length`) while only the dedup-keyed filename gets `O_EXCL`. Two appenders
  with different dedup keys can both compute the same sequence and both succeed.
  `readEvents` reconstructs order by sorting filenames, so colliding prefixes fall back
  to lexicographic dedup-key comparison — unrelated to happens-before — and
  `replayProgram`/`resumeProgram` fold in that order.
- **Panel note:** `reproduction` voted `uncertain` (both bodies are synchronous, so the
  collision needs two OS processes and nothing drives the journal from a second process
  today); `intent` upheld (no single-writer contract is declared anywhere and `sequence`
  is documented as the append order); `security` `uncertain`. Survives.
- **Fix:** stop trusting the listing count. Retry the exclusive create against the next
  free sequence on `EEXIST`, so the `O_EXCL` create is the sole arbiter of both identity
  and order in both implementations.
- **Validation:** `bunx vitest run tests/orchestration` plus a test appending events
  whose sequence slot is already occupied and asserting distinct, gap-free sequences.

### P3 — Type design: illegal states admitted

#### C9. `InterviewDigest.sensitiveBoundaries` does not encode its flagged/none invariant
- **Id:** `type-design-analyzer-1`
- **Agent:** type-design-analyzer · **File:** `engine/src/core/panel-contract.ts:70`
- **Claim:** the field stays a bare `string` while its two siblings on the same type are
  narrowed to literal unions by the same parser. `parseInterviewDigest` normalizes the
  value to begin with `flagged` or `none`, but the type never records it, and
  `selectPanelLenses` (line 221) reads it with `.startsWith("flagged")` — an
  unnormalized value silently drops the security-first lens. The same file brands
  `CandidateFilename` for exactly this hazard.
- **Fix:** introduce a `SensitiveBoundaries` branded/prefixed type produced only by
  `parseInterviewDigest`, and have `selectPanelLenses` read a parsed status rather than
  re-deriving it from a prefix test.
- **Validation:** `bunx vitest run tests/core/panel-contract.test.ts` and `bunx tsc --noEmit`.

#### C10. `parseStoredSpecCheck` returns the caller's own unfrozen object
- **Id:** `type-design-analyzer-2`
- **Agent:** type-design-analyzer · **File:** `engine/src/core/spec-check.ts:164,187`
- **Claim:** both success arms return `spec as unknown as …` — the same reference passed
  in, never reconstructed or frozen — while every sibling parser builds a fresh record
  (`parseSpecCheckOutput` at line 116, `findings.ts:parseStoredFinding`). A later
  mutation through the original reference invalidates the `critical_count ===
  critical_findings.length` invariant the function just proved.
- **Fix:** construct and freeze fresh records on both arms, exactly as
  `parseSpecCheckOutput` does.
- **Validation:** `bunx vitest run tests/core` plus a test mutating the input after a
  successful parse and asserting the parsed value is unchanged.

#### C11. `DerivedPart` admits contradictory `ok`/`reason` combinations
- **Id:** `type-design-analyzer-3`
- **Agent:** type-design-analyzer · **File:** `engine/src/orchestration/dags/wave-gate-operations.ts:58`
- **Claim:** `ok: boolean` and `reason: string | null` are independent fields, so
  `{ok: false, reason: null}` and `{ok: true, reason: "…"}` both type-check and both
  pass `derivedPartSchema`. The join already defends against the first with
  `part.reason ?? \`${part.part} could not be derived\`` — the code conceding the state
  is representable. The sibling DAG models the same concept as a discriminated union
  (`standalone-review-operations.ts:41`).
- **Fix:** split `DerivedPart` into `{kind: "derived", part, value}` and
  `{kind: "undeliverable", part, reason}` arms with a matching `z.union` schema, and
  drop the join's `??` fallback since the reason becomes structurally guaranteed.
- **Validation:** `bunx vitest run tests/orchestration` and `bunx tsc --noEmit`.

#### C12. `PanelOperationSpec.aggregate`'s return type is disconnected from `DomainResult`
- **Id:** `type-design-analyzer-4`
- **Agent:** type-design-analyzer · **File:** `engine/src/orchestration/dags/panel-operations.ts:88`
- **Claim:** typed `Readonly<{ok: boolean}> & Record<string, unknown>`, which
  `{ok: true}` alone satisfies, while `aggregateNode` unconditionally reads
  `aggregated["value"]` — producing `{kind: "aggregated", value: undefined}` as a
  panel's successful result. Both real implementations already return `DomainResult`.
- **Fix:** type `aggregate` as `DomainResult<unknown, unknown>` and drop the two
  `as Readonly<{ok: boolean}> & Record<string, unknown>` casts at the call sites, so the
  `value` key is statically guaranteed on the success arm.
- **Validation:** `bunx tsc --noEmit` and `bunx vitest run tests/orchestration`.

#### C13. Branch-envelope Zod schemas validate nothing behind a `z.ZodType` cast
- **Id:** `type-design-analyzer-5`
- **Agent:** type-design-analyzer · **File:** `engine/src/orchestration/dags/panel-operations.ts:71`
- **Claim:** `proofEnvelopeSchema`/`outcomeEnvelopeSchema` declare their wrapped members
  as `z.unknown().optional()` then force-cast the whole schema to
  `z.ZodType<ProofEnvelope>`/`<OutcomeEnvelope>`. At the one boundary these DAGs exist
  to parse, any value is accepted at runtime while the static type asserts a well-formed
  `RosterProof`/`PanelOutcome`; `aggregateNode` and `rejectNode` then read `.kind` and
  `.reason` off it. The sibling module validates each keyed member with the real schema
  (`wave-gate-operations.ts:104`).
- **Fix:** validate the members with `rosterProofSchema`/`panelOutcomeSchema` and remove
  the `as unknown as` casts so the schema and the static type agree.
- **Validation:** `bunx tsc --noEmit` and `bunx vitest run tests/orchestration`.

### P4 — Cross-harness parity

#### C14. Pi never wires the request-authority-bound capture path (FR-033 unmet)
- **Ids:** `code-reviewer-5`, `code-reviewer-11`
- **Agent:** code-reviewer · **File:** `pi/extension.ts` (subagent `tool_result` handler)
- **Claim:** `dispatch.ts:86` calls `captureOrchestrationResult` unconditionally before
  any legacy routing on the Claude side. Nothing under `pi/` imports `harness-capture`,
  `openRunDirectory`, or `captureTranscript`; `piFinalPayloadCandidates` exists in
  `pi/transcript-adapter.ts` and has only test callers. FR-033 requires both harnesses to
  capture each completed reviewer/verifier output into its engine-declared slot, and
  ADR-0004 claims they share the capture rules — true of the parsing rules, not of the
  wiring. Pi's standalone branch (line 1054) `continue`s before any capture could occur.
- **Fix:** extract the harness-agnostic half of `capture-orchestration-result.ts`
  (correlator lookup, issued-request read, already-captured slots, bind-and-write) into a
  shared module both adapters call, add a Pi identity resolver keyed on the Pi native
  correlator, and invoke capture in the Pi result loop BEFORE the standalone
  short-circuit and before `StateManager` resolution — the same two orderings
  `dispatch.ts` documents as load-bearing.
- **Validation:** `bunx vitest run tests/pi-imports.test.ts tests/orchestration` plus a
  test proving Pi and Claude produce byte-identical capture receipts for the same agent
  output (the parity property `capturesAgree` already exists for).

### P5 — Test coverage for reachable guards

#### C15. Foreign-receipt mismatch chain is unreachable from any test
- **Id:** `pr-test-analyzer-1`
- **File:** `engine/src/core/remediation-machine.ts:2344`
- **Claim:** `remediation-machine.property.test.ts:1259` mutates receipt fields that are
  all digest inputs, so `parseRecoveryReceipt`'s digest check (line 2197) fires first;
  the stale-receipt test hits the already-consumed guard at 2341. The cross-field chain
  at 2344-2351 is never entered, and the test asserts only `ok === false`.
- **Fix:** add a test that mints a self-consistent receipt for a DIFFERENT run/attempt
  (fresh receipt id, valid digest, unconsumed) and asserts rejection with the specific
  mismatch error kind.
- **Validation:** `bunx vitest run tests/core/remediation-machine.property.test.ts`.

#### C16. `checkSpecAlignment`'s `EVIDENCE_CAPTURE_FAILED` branch has no test
- **Id:** `pr-test-analyzer-2`
- **File:** `engine/src/core/wave-gate-machine.ts:520`
- **Claim:** `complete-wave-gate.test.ts:351-419` parameterizes only `UNKNOWN` and
  `BLOCKED`; its `captured()` helper cannot produce `EVIDENCE_CAPTURE_FAILED`.
- **Fix:** add a case constructing an evidence-failed spec check and asserting the wave
  is blocked with that reason.
- **Validation:** `bunx vitest run tests/handlers/complete-wave-gate.test.ts`.

#### C17. `store-reviewer-findings`'s task-disappeared TOCTOU guard has no test
- **Id:** `pr-test-analyzer-3`
- **File:** `engine/src/handlers/subagent-stop/store-reviewer-findings.ts:143`
- **Claim:** `taskFound` is set inside the locked `mgr.update` mapper and checked after;
  the guard's diagnostic string appears in no test.
- **Fix:** add a test whose task graph loses the target task between the pre-update
  lookup and the locked update, asserting the guard's diagnostic and that no evidence is
  applied.
- **Validation:** `bunx vitest run tests/handlers/subagent-stop/store-reviewer-findings.test.ts`.

#### C18. `promoteArtifactSet`'s partial-promotion recovery has no test
- **Id:** `pr-test-analyzer-4`
- **File:** `engine/src/orchestration/run-directory-handle.ts:554`
- **Claim:** `publication-faults.test.ts` covers staging failure and the pre-rename
  occupied-slot refusal, but never makes a rename fail AFTER an earlier member already
  promoted, so `discardStaged(stagedPaths.slice(index))` is never entered.
- **Fix:** add a test forcing the second member's publish to fail and asserting the
  remaining staged files are discarded and the call reports failure.
- **Validation:** `bunx vitest run tests/orchestration/publication-faults.test.ts`.

### P6 — Documentation accuracy

#### C19. README calls `/loom --status` unimplemented
- **Ids:** `comment-analyzer-1`, `comment-analyzer-2`
- **File:** `README.md:62`
- **Claim:** the line groups `--status` with `--complete`/`--abort` under
  "(planned — not yet implemented; see commands/loom.md)", but the file it points to
  documents `--status` as running `helper orchestration status` (lines 66, 625-654), and
  `handlers/helpers/orchestration.ts` implements it (`OPERATIONS` at 44, `statusOperation`
  at 111, dispatch at 280).
- **Fix:** move `--status` out of the planned group and mark only `--complete`/`--abort`
  as planned.
- **Validation:** re-read against `commands/loom.md` and the handler.

---

## Refuted Findings (not fixing)

**None.** The refutation panel refuted zero of the 29 surviving criticals.

Two findings drew a split vote and survive under the standing "ties favor keeping the
finding" rule; both are recorded here because a split is the closest this run came to a
refutation, and each fix above is scoped to what actually survived:

| Id(s) | reproduction | intent | security | Outcome |
|---|---|---|---|---|
| `code-reviewer-2`, `code-reviewer-8` | **refuted** — per-payload criterion/lens equality checks (`panel-program.ts:1639,1648,1668`) turn a reordered roster into a `request-binding-mismatch` rejection, never a silent swap | upheld — positional lookups make order load-bearing and nothing declares it free | uncertain — validation completeness, not a trust boundary | survives 1–1 (C7) |
| `architecture-tech-lead-1`, `architecture-tech-lead-5` | uncertain — both `appendEvent` bodies are synchronous, so the collision needs two OS processes and nothing drives the journal from a second one today | **upheld** — no single-writer contract is declared and `sequence` is documented as append order | uncertain — internal concurrency, not an attacker | survives (C8) |

Six further ids drew `uncertain` from `reproduction` on latency grounds (`code-reviewer-5`,
`code-reviewer-11`, `type-design-analyzer-1`, `type-design-analyzer-2`) while `intent`
upheld them; they are fixed as latent-hazard closures, not as live incidents.

---

## Advisories (32) — deferred

Not accepted for this round. Highest-signal ones for a follow-up: the unwired Fugue
DAG/effect-runner surface, the absent boundary rules for `engine/src/handlers/`,
`state-manager.ts` and `pi/`, the untested `runGit` spawn/signal branches, the narrow
`fc.constantFrom` property generators, and the unreachable reducer `reject` arms in
`standalone-review-machine.ts`.

---

## Priority order

C1–C5 (silent failures / fail-open) → C6–C8 (core correctness) → C9–C13 (type design)
→ C14 (cross-harness parity) → C15–C18 (test coverage) → C19 (docs).
