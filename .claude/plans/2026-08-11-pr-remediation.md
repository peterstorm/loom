# PR Remediation — Adjudicated Standalone Review (Round 33)

- **Branch:** `feat/architecture-panel-mode-plan` (base `main`)
- **Standalone run directory:** `.claude/reviews/review-and-fix-runs/run.rVfapX535f`
- **Scope:** 309 paths, frozen in `session.json` (309 files, +83143/-3418 vs `main`)
- **Reviewers:** `code-reviewer`, `silent-failure-hunter`, `pr-test-analyzer`,
  `type-design-analyzer`, `comment-analyzer`, `architecture-tech-lead`
- **Panel:** 3 lenses (`reproduction`, `intent`, `security`), refutation threshold 2
- **Adjudication:** 27 surviving criticals, **0 refuted**, 28 advisories

Surviving criticals include engine-preserved duplicates (the same defect reported
once via a `CRITICAL:` summary line and once via the fenced `findings` block).
The 27 ids collapse to **22 distinct defects**, listed below with every id that
covers them. Fixing the defect discharges all of its ids.

Validation commands: `cd engine && bunx tsc --noEmit` and `cd engine && npm test`
(`test:unit` = vitest, `test:smoke` = the four `scripts/smoke-*.sh` harnesses).

---

## Surviving critical fixes

### P1 — Silent failures / fail-open behaviour (production code)

#### C1. Missing `SPEC_CHECK_HIGH_COUNT` marker is coerced to zero
- **Ids:** `silent-failure-hunter-1`, `silent-failure-hunter-8`
- **Agent:** silent-failure-hunter · **File:** `engine/src/core/spec-check.ts:104`
- **Claim:** `parsed.highCount ?? 0` treats an absent marker as zero instead of
  returning `evidenceFailure`, so a transcript truncated before the high-count
  marker (and thus before any `HIGH:` lines) reconciles as `captured` with
  `high_count: 0` — a clean, verified spec check.
- **Fix:** add a `parsed.highCount === null` guard next to the existing
  `criticalCount === null` / `verdict === null` guards, returning
  `evidenceFailure(wave, runAt, "SPEC_CHECK_HIGH_COUNT marker not found - re-run /wave-gate")`.
  Then use `parsed.highCount` directly for the count reconciliation and the
  emitted `high_count`.
- **Validation:** `cd engine && bunx tsc --noEmit && bunx vitest run tests/core`
  plus a new regression test asserting a transcript without the high-count
  marker resolves to `evidence-failed`.

#### C2. `routeResultNode` fails open to a clean `finalize`
- **Ids:** `silent-failure-hunter-2`, `silent-failure-hunter-9`
- **Agent:** silent-failure-hunter · **File:**
  `engine/src/orchestration/dags/standalone-review-operations.ts:237`
- **Claim:** the join defaults to `{ kind: "finalize", advisoryCount: 0 }` when
  neither routing branch produced a result, while `scopeResultNode` (line 126),
  `panel-operations.ts:192` and `remediation-operations.ts:259` all fail closed
  with a `blocked`/`rejected` reason in the identical situation.
- **Fix:** add a `{ kind: "blocked"; reason: string }` arm to `CriticalRoute` and
  `criticalRouteSchema` (mirroring `ResolvedScope`), and return
  `{ kind: "blocked", reason: "neither routing branch produced a result" }` from
  `routeResultNode`. Make the sibling `summary === undefined` fall-throughs in
  `toRefutationNode`/`toFinalizeNode` blocked as well — an absent summary is a
  framework reconciliation failure, distinct from the documented and deliberate
  `criticalCount === 0 → finalize` routing, which is preserved.
- **Validation:** `cd engine && bunx tsc --noEmit && bunx vitest run tests/orchestration`
  plus a new test driving the join with an empty envelope.

#### C3. `readReceipt` collapses a corrupt receipt into "never ran"
- **Ids:** `silent-failure-hunter-3`, `silent-failure-hunter-10`
- **Agent:** silent-failure-hunter · **File:**
  `engine/src/orchestration/run-directory-handle.ts:567-573`
- **Claim:** the bare `catch { return null }` makes an unreadable or truncated
  receipt indistinguishable from an absent one, so `effect-runner.ts:163` treats
  the effect as never executed and re-runs it, breaking the module's documented
  "an effect that already recorded a receipt is never re-run" guarantee. Sibling
  readers (`readAuthority`, `readContext`) route unreadable content through an
  `{ __unreadable }` marker that still fails loudly.
- **Fix:** distinguish absence from corruption — return `null` only for `ENOENT`,
  and surface any other read/parse failure through the same `__unreadable`
  sentinel the sibling readers use, so the effect runner refuses to resume rather
  than silently re-executing.
- **Validation:** `cd engine && bunx tsc --noEmit && bunx vitest run tests/orchestration`
  plus a fault-injection test that corrupts a receipt and asserts the runner
  fails instead of re-running the intent.

#### C4. `promoteArtifactSet` silently overwrites a published artifact
- **Ids:** `architecture-tech-lead-1`, `architecture-tech-lead-4`
- **Agent:** architecture-tech-lead · **File:**
  `engine/src/orchestration/run-directory-handle.ts:490-512`
- **Claim:** the only pre-rename check is `isExistingDirectory(entry.final)`;
  `publishStagedRunFile`'s `renameSync` then replaces an existing regular file.
  The module header promises O_EXCL immutability ("republishing a slot fails
  loudly instead of silently rewriting history"), and every sibling writer
  honours it. Reachable because standalone result publication is content-addressed
  by `effectId` but targets the fixed `result.json` slot, so a second publish with
  different bytes computes a different `effectId`, passes the receipt
  short-circuit, and overwrites the audit-relevant prior result.
- **Fix:** before renaming, refuse promotion when a regular file already exists at
  `entry.final` unless its bytes are byte-identical to the staged content — the
  same "same content OK, different content refused" rule the O_EXCL writers use.
- **Validation:** `cd engine && bunx tsc --noEmit && bunx vitest run tests/orchestration/publication-faults.test.ts`
  plus a new test publishing the same `relativePath` twice with different bytes.

#### C5. `LlmProfileId` closed-enum bypassed at the aggregate parse boundary
- **Ids:** `type-design-analyzer-1`, `type-design-analyzer-4`
- **Agent:** type-design-analyzer · **File:**
  `engine/src/core/standalone-review.ts:1313,1325`
- **Claim:** `parseReviewerEvidence` validates `entry.model_profile` only as a
  non-empty string and then casts it to `LlmProfileId`, never calling
  `parseLlmProfileId` (`model-profiles.ts:167`) — the allowlist validator used at
  every other production site. `parseStandaloneAggregate` reads untrusted on-disk
  JSON, so a malformed `aggregate.json` yields a value outside `LLM_PROFILE_IDS`
  typed as a member of it.
- **Fix:** replace the cast with `parseLlmProfileId` and push a parse error when it
  returns `null`, matching the surrounding accumulate-and-fail style.
- **Validation:** `cd engine && bunx tsc --noEmit && bunx vitest run tests/core/standalone-review.test.ts`
  plus a regression test feeding an off-allowlist `model_profile`.

### P2 — Adjudicated critical whose premise the code refuted

#### C6. `enforceRecoveryHistoryLifecycle` accepts a partial receipt deficit
- **Id:** `pr-test-analyzer-2`
- **Agent:** pr-test-analyzer · **File:** `engine/src/core/remediation-machine.ts:2248-2261`
- **Claim:** for `active`/`done` the check rejects only `receiptCount > attemptCount`
  and `attemptCount > 0 && receiptCount === 0`, so a rehydrated state with
  `0 < receiptCount < attemptCount` — "an outstanding unconsumed recovery attempt" —
  parses as resolved.
- **Outcome: NOT FIXED — the premise is false, and the fix was reverted.**
  Tightening the rule to `receiptCount === attemptCount` was implemented and
  immediately failed an existing test
  (`remediation-machine.property.test.ts:1239`, *"round-trips repeated blocked
  recovery failures without fabricating consumed receipts"*). Reading the reducer
  confirms why: a second `recoverable-effect-failed` while already blocked
  APPENDS an attempt id and REPLACES `state.failure`, and
  `recovery-receipt-accepted` (line 2333) only matches
  `state.failure.recoveryAttemptId` — the latest attempt. One receipt therefore
  discharges the block however many attempts preceded it, so
  `0 < receiptCount < attemptCount` is a legitimate resolved state the reducer
  produces itself, not a forged one. There is no outstanding attempt to be
  "unconsumed". The panel's `reproduction` lens upheld this finding; the code
  disagrees, and the code is checkable.
- **What was done instead:** the invariant is now documented at the guard so the
  next reviewer does not re-file it, and the existing test that pins the
  behaviour stays the proof. The `receiptCount > attemptCount` and
  zero-receipt rules are unchanged.
- **Validation:** `cd engine && bunx vitest run tests/core/remediation-machine.property.test.ts`

### P3 — Untested guards (test coverage for reachable fail-closed paths)

Each item adds a test that supplies the mismatched/hostile input the guard exists
to reject. All are in `engine/tests/` unless noted.

| # | Id | Location | Test to add |
|---|---|---|---|
| C7 | `pr-test-analyzer-1` | `core/remediation-machine.ts:2364-2387` | proof minted from a foreign authority/run — assert each of the audited/staged/verified/installation digest+runId guards rejects |
| C8 | `pr-test-analyzer-3` | `core/remediation-machine.ts:413-483` | LC-2 publication loader that throws, is not a function, and returns a malformed envelope |
| C9 | `pr-test-analyzer-4` | `core/orchestration-contract.ts:37-141` | direct `canonicalStructuralEquals` tests: null-prototype vs `Object.prototype`, `Map`/`Set`/`Date`/`RegExp`, `undefined`-valued own key vs absent key, cycles |
| C10 | `pr-test-analyzer-5` | `core/orchestration-contract.ts:3241-3256,3727` | construct and round-trip the six unexercised `TerminalBlockedDiagnostic` categories |
| C11 | `pr-test-analyzer-6` | `core/panel-program.ts:1534` | registration diverging from the roster on each authority field — see note below |
| C12 | `pr-test-analyzer-7` | `core/findings.ts:1112-1117` | `startReviewRun` with a malformed packet id, malformed head SHA, and empty/duplicated expected agents |
| C13 | `pr-test-analyzer-8` | `core/findings.ts:865-892` | `findingIdCollisionError` collision that only appears across `resolved_findings` |
| C14 | `pr-test-analyzer-9` | `core/standalone-review-machine.ts:875` | event whose `runId` differs from `state.authority.runId` reaching the foreign-run-event guard |
| C15 | `pr-test-analyzer-10` | `core/standalone-review-machine.ts:722-725,760-763` | resubmit an already-accepted slot (duplicate) and submit an off-roster slot (unknown) |
| C16 | `pr-test-analyzer-11` | `core/standalone-review.ts:362-372` | roster with a foreign `runId`, wrong program, and role order diverging from `selectStandaloneReviewers` |
| C17 | `pr-test-analyzer-12` | `orchestration/no-follow-fs.ts:143-172` | plant a symlink before `readRunFileNoFollow`, `readRunBytesNoFollow`, `removeRunFileNoFollow` |
| C18 | `pr-test-analyzer-13` | `state-manager.ts:251-252` | wave-gate registration whose receipt `runId` and `committedRevision` disagree with the entry |
| C19 | `pr-test-analyzer-14` | `state-manager.ts:772-777` | history with a duplicate `runId`, a duplicate wave, and an active-history collision |
| C20 | `pr-test-analyzer-15` | `pi/write-grant.ts:166` | remove the bound task graph between issuance and `consumePiWriteGrant` |
| C21 | `pr-test-analyzer-16` | `pi/extension.ts:1340` | Pi-reported `files_modified` containing a traversal / out-of-repo path |
| C22 | `pr-test-analyzer-17` | `state-manager.ts:529-534,650-675` | task graph with inconsistent `review_run`/`review_status` and with malformed/duplicated `slot_authority` |

**Note on C11.** The `reproduction` lens was right that the guard at
`panel-program.ts:1534` cannot fire through `resolvePanelRequest`:
`parseIssuedSpawnRequest` returns the authority from the REGISTRATION, and
`samePublishedRequest` (`orchestration-contract.ts:1420-1435`) already compares
the roster authority against it on exactly the field set `authorityMatches`
compares. A divergence is therefore caught one layer earlier as
`request-rehydration-failed`, and line 1534 is a redundant second net. The
remediation covers the boundary where the divergence IS reachable — a
registration tampered per authority field, driven through
`submitArchitectureCandidateResult` — and records in the test why the later
check cannot be reached, so narrowing either comparison in future fails a test.

**Note on C14.** Likewise, `standalone-review.test.ts` already fed a
`runId: "run.foreign"` result into the reducer, so the guard was reached — but
the test only asserted `.ok === false` and could not tell which guard rejected.
The added tests assert the `foreign-run-event` category itself, across three
event kinds.

---

## Refuted Findings (not fixing)

**None.** The refutation panel refuted 0 of 27 critical findings at threshold 2.

Four findings drew a single `refuted` vote from the `reproduction` lens and
survived because no second lens agreed. They are recorded here for audit — they
are *not* exempt from remediation:

| Finding | Refuting lens | Reason given | Other lenses |
|---|---|---|---|
| `silent-failure-hunter-2` | reproduction | "`ROUTE_RESULT` has no incoming edge except from `TO_REFUTATION`/`TO_FINALIZE`, so `decideRoute` always fires exactly one; the neither-branch state cannot be reached." | intent: upheld (sole outlier vs three sibling fail-closed joins); security: uncertain |
| `silent-failure-hunter-9` | reproduction | Same argument, duplicate id. | intent: upheld; security: uncertain |
| `pr-test-analyzer-6` | reproduction | "`samePublishedRequest` already proved the registered authority equal to the roster authority on exactly the field set `authorityMatches` compares, so any divergence fails earlier as `request-rehydration-failed`." | intent: upheld (ordinary reachable guard, no unreachability annotation); security: uncertain |
| `pr-test-analyzer-9` | reproduction | "`standalone-review.test.ts:1349-1364` already feeds a tampered result with `runId: \"run.foreign\"` into the reducer and asserts rejection, so 'never exercised' is false as written." | intent: upheld; security: uncertain |

For C2/C11/C14 the remediation is written so it holds regardless: the fix makes
the join fail closed and the tests assert the guard's behaviour directly rather
than relying on its reachability from the current caller set.

---

## Advisories — deferred (not accepted this round)

28 advisory ids (14 distinct defects) were adjudicated but are **not** part of
this remediation, since surviving criticals take priority. Recorded for a later
round:

- `capture-orchestration-result.ts:239` — `no-reservation` outcome is not audited
  (`code-reviewer-1/2`)
- `utils/git.ts:75-87` — `execArgs` returns `""` on command failure
  (`silent-failure-hunter-4/11`)
- `handlers/helpers/review-packet.ts:59` — packet written to its final path, not
  temp+rename (`silent-failure-hunter-5/12`)
- `core/panel-program.ts:1096` — catch discards the real parse error
  (`silent-failure-hunter-6/13`)
- `core/panel-program.ts:2022` — re-parse catch misclassifies the rejection
  (`silent-failure-hunter-7/14`)
- `core/orchestration-contract.ts:1999-2013` — hostile durable-claim-port
  sub-paths untested (`pr-test-analyzer-18`)
- `core/panel-program.ts:1837/1923` — terminal-state guard `error.kind`
  unasserted (`pr-test-analyzer-19`)
- `core/panel-program.ts:1453-1527` — unknown-request roster check untested
  (`pr-test-analyzer-20`)
- `core/standalone-review.ts:267-282` — `selectStandaloneReviewers` branch matrix
  under-exercised (`pr-test-analyzer-21`)
- `core/review-panel.ts:402-404` — task-scoping check never isolated
  (`pr-test-analyzer-22`)
- `orchestration/effect-runner.ts:101-117,187-190` — multi-item reserve loop and
  two intents never dispatched (`pr-test-analyzer-23/24`)
- `orchestration/dags/*` — panel/remediation DAG happy paths never driven
  (`pr-test-analyzer-25`)
- `pi/extension.ts:958` — `missingSpecChecks` branch untested
  (`pr-test-analyzer-26`)
- `state-manager.ts:447` — duplicate-`packet_path` guard shadowed
  (`pr-test-analyzer-27`)
- `core/standalone-review.ts:564` — `slotId`/`requestId` unbranded
  (`type-design-analyzer-2/5`)
- `types.ts:395` — `findings`/`critical_findings`/`advisory_findings` lockstep not
  structural (`type-design-analyzer-3/6`)
- `orchestration/git-remediation.ts:441-491` — CAS not atomic with its own write
  (`architecture-tech-lead-2/5`)
- `core/orchestration-contract.ts` — 4279-line module spanning five aggregates
  (`architecture-tech-lead-3/6`)

---

## Found while validating (outside the adjudicated set)

Two changes were needed to land the above and are reported rather than buried:

1. **A flaky property test in the changed scope.**
   `engine/tests/core/review-output-round14.test.ts:92` filtered its generated
   claims with an inlined `^(none|n/a|nothing)$` regex — a strict subset of
   `isNoFindingSentinel`, which also drops `na`, `nil`, `null` and the
   parenthesized/punctuated forms. The generator could therefore produce a claim
   (`"nA   "`) the parser correctly discards, and the property then demanded it
   be preserved. It failed once during the first full run of this remediation;
   reproduced at roughly 1 seed in 1700. Fixed by filtering with the production
   classifier, then verified over 200,000 generated cases.
2. **Documentation that C1 made wrong.** `agents/spec-check-invoker.md` and
   `commands/spec-check.md` both stated that only `SPEC_CHECK_CRITICAL_COUNT` and
   `SPEC_CHECK_VERDICT` were required. C1 makes `SPEC_CHECK_HIGH_COUNT` required
   too, so both were updated. `commands/spec-check.md` was not in the frozen
   review scope; it is in the audited remediation path set because this
   remediation edited it.

## Execution order

1. C1 → C6 (production fixes, each with its regression test)
2. C7 → C22 (guard coverage), grouped by file to keep the diff coherent
3. `cd engine && bunx tsc --noEmit`
4. `cd engine && npm test`
5. Stage only the audited remediation path set plus this plan; commit; push
