# PR Remediation Plan — 2026-08-19

**Branch:** `feat/architecture-panel-mode-plan`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/run.raf20260819a`
**Canonical result:** `run.raf20260819a/result.json` (digest `f89f9ef352aae95ed1a67a8c27b9c15b8d9f9c692a503f2ad1b7a004ceb67f8f`, 65487 bytes)
**Scope:** 466 files — whole-repository standalone review (`kind: all`, `files: null`)
**Roster:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer,
comment-analyzer, architecture-tech-lead, code-simplifier (7 slots, 8 attempts —
`standalone-slot:7:code-simplifier` attempt 1 rejected for a missing Machine Summary).

## Adjudication

| Bucket | Count |
|---|---|
| Surviving critical findings | 16 (14 distinct defects) |
| Refuted critical findings | **0** |
| Advisory findings | 49 (34 distinct) |

**Refutation Panel:** lenses `reproduction`, `intent`, `test-coverage`; threshold 2.
`refutation-slot:1d0302…` attempt 1 rejected (verdict set omitted
`standalone-review:comment-analyzer-8`); attempt 2 accepted. **No finding was refuted** —
every critical carried ≥2 upholding lenses. There is therefore no refuted-finding audit
section: the set is empty.

Duplicate ids in the result are marker-line/JSON-block twins of the same defect
(`code-simplifier-8/9` ≡ `1/2`; `code-simplifier-10..14` ≡ `3..7`). Each defect is fixed once.

## Advisory dispositions

**All 34 distinct advisories are ACCEPTED.** Every one was independently re-verified against
the source below before acceptance; each claim is sound, sits inside the frozen review scope,
and has a complete, reachable fix. No advisory is deferred or dismissed.

## Surviving criticals — mandatory fixes

### Fail-open filesystem gates (silent-failure-hunter)

1. **`engine/src/handlers/task-execution.ts:71`** — `existsSync(statePath)` collapses EACCES /
   ELOOP / ENOTDIR / EIO to "no graph" and allows the whole implementation spawn batch
   unchecked. **Fix:** `pathExistsFailClosed(statePath)` (already the convention in
   `validate-phase-order.ts`, `block-direct-edits.ts`, `guard-state-file.ts`).
2. **`engine/src/handlers/pre-tool-use/validate-agent-skill.ts:56`** — same bare `existsSync`
   as the handler's first gate, fail-open ahead of its own documented fail-closed parse
   handling. **Fix:** `pathExistsFailClosed(TASK_GRAPH_PATH)`.

### Locale-dependent digests (code-simplifier)

3. **`engine/src/runtime-compatibility.ts:29`** — `runtimeRevisionFromEntries` sorts with
   `localeCompare` before hashing into the content-addressed Runtime Revision. **Fix:**
   `compareStrings` from `core/ordering`.
4. **`engine/src/handlers/helpers/programs/wave-gate.ts:39`** — `waveAdvisoryDecisionRequestId`
   sorts with `localeCompare` before `JSON.stringify` + SHA-256 idempotency key. **Fix:**
   `compareStrings`.

### Producer/consumer contradiction + inaccurate contracts (comment-analyzer)

5. **`engine/src/core/findings.ts:490`** — JSDoc claims only a `fixFull` repair caller reaches
   `parseStoredFindings`; `legacy-archive.ts:211/212/224`, `validate-task-graph.ts:378` and
   `standalone-review.ts:1360` all call it directly. **Fix:** state the real contract.
6. **`engine/src/types.ts:267`** — attributes the `[head, ...tail]` destructure to
   `tallyRefutations`; it is in `countRefutationVotes` (`review-panel.ts:1206`). **Fix:** name
   the real site.
7. **`pi/extension.ts:851`** — claims roster ids include task text; `piSpawnRosterId` hashes
   only `[toolCallId, index, agent]`, and `piSpawnItem:176` says task text is deliberately
   excluded. **Fix:** correct to batch ordinal + agent.
8. **`engine/src/handlers/subagent-stop/update-task-status.ts:570`** and
   **`dispatch.ts:71`** — both claim a subsequent bind truncates the ledger;
   `ledger.ts:460-476` documents that truncation-on-bind was deliberately removed (it raced
   `appendEvidence`). **Fix:** restate the real reason the pre-unbind snapshot is needed
   (`cleanup` unbinds the machine, so a post-cleanup read cannot attribute this epoch).
9. **`update-task-status.ts:736`** — claims a bad identity yields "no epoch events, no
   machine"; `loadedMachine` depends only on `epochAgentType`, so a malformed `agent_id`
   alone still loads the machine. **Fix:** split the two consequences.
10. **`update-task-status.ts:98`** — claims `/Tests?\s+\d+ passed/` matches
    `"Test Files N passed"`; the literal `Files` sits where the count must be, so it never
    does. **Fix:** describe what the regex actually matches (paired with advisory
    `comment-analyzer-17`, the example on line 101 that also fails to match).
11. **`engine/src/handlers/helpers/review-panel.ts:106`** — claims
    `runbook-contract.test.ts` binds `REVIEW_PANEL_OPERATIONS` to the wave-gate runbook in
    both directions; that test only binds `PANEL_CONTRACT_OPERATIONS`, and separately asserts
    the wave-gate/review-and-fix runbooks must **not** name these helper invocations.
    **Fix:** state the real contract (façade-owned; the runbook must not drive it).
12. **`engine/src/core/standalone-review.ts:77`** — `unstaged` JSDoc says "differs from
    HEAD"; the producer runs `git diff --name-only` without `--cached`, i.e. worktree vs
    index. **Fix:** correct the JSDoc.
13. **`engine/src/core/standalone-review.ts:251`** — comment asserts `docs_only` and
    `source_or_test_changed` are mutually exclusive by definition, but `classifyScope`
    produces both `true` for a path like `docs/tests/x.md`, and the load boundary then
    **rejects the producer's own record**. **Fix (real, not cosmetic):** make `classifyScope`
    enforce the invariant — `docsOnly` becomes "matches the docs pattern **and** no source or
    test file changed" — so producer and validator agree; then the comment is true.

## Accepted advisories — planned fixes

**code-reviewer**
- `harness-capture-runtime.ts:181` — route post-reservation refusals
  (`transcripts`, bind `attempt-mismatch`/`identity-mismatch`, `wrong-agent-role`,
  `context`, `context-binding`, `transcript`) through `reject()` so each tombstones and
  journals. `duplicate-capture` stays a direct return (`rejectCapture` refuses an
  already-captured attempt by design); the doc comment names it as the one exception.
- `wave-gate-machine.ts:480/487/831` — extract `testsExempt` / `testEvidenceSatisfied` /
  `newTestsSatisfied` and use them in `checkTestEvidence`, `checkNewTests`,
  `deriveTestReadinessForTasks`.
- `standalone-review.ts:1389` — `sanitizeProse` the `file` field like `buildFindingBrief`.
- `programs/helpers.ts:132` — `reviewablePath` fails closed on unparseable paths.
- `orchestration.ts:1037/1067` — move the architecture candidate/finalize checks into
  `core/panel-contract` as `Either`-returning parsers; drop the `as never` cast.
- `validate-task-graph.ts:680` — guard `JSON.parse` with the file's own `isRecord`.
- `store-review-findings.ts:149`, `store-test-evidence.ts:11` — use `argumentValue`.
- `scripts/run-model-calibration.ts:66` — build the prompt inside the per-case `try`.
- `scripts/smoke-orchestration-facades.ts:25` — add `task: string` to `SpawnRequest` and drop
  the non-null assertions it forced.

**silent-failure-hunter**
- `enforce-phase-tools.ts:36` — probe with a throwing call so the documented fail-closed catch
  actually covers directory stat errors.
- `state-manager.ts:1202` — `pathExistsFailClosed` in `StateManager.fromPath`.

**pr-test-analyzer**
- `pi/write-grant.ts:376` — add a sweep test for the schema-invalid (valid-JSON) grant branch.

**type-design-analyzer**
- Freeze the mutable vocabulary/closed-set singletons (`tool-vocabulary.ts:18`,
  `panel-contract.ts:66`, `remediation-machine.ts:165` — the last needs real immutability, not
  `Object.freeze` on a `Set`).
- `harness-resources.ts` — return `DomainResult` instead of throwing raw `Error`.
- `wave-gate-machine.ts:996` — make the `nextActionAuthority`/`lifecycleCheckpoint` pairing a
  single nullable parameter object.
- `wave-gate-machine.ts:1880` — remove the `as never`/state casts in `projectWaveGateLifecycle`.
- `standalone-review.ts:588`, `standalone-review-machine.ts:62` — restore the branded ids.
- `review-panel.ts:1199` — match `RefutationKind` exhaustively.
- `proof-obligations.ts:578` — make `pending` explicit and the switch exhaustive.
- `validate-phase-order.ts:115` — `readonly` on `ArtifactState`.
- `git-remediation.ts:325` — brand `TemporaryIndex` (WeakSet idiom already used in
  `remediation-machine.ts`).
- `run-directory-handle.ts:1466` — validate the receipt shape instead of asserting it.

**comment-analyzer (advisory doc corrections)** — `config.ts:255/453/463`,
`review-output.ts:220`, `run-directory-handle.ts:10/22`, `update-task-status.ts:101`,
`no-cross-boundary-imports.ts:245/303`, `no-follow-fs.ts:389`, `subagent-result.ts:382`,
`transcript-adapter.ts:156`, `findings.ts:33/979`.

**code-simplifier** — replace the remaining `localeCompare` sorts and duplicated
`compareStrings` with `core/ordering`'s canonical helper in `remediation-machine.ts:63`,
`review-packet.ts:144`, `repository-path.ts:68`, `session-run-bindings.ts:198`,
`run-inspection.ts:173`.

## Validation commands

```bash
bun engine/src/cli.ts helper lint --all      # programmatic linter, full tier
cd engine && bunx tsc --noEmit               # typecheck
cd engine && bun test                        # full suite
```

## Remediation run

Registered `remediation` run against source review `run.raf20260819a`, with this plan file
declared in `supportPaths` (it is outside the frozen review scope).

---

## Validation evidence (recorded after implementation)

| Check | Baseline (HEAD) | After remediation |
|---|---|---|
| `bunx tsc --noEmit` + `--noUnusedLocals --noUnusedParameters` | clean | clean |
| `vitest run` | 186 files / 4750 tests passed | 186 files / **4754** tests passed |
| `smoke-panel-mode.sh` | pass | pass (22/22) |
| `smoke-review-panel.sh` | pass | pass (19/19) |
| `smoke-standalone-review.sh` | pass | pass |
| `smoke-orchestration-facades.ts` | pass | pass (6/6) |
| `smoke-pi-resources.sh` | pass | pass |
| programmatic linter (full tier, changed files) | 51 violations | **51 — byte-identical set, zero introduced** |

The 51 linter violations (`max-function-lines`, `no-nested-ternary`,
`exhaustive-discriminant-branching`) are pre-existing on `HEAD` in the same
files and lines; they were diffed against a `git archive HEAD` tree to prove
this remediation introduced none. They are outside the adjudicated finding set
and were not in scope to fix here.

Four new tests: two pinning `renderMarkdownForPi` / `packageRootBinding` as
`DomainResult` refusals rather than throws, one pinning the refusal `kind`, and
one covering the previously-unexercised schema-invalid branch of
`sweepExpiredPiWriteGrants` (advisory `pr-test-analyzer-1`).

## Support paths (outside the frozen review scope)

- `.claude/plans/2026-08-19-pr-remediation.md` — this plan
- `engine/src/core/frozen.ts` — new module holding the one definition of a
  runtime-immutable `ReadonlySet`, required by `type-design-analyzer-1` and `-4`
- `engine/tests/linter/programmatic/machine-purity.test.ts` — registers
  `core/frozen.ts` in the machine pure-core closure, which the self-lint test
  requires for any new module `core/tool-vocabulary.ts` imports
