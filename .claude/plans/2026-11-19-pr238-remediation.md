# PR #238 Remediation — canonical spawn echo binding (review-and-fix)

**Branch:** `fix/canonical-spawn-echo-binding` (worktree `/Users/hansen142/dev/claude-plugins/loom-echo-binding`, PR peterstorm/loom#238)
**Review Run Directory:** `/Users/hansen142/dev/claude-plugins/loom-echo-binding/.claude/reviews/review-and-fix-runs/run.pr238-echo-review` (result digest `a829e10480d3d39cf80aa954f46b1d2731f383f32caf2dfcd3fd32688b705d20`)
**Policy publication:** run.pr238-echo-disposition → `artifacts/disposition.json` (digest `94f995804603fa3b64198ece1003f88dda8bf942182f512732397ec2080f3faa`)
**Review scope (frozen, 6 files):** engine/src/core/spawn-task-text.ts, engine/src/handlers/helpers/programs/request-publication.ts, engine/src/handlers/helpers/programs/standalone.ts, engine/tests/core/spawn-task-text.test.ts, engine/tests/pi/review-echo-binding.test.ts, pi/review-run-authority.ts

## Surviving criticals (2) — all `repaired`

### code-reviewer-1 — repair group `group.pr238-echo-fixture`

- **Finding:** `engine/tests/pi/review-echo-binding.test.ts:50` — the result-batch fixture wraps each entry as `{ ok, result: {…} }` (the parser's OUTPUT shape) while `parsePiSubagentResults` reads the flattened entry shape; every fixture entry is shape-rejected, the acceptance assertion fails and the negative case passes vacuously. Confirmed red in CI (run 44484566586, unit-2-of-4 ubuntu + unit-4-of-4 ubuntu/macos).
- **DECLARED root cause:** the fixture was built from `PiSubagentResultEntry` (the parser's output envelope) instead of the raw `details.results` element shape production passes (`pi/subagent-stop.ts` feeds elements straight into the parser; sibling suite `pi-reserved-results.test.ts` builds the flat shape).
- **DECLARED invariant:** the echo-binding suite builds entries in the production envelope shape (`{ agent, task, exitCode, messages }`); its acceptance case proves the matcher accepts a binding-preserving canonical echo, and its negative case proves the rejection is the binding semantics (parseable echo, no Task binding → `extractTaskId` null), not a shape rejection.
- **Siblings:** none-declared — single fixture site; no other suite wraps parser output as input (verified by the refutation panel's reproduction pass).
- **Selected check:** `project:verify`.
- **Historical RED:** engine `npm run verify` at head bd1faa8b failed in CI run 44484566586 — `engine/tests/pi/review-echo-binding.test.ts > the capture matcher accepts a reserved T1 slot whose echo carries the canonical task: expected [ { item: {…} }, index: +0 ] to deeply equal []`.

### pr-test-analyzer-1 — repair group `group.pr238-echo-site-pin`

- **Finding:** `pi/review-run-authority.ts:463` — no test exercises the canonical-task substitution at its changed production site (`recordPiSpawnCorrelators`' re-render arm / `replacePiSpawnTask`'s mutation), so a site regression reintroduces the attempt-1 terminal-rejection incident with every suite green.
- **DECLARED root cause:** the substitution's protection was pinned one layer below its only application site: both new suites compose the canonical task themselves and never import `recordPiSpawnCorrelators`; the one suite that drives it asserts only the stored correlator record.
- **DECLARED invariant:** the correlator-admission suite asserts the dispatched task text at the production site — the extraction-only arm keeps the publication's `Review Task T1.` binding suffix byte-for-byte, the emission-enabled arm keeps `item.task` verbatim, and a non-verbatim issued task falls back to the fresh render.
- **Siblings:** none-declared — `recordPiSpawnCorrelators` has exactly one production call site (`pi/spawn-lifecycle.ts:324`) and one prior driving suite (`engine/tests/pi/spawn-correlator-admission.test.ts`), both accounted: the call site is covered through the suite; the suite is extended.
- **Selected check:** `project:verify`.
- **Historical RED:** engine `npm run verify` at head bd1faa8b was red in CI run 44484566586, and none of its passing assertions named the dispatched task at `recordPiSpawnCorrelators` — the coverage the check lacked is what this repair adds; the pin itself is coverage, so the red state at head is the fixture failure above, not the missing pin.

## Advisory dispositions (6) — published in run.pr238-echo-disposition

| Advisory | Decision | Reason (summary) |
|---|---|---|
| silent-failure-hunter-1 | accepted | Fallback substitution now visible: closed-union return + `loom(pi):` stderr diagnostic at the caller naming role/request. |
| silent-failure-hunter-2 | accepted | Tolerance claim becomes proof: matcher case drives the fallback render against a `taskId: null` reservation. |
| pr-test-analyzer-2 | accepted | Standalone-route composition case through the matcher (marker + binding kept). |
| type-design-analyzer-1 | accepted | `canonicalSpawnTaskText` returns `Readonly<{kind:'issued-kept'\|'render-fallback', task}>`; both outcomes assertable at the seam. |
| architecture-tech-lead-1 | accepted | Same fix as silent-failure-hunter-1 (observable branch at the seam). |
| architecture-tech-lead-2 | deferred | Compose/parse owner for the binding suffix spans `wave-review-requests.ts` (outside frozen scope) and the matcher's `extractTaskId` heuristic — follow-up interface change; the echo-binding contract test pins the composed behavior meanwhile. |

**Accepted advisory fixes (in scope):** union return in `engine/src/core/spawn-task-text.ts`; fallback diagnostic in `pi/review-run-authority.ts`; matcher tests for the fallback tolerance and the standalone route in `engine/tests/pi/review-echo-binding.test.ts`; union-shape updates in `engine/tests/core/spawn-task-text.test.ts`.

## Refuted findings audit

None — `refuted_critical_findings` is empty; the panel upheld both criticals (reproduction and intent lenses) with security uncertain (non-refutation).

## Paths outside the frozen review scope (supportPaths at remediation start)

- `.claude/plans/2026-11-19-pr238-remediation.md` (this plan)
- `engine/tests/pi/spawn-correlator-admission.test.ts` (production-site pin)
- `engine/tests/pi-extension-review-events.test.ts` (CI failure #2: the test pins the old drifted Pi wording `…emit only the required result.`; the canonical re-render now dispatches the shared `REVIEWER_RESULT_INSTRUCTION` — the test's intent (caller-authored text replaced by the issued task) is unchanged, only the pinned string is updated to the imported constant)
- `.gitignore` (`.loom/completion-reports/` → `.loom/`: the verification manifest lives under `.loom/` and must be ignorable for the remediation check to run in a clean worktree)

## Validation

- `project:verify` (`npm run verify` from the worktree root) — the enrolled check, freshly run by the registered remediation (report `.loom/completion-reports/verify.junit.xml`, required-file).
- Push to `fix/canonical-spawn-echo-binding` after installation; GitHub CI (run on the PR) is the independent confirmation.

## Outcome vocabulary

Everything above that is not engine-observed is DECLARED. The registered remediation's own check run, candidate audit and installation receipt are the observed facts; the final report says `repair-checked`, never closed or proven.
