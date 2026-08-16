# PR Remediation Plan — 2026-08-16

**Branch:** `feat/architecture-panel-mode-plan`
**Base commit:** `d1adcf7` (clean tree)
**Review Run:** `run.XYYaqUV4Ef`
**Run Directory:** `.claude/reviews/review-and-fix-runs/run.XYYaqUV4Ef`
**Scope:** frozen whole-repo standalone scope, 380 files (verified byte-identical to the working tree)
**Reviewers:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer,
comment-analyzer, architecture-tech-lead
**Refutation Panel:** lenses `reproduction`, `intent`, `security`; threshold 2

## Tally

| | count |
|---|---|
| Critical findings raised | 16 (6 distinct; each claim appears once located and once locationless) |
| Surviving criticals | 12 (6 distinct) — all mandatory |
| Refuted criticals | 4 (2 distinct) — audited, never fixed |
| Advisories | 48 (24 distinct) |
| Advisories accepted | 22 distinct |
| Advisories dismissed | 2 distinct |

## Surviving Critical Findings (mandatory)

### SC-A — `engine/src/handlers/subagent-stop/advance-phase.ts:81` (ids `code-reviewer-1`, `code-reviewer-3`)
Panel: reproduction=upheld, intent=upheld, security=upheld (3/3).

`resolveTransition`'s `clarify` branch reads `state.spec_file` with no containment
check at all before `countMarkers()` reads it and it becomes the recorded phase
artifact.

**Fix:** gate the branch on `resolvesWithin(spec, ".claude/specs")` — the helper
already defined in the same file for the write path — before `existsSync`/`countMarkers`.

### SC-B — `engine/src/handlers/subagent-stop/advance-phase.ts:63,95` (ids `code-reviewer-2`, `code-reviewer-4`)
Panel: 3/3 upheld.

The `specify` and `architecture` branches validate `spec_file`/`plan_file` with
`String.includes(".claude/specs/")` / `.includes(".claude/plans/")`, which
`.claude/specs/../../../tmp/evil/spec.md` satisfies. The same file's comment
(lines 187-193) names this exact substring form as the wrong test.

**Fix:** replace both substring checks with `resolvesWithin`. Close the writer
side too: `pi/extension.ts` persists `spec_file`/`plan_file` on the same
bypassable substring test (`filePath.includes(specDir) && endsWith("/spec.md")`),
which is the reachability the panel traced — route it through the shared pure
classifier (see SC-F).

### SC-C — `engine/src/core/wave-gate-model.ts:106` (ids `comment-analyzer-1`, `comment-analyzer-19`)
Panel: reproduction=upheld, intent=upheld, security=refuted (2/3).

`waveHasBlockCause` is documented as "deliberately the ONLY copy: every writer
that sets or clears the flag computes it from here". Three writers do not:
`wave-gate-machine.ts:689` hardcodes `blocked: false`, and
`store-spec-check-findings.ts:82` / `pi/extension.ts:2244` hardcode `blocked: true`.
The two rules also disagree: `checkCriticalFindings` filters blank findings,
`waveHasBlockCause` counts raw array length.

**Fix:** make the code match the documented invariant. (1) `waveHasBlockCause`
counts only non-blank critical findings, so it agrees with `checkCriticalFindings`
and `validate-task-execution`. (2) `applyGateDecision` derives the gate through
`reconcileWaveBlock` instead of hardcoding `false`. (3) Both `blocked: true`
setters route through `reconcileWaveBlock`.

### SC-D — `engine/src/core/orchestration-contract/publication.ts:19` (ids `comment-analyzer-3`, `comment-analyzer-21`)
Panel: 3/3 upheld.

`publication.ts` documents its proof caches as module-private because an exported
`.add()` "minted an accepted result out of a hand-built object". The sibling
`roster.ts:520-521` exports the structurally identical `exactRosterCache` /
`completeRosterCache`, and `completion.ts` reads and mutates them across the
module boundary — the capability the comment says was withdrawn.

**Fix:** make the code match. `exactRosterCache` becomes module-private with a
narrow read-only accessor (`isRegisteredExactRoster`) for `completion.ts`;
`completeRosterCache` moves into `completion.ts`, its sole owner, as a private
cache. No comment is edited — the claim becomes true.

### SC-E — `engine/src/orchestration/harness-capture-runtime.ts:91` (ids `comment-analyzer-4`, `comment-analyzer-22`)
Panel: reproduction=upheld, intent=upheld, security=uncertain (2/3).

`captureHarnessResult` is documented "only an accepted capture writes anything",
but the `reject` closure persists a rejection marker and appends an audit event
on every refusal path. The rejection write is deliberate and correct; the
sentence is the defect.

**Fix:** correct the doc comment to state that every terminal outcome is durably
recorded and only the payload differs.

### SC-F — `pi/extension.ts:1290` (ids `architecture-tech-lead-1`, `architecture-tech-lead-6`)
Panel: reproduction=upheld, intent=upheld, security=uncertain (2/3).

The `tool_result` handler spans ~981 lines in one closure and writes phase
artifact classification inline (`filePath.includes(specDir) && endsWith("/spec.md")`
next to `mgr.update(...)`), so no decision rule in it can be tested without a live
`StateManager`, git repo, and filesystem. The file header claims it "delegates to
engine/src/core/ for all business logic".

**Fix:** extract the decision rules into a new pure module
`engine/src/core/phase-artifact-paths.ts` (`resolvesWithin`, `classifyPhaseArtifact`,
`phaseArtifactUpdates`) — unit-testable with plain strings — and split the handler
into named per-concern appliers taking explicit parameters, leaving `tool_result`
as a dispatcher. The classifier uses resolved containment, which also closes the
SC-B writer path.

## Refuted Critical Findings (audited — NOT fixed)

### RC-1 — `engine/src/core/panel-kernel.ts:239` (ids `comment-analyzer-2`, `comment-analyzer-20`)
Claim: "`exactOrderedSetErrors` enforces same length as one of its four rules."
- **reproduction (refuted):** both live call sites enforce length first —
  `panel-kernel.ts:179` errors when `rawItems.length !== spec.expectedIds.length`,
  `review-panel.ts:682` skips the call on a length mismatch — and in both the
  `actual` array is a filter of that same-length input, so it can never exceed
  `expected`. The unenforced rule changes no outcome on any reachable path.
- **security (refuted):** no over-long manifest is ever accepted; the missing
  in-helper rule yields no validation bypass.
- **intent (upheld):** the helper's documented four-rule contract is not what its
  body enforces.

Verdict: 2 refutations ≥ threshold 2 → refuted. Not fixed.

### RC-2 — `engine/src/orchestration/git-remediation.ts:579` (ids `comment-analyzer-5`, `comment-analyzer-23`)
Claim: "`isRegularFile` is true only for a real file, never a symlink."
- **reproduction (refuted):** repo-wide search for `isRegularFile` returns only its
  definition at `git-remediation.ts:580` — no caller in `engine/src`, `pi`,
  `scripts`, or any test — so the misclassification cannot be observed on any live
  code path.
- **security (refuted):** no symlink can pass a check nothing performs.
- **intent (upheld):** `statSync` does follow symlinks, contradicting the docstring.

Verdict: 2 refutations ≥ threshold 2 → refuted. Not fixed.

## Advisory Dispositions

### Accepted (22)

| id | file | fix |
|---|---|---|
| `pr-test-analyzer-1/3` | `pi/extension.ts:1389,1517` | tests driving both graphless no-op branches |
| `pr-test-analyzer-2/4` | `pi/extension.ts:722` | test driving the runtime-compatibility guard's `block: true` branch |
| `type-design-analyzer-1/6` | `orchestration-contract/effects.ts:397` | `never`-exhaustiveness default in `receiptPayloadMismatch` |
| `type-design-analyzer-2/7` | `orchestration-contract/roster.ts:534` | make `immutableMap`'s view compare and serialize by content |
| `type-design-analyzer-3/8` | `core/panel-program.ts:198` | validate `judgeCriteria` against `ARCHITECTURE_CRITERIA_VOCAB` on the legacy path |
| `type-design-analyzer-4/9` | `core/review-packet.ts:90` | brand `PacketId` / artifact + postimage digests |
| `comment-analyzer-6/24` | `core/panel-contract.ts:495` | delete the stale re-zip half of the `CriterionScore` comment |
| `comment-analyzer-7/25` | `core/review-panel.ts:758` | move the JSDoc to `parseRefutationVerdict` |
| `comment-analyzer-8/26` | `core/harness-capture.ts:168` | name the four real refusal reasons; drop dead `run-mismatch` |
| `comment-analyzer-9/27` | `core/panel-program.ts:1019` | delete the orphaned `expectedLength` JSDoc |
| `comment-analyzer-10/28` | `core/review-output.ts:284` | describe the actual level-2-to-4 heading rule |
| `comment-analyzer-11/29` | `utils/git.ts:77` | scope the `repositoryRoot()` claim to its real callers |
| `comment-analyzer-12/30` | `linter/programmatic/no-cross-boundary-imports.ts:116` | drop the stale `identity.ts` allow entry |
| `comment-analyzer-13/31` | `handlers/helpers/complete-wave-gate.ts:67` | remove the dead re-exports and their pending-work comment |
| `comment-analyzer-14/32` | `orchestration/no-follow-fs.ts:112` | move the stale-lock JSDoc to `recoverStaleDirectoryLock` |
| `comment-analyzer-15/33` | `orchestration/run-directory-handle.ts:260` | add the ENOENT branch the comment documents |
| `comment-analyzer-16/34` | `orchestration/dags/standalone-review-operations.ts:7` | trim "ambiguous" from the header |
| `comment-analyzer-17/35` | `state-manager.ts:490` | delete the truncated comment fragment |
| `comment-analyzer-18/36` | `state-manager.ts:873` | move the `parseTaskGraph` JSDoc onto `parseTaskGraph` |
| `architecture-tech-lead-2/7` | `pi/write-grant.ts:291` | split I/O canonicalization from a pure `pathIsUnderScope` predicate |
| `architecture-tech-lead-4/9` | `core/findings.ts:967` | replace the adjacent same-typed positional params with a labeled pair |
| `architecture-tech-lead-5/10` | `core/panel-program.ts:2180,2222` | preserve the caught invariant message in both reducers |

### Dismissed (2)

- **`type-design-analyzer-5/10`** — `publication.ts:85`, `BatchPublishedReceipt`'s
  parallel arrays lack a proof-token brand. **Dismissed:** the reviewer's own prose
  retracts it — "several plausible-sounding claims from the initial survey did not
  hold up under verification and were dropped (e.g. `BatchPublishedReceipt`'s
  parallel arrays are fully length/order/uniqueness/digest-checked by its sole
  parser)". The marker line survived the retraction; the claim did not.

- **`architecture-tech-lead-3/8`** — replace the 20+ module-level `WeakSet`/`WeakMap`
  provenance witnesses with symbol-keyed brands attached to the values.
  **Dismissed on the merits:** a symbol-keyed brand is copyable by any holder of the
  object and the symbol, so the proposed mechanism is strictly weaker than
  `WeakSet` membership — it would trade away the anti-forging property that is the
  whole point of the trust root (the same property `publication.ts` defends and
  SC-D restores). The one concrete cost the finding cites — the untested
  `EMIT_INTENT` success edge — has already been paid: the fixture exists and the
  edge is covered. The reviewer itself framed this as "a trade-off review rather
  than a simple bug".

## Consequential Follow-On Changes

Four changes were not findings but were forced by fixes above, and are recorded
because each altered an existing test or contract:

1. **`engine/tests/handlers/review-findings-parity.test.ts`** reads the Pi review
   shell as `extension.ts` + `subagent-result.ts` concatenated. SC-F moved the
   transcript → task sequence into the new module; the parity property is about
   the harness, not about which file holds which half.
2. **`engine/tests/core/orchestration-contract.property.test.ts`** asserts
   `bySlot` immutability by BEHAVIOUR (`set`/`delete`/`clear` throw) instead of by
   the absence of a `set` key, because the advisory-4 fix makes the view a real
   `Map` subclass and those names are now inherited.
3. **Two `judgeCriteria` test fixtures** (`quality-programs.test.ts`,
   `orchestration.test.ts`) used criteria outside `ARCHITECTURE_CRITERIA_VOCAB`
   (`"testability"`, `"fit"`). Production derives criteria through
   `deriveJudgeCriteria`, which only ever yields vocabulary members, so the
   advisory-5 validation is correct and the fixtures were wrong.
4. **`engine/tests/pi-imports.test.ts`** now DISCOVERS `pi/*.ts` instead of
   listing two files, and follows barrel re-exports when checking type imports.
   A hardcoded roster is the bug class that test exists to catch: SC-F moved most
   engine imports into `subagent-result.ts`, which the fixed list did not read.
   Broadening it surfaced a real checker gap — `machine/index.ts` re-exports
   `ClassifiedTestCommand` rather than declaring it — now resolved one hop.

## Validation

```bash
cd engine && bunx tsc --noEmit
cd engine && npx vitest run --testTimeout=15000
cd engine && env -u PI_CODING_AGENT npm run test:smoke
```

### Evidence

- `bunx tsc --noEmit` — clean (pi/ is pulled into the program via the tests).
- `vitest run` — **168 files, 4399 tests, 0 failures**.
- Smoke: panel-mode 22/0, review-panel 19/0, standalone-review PASS,
  orchestration-facades PASS, pi-resources PASS.
- Boundary/purity linter rules: `tests/linter/programmatic` 135/135.

## Remediation Support Paths

Paths outside the frozen reviewed scope, because they did not exist when the
scope was frozen:

- `.claude/plans/2026-08-16-pr-remediation.md` — this plan
- `engine/src/core/phase-artifact-paths.ts` — the pure rule extracted for SC-A/B/F
- `engine/tests/core/phase-artifact-paths.test.ts` — its tests
- `pi/subagent-result.ts` — the per-concern appliers extracted for SC-F
- `engine/tests/pi/subagent-result.test.ts` — their tests
