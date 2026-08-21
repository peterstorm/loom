# PR Remediation — 2026-08-21

## Authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/raf-review-20260821T035002Z-01a02270`
- **Canonical result:** `.claude/reviews/review-and-fix-runs/raf-review-20260821T035002Z-01a02270/result.json`
- **Result digest:** `098a2e57fd678758f726e1ee86adbc407f20ef31c45cb165abc9abd775d486b1`
- **Exact frozen review scope:** the complete ordered 491-path `scope` array in the canonical result above. This remediation does not reconstruct or broaden that engine-owned scope.
- **Planned remediation touch set:**
  - `engine/src/orchestration/no-follow-fs.ts`
  - `engine/src/orchestration/harness-capture-runtime.ts`
  - `engine/src/handlers/subagent-stop/capture-orchestration-result.ts`
  - `engine/src/utils/agent-definition.ts`
  - `engine/src/state-manager.ts`
  - `engine/src/core/guard-state-file.ts`
  - `engine/src/core/shell-normalize.ts`
  - `engine/src/utils/agent-transcript-path.ts`
  - `engine/src/orchestration/dags/wave-gate-operations.ts`
  - `engine/src/config.ts`
  - `pi/extension.ts`
  - covering existing test files under `engine/tests/`
  - this plan file as a remediation support path

## Surviving Critical Findings — Mandatory

### `code-reviewer-1` — Darwin removal can escape its anchor

`removeRunFileNoFollow` opens the parent but Darwin later unlinks through the retained textual path. An ancestor swap can redirect deletion outside the Run Directory.

**Fix:** require descriptor-relative authority for removal. Linux continues through `/proc/self/fd`; Darwin fails closed with a path-qualified unsupported-safety error until a native `unlinkat` boundary exists. Update the contract prose and add platform-mechanism coverage.

### `code-reviewer-2` — lock release failure is swallowed

A non-`ENOENT` ownership read or unlink failure only reaches stderr, allowing the protected operation to report success while the live-owner lock remains.

**Fix:** make release throw a path-qualified error for every non-`ENOENT` failure. Preserve both operation and cleanup failures in an `AggregateError`. Add regressions for cleanup-only failure and dual failure.

### `silent-failure-hunter-1` — request-bound `no-reservation` is silent

When Run authority is present but the Claude native correlator is missing, capture returns `no-reservation`; the audit formatter emits nothing and the handler passes through.

**Fix:** audit `no-reservation` outcomes consistently and make the Claude request-bound handler return an error for both `rejected` and `no-reservation`. Keep truly unbound/global hooks inert via the existing `hasAnyRunAuthority` distinction. Add direct handler coverage.

### `silent-failure-hunter-2` — unreadable authoritative Agent definition falls through

`existsSync` collapses access errors into absence, allowing a lower-priority Agent definition to satisfy model/Skill policy.

**Fix:** replace candidate lookup with an `accessSync` probe where only `ENOENT` means absent and every other filesystem error throws with the candidate path. Add a deterministic `ELOOP` higher-priority regression.

### `type-design-analyzer-1` — `wave_review_epoch` crosses the State File boundary unparsed

`parseTaskGraph` spreads raw `wave_review_epoch` into `TaskGraph`, trusting malformed run, Wave, and digest values.

**Fix:** add a smart parser that requires the exact field set, parsed Orchestration Run id, positive integer Wave, and parsed artifact digest; freeze and install only the parsed value. When active Wave Gate authority is present, require exact run/Wave agreement. Add valid, malformed, unknown-field, and cross-authority regressions.

### `comment-analyzer-1` — global parameter-state views miss mixed states

`collapseVariants` emits four global choices, but separate default/alternate expansions can occupy different states. A real mixed-state guarded path can evade every global view.

**Fix:** derive bounded per-expansion matching variants through the shared shell normalizer, including nested revealed words. Over-approximate independent syntax occurrences fail-closed; return an unbounded marker above the cap so the guard blocks rather than truncates. Replace the inaccurate comment and pin the demonstrated mixed-state bypass plus a precision control.

## Advisory Dispositions

### Accepted

1. **`silent-failure-hunter-3` — transcript candidate `existsSync` diagnostics.** Sound fail-observable I/O issue and small in-scope fix. Probe candidates with `statSync`; only `ENOENT` is quiet, while other failures are logged before lookup continues. Apply consistently to transcript and adjacent metadata candidates.
2. **`pr-test-analyzer-1` — unreadable Pi global TaskGraph test.** Sound high-value regression for an existing fail-closed invariant. Add a real Pi extension `tool_call` test using an `ELOOP` State File and assert edit refusal.
3. **`type-design-analyzer-2` — prepared batch schema is wider than its type.** Sound illegal-state gap. Introduce a dedicated derived-only prepared-part schema and prove an undeliverable part cannot parse as `PreparedBatch`.
4. **`code-simplifier-1` — repeated Pi request-correlation lookup.** Sound local duplication with drift risk on evidence authority. Extract one local typed lookup while preserving each caller's existing diagnostics and side effects.
5. **`code-simplifier-3` — repeated overlap assertion mechanics.** Sound mechanical duplication. Extract one private `assertNoOverlap` helper while preserving exact exported predicates, signatures, and error text.

### Deferred

1. **`architecture-tech-lead-1` — move task completion rules from the SubagentStop shell to core.** The locality concern is valid, but moving this cross-harness seam changes module ownership and imports across a large, independently reviewable refactor. It is not required by a surviving correctness finding and should receive its own deepening design and parity/property-test migration.
2. **`architecture-tech-lead-2` — split `remediation-machine.ts`.** The module is broad, but splitting 78 exports into curated sub-domain volumes is a major Public Surface migration. Doing it inside security/correctness remediation would enlarge risk and obscure validation evidence; defer to a dedicated ADR-aware deepening change.

### Dismissed

1. **`code-simplifier-2` — split the entire Pi `tool_call` pipeline into guard stages.** The handler's ordering, rollback, and `currentGuard` attribution form one transactional shell. Extracting every stage would add pass-through seams and distribute rollback knowledge without evidence of divergent behavior. Targeted local extraction is preferable; no broad stage split will be made.

## Refuted Critical Finding Audit

The canonical result contains **zero** `refuted_critical_findings`. No critical Finding is excluded from remediation.

## Validation

Run targeted tests after each coherent move, then the complete gates:

```bash
cd engine
npm run test:unit -- tests/orchestration/no-follow-fs.test.ts
npm run test:unit -- tests/orchestration/orchestration-acceptance.test.ts
npm run test:unit -- tests/handlers/pre-tool-use/spawn-gates-fail-closed.test.ts
npm run test:unit -- tests/state-manager-load-guards.test.ts
npm run test:unit -- tests/handlers/pre-tool-use/guard-state-file.test.ts tests/core/shell-normalize.test.ts
npm run test:unit -- tests/utils/agent-transcript-path.test.ts
npm run test:unit -- tests/orchestration/fugue-operation-dags.test.ts
npm run test:unit -- tests/pi-extension-review-events.test.ts
npm run test:unit -- tests/panel-config.test.ts
npm run typecheck
npm run test:unit
npm test
```

After the green implementation baseline, run the required `distill` apply-mode pass one move at a time and re-run covering tests after each applied move.
