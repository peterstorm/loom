# PR Remediation — run.raf20260818c

- **Branch:** `feat/architecture-panel-mode-plan`
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/run.raf20260818c`
- **Scope:** frozen whole-branch scope (`main...HEAD`), 460 files
- **Panel:** lenses `reproduction`, `intent`, `test-coverage`; refutation threshold 2
- **Counts:** 12 critical found / 0 refuted / 12 surviving; 48 advisories

## Refuted-finding audit

The Refutation Panel refuted **zero** findings. One finding drew a single
refutation but did not reach the threshold of 2 and therefore survives as
mandatory:

- `standalone-review:architecture-tech-lead-1` (`engine/src/utils/git.ts:37`)
  — refuted by the **intent** lens: *"git.ts:77-87's own comment states outright
  that `repositoryContext` 'deliberately re-resolves its own root and HEAD ...
  because it is a proof boundary that must not inherit a root captured at module
  load' and explicitly says this is 'NOT every git boundary in the process' — the
  exact asymmetry the finding calls out is textually documented as an
  intentional, load-bearing design choice."* The `reproduction` and
  `test-coverage` lenses returned `uncertain`. Survives 1-of-3; fixed below in a
  way that keeps the documented proof-boundary distinction intact.

## Surviving criticals — mandatory fixes

`comment-analyzer-6`/`-7` are byte-duplicates of `comment-analyzer-1`/`-2`, so
the 12 surviving findings resolve to 10 distinct fixes.

### K1 — `passthrough` has no operator-facing message channel
`engine/src/types.ts:35`, `engine/src/cli.ts:50` (+ hook call sites)

Add `systemMessage?: string` to the `passthrough` variant of `HookResult`,
mirroring `allow`. Surface it in `resultToExit`'s passthrough branch as JSON on
stdout (the only channel that reaches the operator on an exit-0 hook). Extend
`passthroughResult()` to take an optional message routed through
`nonEmptyMessage`. Convert every **hook** call site that writes a diagnostic to
stderr immediately before returning `passthrough` to populate the field instead.

Scope note: `handlers/helpers/*` are CLI helper commands, not exit-0 hooks —
their stderr *is* visible to their caller, and several of them (`orchestration`
above all) emit machine-read JSON on stdout that a `systemMessage` line would
corrupt. Those sites keep writing to stderr; only the swallowed-stderr hook
paths move to the new channel.

### K2 — bare `as` cast over unvalidated harness JSON
`pi/extension.ts:1536`

Replace the `rawResults as Array<{ agent: string; ... }>` cast with a real
per-element parse that checks `agent`/`task`/`exitCode` shape, emitting the same
loud diagnostic style the array-level guard one layer up already uses, so a
malformed element cannot reach `stripNamespace(result.agent)` typed as a
guaranteed string.

### K3 — wrong JSDoc on `tasksOf` (`comment-analyzer-1`, `-6`)
`engine/src/handlers/helpers/validate-task-graph.ts:654`

Replace the copy-pasted "Production filesystem port for model-binding checks"
docstring with one that describes the pure one-line accessor it sits on.

### K4 — stderr points the operator at an unimplemented flag (`comment-analyzer-2`, `-7`)
`engine/src/handlers/helpers/complete-wave-gate.ts:549`

Replace `Run /loom --complete to finalize.` with the documented
`helper cleanup-state` path (README.md, docs/operations.md and commands/loom.md
all state `/loom --complete` is not implemented).

### K5 — module-load `repoRoot` binding
`engine/src/utils/git.ts:37`

Make the module's own root resolution fresh-per-call, memoized on the resolution
key (`CLAUDE_PROJECT_DIR` or `process.cwd()`), so a changed environment
re-resolves instead of inheriting a root captured at import time. The
`repositoryContext` proof boundary keeps its own independent single-pass
resolution; its docstring is updated so the distinction it documents stays true.

### K6 — hand-rolled flag parsing re-introduces the bug `cli-args.ts` exists to fix
`engine/src/handlers/helpers/populate-task-graph.ts:25`

Replace `parseArgs`'s hand-rolled loop with `argumentValue`/`hasFlag`, so
`--issue --fix` is no longer parsed as `issue = Number("--fix")` with `--fix`
silently dropped.

### K7 — Vitest branch can read a failed run as passed
`engine/src/handlers/subagent-stop/update-task-status.ts:100`

Add the `vitestFailed[1] === "0"` guard the Mocha, cargo, pytest and Bun
branches all enforce.

### K8 — unreachable exclusion branch
`engine/src/core/remediation-machine.ts:180`

Delete the `components[1] === "specs" && components[3] === "panel-runs"` tail:
the preceding `.some()` over `RUN_LAYOUT_COMPONENTS` (which contains
`panel-runs`) already returns true for every path it could match.

### K9 — test proves nothing about the wrapper it claims to test
`engine/tests/handlers/pi-adapter-fail-closed.test.ts`

`processToolResult` catches a throwing `lintFn` internally and never rethrows,
so the outer catch is never reached. Restructure the suite to (a) keep and
correctly attribute the cases that prove `pi-adapter`'s own inner fail-closed
catch, and (b) add cases that genuinely reach the extension-level wrapper by
throwing from the pre-call step the real handler performs inside its `try`
(project-root/rules-dir resolution — `process.cwd()` throws `ENOENT` when the
working directory has been removed). Fix the stale line reference in the header.

### K10 — unreachable `persistentFailure` fallback arm
`engine/src/core/panel-program.ts:2049`

The two guards above the ternary already return unless `state.stage` matches the
event type, so the third arm cannot be reached. Collapse the ternary to the
two reachable branches.

## Advisory dispositions

48 advisories, dispositioned autonomously from evidence, correctness impact,
risk and reviewed scope.

### Accepted (19)

| ID | Fix |
|----|-----|
| `pr-test-analyzer-1` | Test that a corrupted `abandoned.json` makes `bindLiveRun` refuse an advancing operation. |
| `pr-test-analyzer-2` | Test `remediationAuditBlockMessage`'s non-unauthorized-dirty-paths branch passes the message through unmodified. |
| `pr-test-analyzer-3` | Integration test pinning the `piAllSlotsFailedNote` stderr write in the `tool_result` handler. |
| `comment-analyzer-3` | Add the seventh `AgentKind` (`spec-check`) to CONTEXT.md's glossary. |
| `comment-analyzer-4` | Add `complete` to `orchestration.ts`'s module JSDoc usage block. |
| `comment-analyzer-5` | Move the "Four repairs, in order" JSDoc onto `fixTaskFindings`. |
| `architecture-tech-lead-4` | One `isImplAgent` predicate shared by both gates. |
| `architecture-tech-lead-10` | Correct `git.ts`'s "single resolver every caller shares" claim (folded into K5). |
| `architecture-tech-lead-11` | One `isTestFile` predicate in the linter config, used by all three rules. |
| `architecture-tech-lead-12` | Delete the dead `isBinaryFile` TOCTOU export. |
| `architecture-tech-lead-13` | Extract the shared per-file lint pipeline; remove the timeout drift. |
| `code-simplifier-6` | Import from the curated `orchestration-contract` facade. |
| `code-simplifier-19` | Share the `ok()`/`fail()` `ValidationResult` constructors. |
| `code-simplifier-20` | Extract the duplicated spec-artifact resolution block. |
| `code-simplifier-23` | Reuse `compareStrings` in `compareRankings`. |
| `code-simplifier-25` | Delete the unreferenced `JsonRecord`/`JsonValue` declarations. |
| `code-simplifier-26` | Compute unknown-field errors against the correct key list; drop the substring re-filter. |
| `code-simplifier-27` | Delete the importer-less `isTestCommand` export and its re-export. |
| `code-simplifier-31` | Remove the dead `!parsedMessages.ok` disjunct and the ternary arm built on it. |

`architecture-tech-lead-10` is discharged as part of K5 rather than on its own.

### Dismissed (1)

- `code-simplifier-30` — `cli.ts`'s two `init-state` dispatches do **not** guard
  the same condition: the first handles `init-state` arriving with no
  `handlerName` (argv shape `init-state <flags>`), the second handles it parsed
  as `hookType` with `handlerName` present. Collapsing them would change which
  argv shapes are accepted. Not a defect.

### Deferred (28)

Each needs its own design pass and a blast radius larger than a remediation
commit should carry; none is a live-wrongness claim.

- `architecture-tech-lead-2` — one generic `PersistentPanel` engine replacing the
  twin Architecture/Refutation lifecycles (~2716-line file, both panels are
  load-bearing for `/loom` and `/review-pr`).
- `architecture-tech-lead-3` — shared quote/escape lexer under
  `guard-state-file.ts`'s walkers. This module's own header records three prior
  regression rounds caused by touching exactly this logic; it must be a
  dedicated, pinning-test-first change, not a drive-by.
- `architecture-tech-lead-5`, `-6`, `-7` — `update-task-status.ts` restructuring
  (reuse `applyUntrustedStopResolution` from the Claude path, hoist git I/O out
  of the locked reducer, move ~700 lines to `core/`). One coherent piece of work
  behind the state-lock contract.
- `architecture-tech-lead-8` — route the Wave Gate façade onto
  `projectWaveGateLifecycle`; ADR-0006's own named open follow-up.
- `architecture-tech-lead-9` — the test-surface marker convention ADR-0007 names
  as its unblocking step, then generalizing the public-surface check.
- `code-simplifier-7` — ~97 declaring-file-only exports across 9
  orchestration-contract volume files; blocked on the same marker convention.
- `code-simplifier-8`, `-9`, `-10`, `-11`, `-12`, `-13`, `-14`, `-15`, `-16`,
  `-17`, `-18`, `-21`, `-22`, `-24`, `-28`, `-29` — duplication consolidations in
  orchestration, panel, wave-gate, path-containment and findings-parsing code.
  Several (`-14`, `-15`, `-28`) sit directly on path-containment and
  exclusive-write security predicates where a shared abstraction must be
  designed, not extracted mechanically.
- `code-simplifier-32`, `-33`, `-34`, `-35` — test-fixture consolidation across
  ~25 test files; mechanical but touches a third of the suite.

## Validation

```bash
cd engine && npm run typecheck
cd engine && npm run test:unit
cd engine && npm run test:smoke
```

Validation must pass before the remediation run stages anything.

---

## As landed

New files introduced by the remediation (each named in the remediation run's
`supportPaths`, since none is inside the frozen review scope):

| File | Why |
|------|-----|
| `engine/src/utils/hook-diagnostic.ts` | K1's seam: `passthroughDiagnostic` writes stderr and the `systemMessage` from one call, so the two channels cannot carry different text. |
| `engine/src/core/ordering.ts` | `code-simplifier-23`'s home for `compareStrings`. Three copies existed, not the two the finding named — `model-calibration.ts`, `standalone-review.ts`, and an inline form in `panel-contract.ts`'s `compareRankings`; all three now call it. |
| `engine/tests/handlers/helpers/programs/remediation-audit-message.test.ts` | `pr-test-analyzer-2`'s pinning test. |
| `.claude/plans/2026-08-18-pr-remediation-round3.md` | This plan. |

Follow-on corrections the fixes forced, each a consequence rather than a
separate change:

- **K1** → `store-reviewer-findings.test.ts` and the passthrough shape it
  asserts. Two cases pinned `toEqual({ kind: "passthrough" })`; they now pin the
  exact `systemMessage` as well, which is a stronger assertion than the one they
  replaced.
- **K2** → `pi-extension-review-events.test.ts`. Its "first result throws" case
  used `agent: null` to force a throw inside the per-result loop; the new
  per-element parse rejects that element before the loop, so the case is split.
  One test now pins the malformed-shape rejection, and a second forces a real
  downstream throw (a rejected `StateManager.update`) so the loop's own
  per-result `try/catch` keeps its coverage.
- **K5** → `update-task-status.test.ts`'s `makeSession`. It set
  `CLAUDE_PROJECT_DIR` to a temp directory while planting a write into the real
  repository — a combination production cannot produce, which only passed
  because the git helpers answered from a root frozen at import. The fixture now
  declares this repository as the project for the case that needs a real
  repository path; transcript isolation still comes from `CLAUDE_CONFIG_DIR` and
  the unique session id.
- **`architecture-tech-lead-12`** → `linter/index.test.ts`. The five deleted
  `isBinaryFile` cases were retargeted onto `isBinaryBuffer`, the detector
  `lintFile` actually calls, so SC-007 coverage survives the deletion.
- **`architecture-tech-lead-13`** → `lintFiles` gained the `timeoutMs` parameter
  `lintFile` already had. That is the drift the finding named: the shared
  pipeline takes one budget, so it must be passed rather than hardcoded.

Scope note on K1: 28 stderr-then-passthrough sites exist, but only the 18 in
hook handlers were converted. The 10 under `handlers/helpers/` are CLI helper
commands whose stderr does reach their caller, and several emit machine-read
JSON on stdout that a `systemMessage` object would corrupt.

## Validation evidence

```
cd engine && npm run typecheck    # tsc --noEmit + --noUnusedLocals/Parameters — clean
cd engine && npm run test:unit    # 186 files, 4750 tests passed (baseline: 185 / 4736)
cd engine && npm run test:smoke   # panel-mode, review-panel (PASS 19/0), standalone-review,
                                  # orchestration-facades (6/6), pi-resources — all PASS
```

## Remediation runs

`run.rafrem20260818c` blocked at start:

```
unauthorized dirty paths: engine/src/handlers/post-tool-use/record-evidence.ts,
engine/src/handlers/pre-tool-use/enforce-phase-tools.ts
```

Both are K1 conversion sites that are unchanged on this branch and therefore
outside the frozen review scope, and its start input had not named them. The
start input is immutable, so that run can never authorize them — it is retained
as evidence and superseded by `run.rafrem20260818c2`, whose start input adds
both to `supportPaths`.

That block is the split-recovery behaviour `remediationAuditBlockMessage`
produces, and `pr-test-analyzer-2`'s new test pins the other branch of it.
