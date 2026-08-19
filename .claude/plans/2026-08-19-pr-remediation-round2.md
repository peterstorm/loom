# PR Remediation — run.raf20260819b

- **Branch:** `feat/architecture-panel-mode-plan`
- **Base commit:** `a56b2f9`
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/run.raf20260819b`
- **Canonical result:** `run.raf20260819b/result.json` (digest `774d0d80…32b4b89`, 78128 bytes)
- **Scope:** frozen full-repository snapshot, 469 files (`kind: "all"`, no `--files`)
- **Reviewers:** 7 (`code-reviewer`, `silent-failure-hunter`, `pr-test-analyzer`,
  `type-design-analyzer`, `comment-analyzer`, `architecture-tech-lead` (+`deepen`),
  `code-simplifier` (+`distill`))
- **Refutation Panel:** 3 lenses (`reproduction`, `intent`, `security`), threshold 2

## Adjudication summary

| Metric | Count |
|---|---|
| Critical findings raised | 22 |
| Refuted by panel | 1 |
| **Surviving criticals (mandatory)** | **21** |
| Advisory findings | 49 |
| Advisories accepted | 44 |
| Advisories deferred | 3 |
| Advisories dismissed | 2 |

`code-reviewer-1` and `code-reviewer-2` are the same defect reported twice (the
machine-summary line and the `findings` JSON entry for one claim), so the 21
surviving criticals resolve to **20 distinct fixes**.

---

## Refuted critical (audited, never fixed)

### `comment-analyzer-14` — `engine/src/handler-routes.ts:63`

> The comment claims `PI_RUNTIME_HANDSHAKE_ROUTES` lists every CLI route that can
> mutate protected TaskGraph, lifecycle, or evidence state except deliberately
> excluded package-maintenance routes, but `helper/validate-task-graph`, whose
> `--fix` path mutates the same protected findings fields, is absent from the set
> and is not a maintenance route.

**Refuted 3/3 lenses.**

- **reproduction** — `engine/src/handlers/helpers/validate-task-graph.ts` imports
  only `existsSync, readFileSync` from `node:fs` (line 7), has no `StateManager`
  or write call anywhere, and its `--fix` path writes the repaired graph to
  `process.stdout` (line 726) and returns `passthrough`. Persistence requires
  piping into `populate-task-graph` or `repair-task-graph`, both of which ARE in
  `PI_RUNTIME_HANDSHAKE_ROUTES`. No execution of this route reproduces the
  claimed mutation.
- **intent** — the file itself documents `--fix` as "a pure transformation" that
  "returns the notes rather than writing them"; the sibling that actually
  installs a repaired graph through `StateManager` (`helper/repair-task-graph`)
  IS listed. The absence follows the set's stated criterion rather than
  contradicting it.
- **security** — the route cannot mutate TaskGraph/lifecycle/evidence state, so
  its absence from the handshake set is not a trust-boundary gap.

No change is made for this finding.

---

## Surviving criticals — mandatory fixes

### C1 · `code-reviewer-1` / `code-reviewer-2` — `pi/resources.ts:66`
`sourceFiles()` orders entries with `localeCompare` (both the `readdirSync` walk
at line 38 and the final sort at line 66); `resourceDigest()` hashes in that
order and the digest names the Pi resource cache directory, so the cache root is
locale/ICU-collation dependent instead of content-addressed.
**Fix:** import `compareStrings` from `engine/src/core/ordering` — the module
that exists precisely to keep digest inputs locale-independent — and use it for
both sorts.

### C2 · `type-design-analyzer-1` — `engine/src/core/orchestration-contract/publication.ts:63`
`parseContextReference` never asserts `slot.path === contexts/${digest}.json`;
the check is duplicated at `actions.ts:183` and `publication.ts:224`.
**Fix:** move the content-addressing check into `parseContextReference` (field
`context.slot`) and delete both duplicates. Callers already prefix the returned
field, so diagnostics keep their existing shape.

### C3 · `type-design-analyzer-2` — `engine/src/core/validate-task-execution.ts:84`
Only task-level critical review findings are counted toward the `BLOCKED due to:`
message, so a wave blocked purely by a critical spec-check prints the header with
nothing under it — the exact empty-cause-set failure `wave-gate-model.ts`
documents.
**Fix:** export `waveBlockCauses(tasks, specCheck, wave)` from
`core/wave-gate-model.ts` returning both counts, re-implement `waveHasBlockCause`
on top of it, and have `taskExecutionDecision` enumerate from the same single
rule. Uses the same "substantive (non-blank) finding" filter in both directions.

### C4 · `type-design-analyzer-3` — `engine/src/orchestration/dags/remediation-operations.ts:190`
`branchEnvelopeSchema` / `decisionEnvelopeSchema` build from
`z.unknown().optional()` and force the static type with `as unknown as`, so
runtime validation is a no-op while `emitIntentNode`/`blockedNode`/`decideNode`
read `.kind`/`.paths`/`.digest`/`.reason` off the value.
**Fix:** wrap the real `stagedVerdictSchema` / `installationDecisionSchema` in the
envelope and switch the cast to `satisfies z.ZodType<…>` — the pattern
`panel-operations.ts` already documents having adopted for this exact defect.

### C5 · `type-design-analyzer-4` — `engine/src/orchestration/dags/standalone-review-operations.ts:70`
Same no-op envelope pattern for `scopeEnvelopeSchema`,
`scopeOutcomeEnvelopeSchema`, `routeEnvelopeSchema`, `routeOutcomeEnvelopeSchema`.
**Fix:** same transposition using `scopeClassificationSchema`,
`resolvedScopeSchema`, `aggregateSummarySchema`, `criticalRouteSchema`.

### C6 · `comment-analyzer-1` — `engine/src/core/panel-program.ts:1167`
`boundEntryForSlot`'s doc names itself the only sanctioned slot→entry crossing
and warns against `findIndex` + `!`, yet `parsePersistentArchitecturePanelEvent`
(2035) and `submitArchitectureJudgeResult` (2352) use exactly that pattern.
**Fix:** add `boundJudgeCriterion(authority, slotId)` mirroring the existing
`boundRefutationLens`, and route both sites through it so an unknown slot becomes
a `request-binding-mismatch` refusal instead of an `undefined` criterion.

### C7 · `comment-analyzer-2` — `engine/src/core/review-output.ts:504`
The doc claims a two-outcome union with "no third state"; `ReviewResolution` has
three variants, and the comment is attached to `BoundReviewEvidence`.
**Fix:** rewrite the doc onto `ReviewResolution` naming all three arms, give
`BoundReviewEvidence` its own doc. Combined with A-TD8 below (splitting the
`findings` arm) this leaves the doc and the type agreeing by construction.

### C8 · `comment-analyzer-3` — `engine/src/core/panel-contract.ts:26`
The header says the closed-vocabulary arrays are what the parsers validate
against, but `SENSITIVE_BOUNDARY_STATUSES` is referenced only by its own type
alias; validation uses an independently hardcoded regex.
**Fix:** derive the prefix matcher and the normalising `replace` from
`SENSITIVE_BOUNDARY_STATUSES`, making the claim true rather than editing it away.

### C9 · `comment-analyzer-4` — `engine/src/core/panel-contract.ts:486`
Claims the refutation-verdict parser is "in this module"; `parseRefutationVerdict`
lives in `review-panel.ts`, which the same file calls a sibling 80 lines earlier.
**Fix:** correct the wording to name the sibling module.

### C10 · `comment-analyzer-5` — `engine/src/core/legacy-archive.ts:271`
### C11 · `comment-analyzer-6` — `engine/src/core/legacy-archive.ts:327`
Both comments describe schema-v1 enforcement branches that are provably dead:
`versioned` is unconditionally `false` after the early return at line 195.
**Fix:** delete the dead code rather than the comments — remove the `versioned`
local, the unused `v1Fields`, the unreachable `schema_version`/`subject_id`
checks, the unreachable `trustedAuthority` block, the unreachable schema-v1
strictness check, and the now-unused `panelAuthority` parameter (no caller passes
it). What remains is the unversioned-historical parser the function's own header
says it is.

### C12 · `comment-analyzer-7` — `engine/src/core/validate-phase-order.ts:8`
Header claims the file re-exports `detectPhase`/`checkArtifacts` from the original
handler; this file defines both and `core/index.ts` re-exports them onward.
**Fix:** correct the header to state the actual direction.

### C13 · `comment-analyzer-8` — `engine/src/core/run-inspection.ts:105`
`null` is documented as "no program was ever registered" but
`deriveRunInspection` also maps an unrecognized registered `kind` to `null`.
**Fix:** replace `InspectableProgram | null` with a three-arm
`InspectedProgram` ADT (`registered` | `unregistered` | `unrecognized`) so the two
conditions are distinct in the type, render distinctly (`none registered` vs
`unrecognized program kind`), and produce distinct `deriveState` diagnostics.
Tests updated.

### C14 · `comment-analyzer-9` — `engine/src/core/orchestration-contract/publication.ts:569`
The JSDoc says the envelope check was consolidated into one classifier, but
`resolveRegisteredPublicationAuthority` still hand-duplicates it as a fourth copy.
**Fix:** route it through `readResultEnvelope`, reproducing its field-less
success-shape diagnostic exactly as the registration loader does. (Also closes
advisory `code-simplifier-2`.)

### C15 · `comment-analyzer-10` — `engine/src/handlers/helpers/orchestration.ts:922`
The "Resume is idempotent…" JSDoc sits on `reconcileCapturedPanelResults`;
`resumeOperation` has none.
**Fix:** move it to `resumeOperation` and give `reconcileCapturedPanelResults` a
doc describing what it actually does.

### C16 · `comment-analyzer-11` — `engine/src/handlers/pre-tool-use/block-direct-edits.ts:3`
Header says subagent Edit/Write is allowed unqualified; only implementation-role
or write-grant-authorized agents get it — review and verifier subagents stay
blocked.
**Fix:** qualify the header to match `core/block-direct-edits.ts`'s stated policy.

### C17 · `comment-analyzer-12` — `engine/src/linter/index.ts:52`
The five-`@param` JSDoc for `lintFile` sits above `lintLoadedFile` (three params).
**Fix:** move it to `lintFile`.

### C18 · `comment-analyzer-13` — `engine/src/linter/programmatic/no-cross-boundary-imports.ts:212`
The "Extracts import specifiers…" JSDoc sits above `isPlausibleSpecifier`.
**Fix:** move it to `extractImports`.

### C19 · `comment-analyzer-15` — `pi/extension.ts:175`
The "Task text is deliberately excluded" identity doc sits on `piSpawnItem`,
which returns the raw entry including its task text.
**Fix:** move it to `piSpawnRosterId` and give `piSpawnItem` its own doc.

### C20 · `code-simplifier-1` — `engine/src/core/guard-state-file.ts:668`
`findClosingParen` omits backtick from its quote alphabet, unlike the twin
scanners `hasOutputRedirect` (same file) and `stripComment`
(`engine/src/machine/extract-evidence.ts`). For `` $(`a)b`) `` the `)` inside the
backtick body closes the outer substitution early, so the command guard analyses
a truncated body. Security-lens verifier confirmed this is not fail-closed at
every use site: `openerLineGroups` and the heredoc opener scan resume at
`close + 1` inside a still-live substitution rather than returning `-1`.
**Fix:** extract one shared quote-aware scanner — `scanUnquoted` in a new
`engine/src/core/shell-quoting.ts` — carrying the alphabet (`"`, `'`, `` ` ``) and
the escape rule once, and rewrite all three call sites on top of it. Add a
regression test pinning the backtick-inside-`$(...)` case.

---

## Advisory dispositions

### Accepted (45)

**Comment accuracy (12)** — `comment-analyzer-16 … 27`. Each is a one-line
correction to a doc that misstates its own code; all are in-scope and cheap.
`comment-analyzer-16` (fifth `isExcludedRemediationPath` call site),
`-17` (`jsonEqual` scope), `-18` (`waveHasBlockCause` omits the
`EVIDENCE_CAPTURE_FAILED` condition), `-19` (`isWriteAuthorizedAgent` omits the
`IMPL_AGENTS` admission path), `-20` (wrong `python3 --file` example),
`-21` (`hasFindingsBlock` doc restates the name — removed), `-22` (`absent` is
not reported as degraded), `-23` (`parseLegacyFindings` fallback second trigger),
`-24` ("all five callers" — there are four), `-25` (roster write-access
qualification), `-26` (false `notspec.md` example), `-27` (`optionalString` also
returns null for a present-but-invalid value).

**Type design (8)**
- `type-design-analyzer-8` — split `ReviewResolution`'s `findings` arm into
  `findings` and `bound-findings` variants so exhaustiveness is compiler-enforced
  instead of a remembered `bound === undefined` check. Pairs with C7.
- `type-design-analyzer-10` — `PanelOperationSpec.aggregate`'s second parameter
  typed `never` is satisfied contravariantly and erases the check it appears to
  give; type it as the real roster shape.
- `type-design-analyzer-11` — replace `runThroughPort`'s `"__failed"` string-key
  sentinel with a module-private class a port payload cannot forge.
- `type-design-analyzer-12` — replace `as string | undefined` casts in
  `validate-agent-model.ts` with a runtime `typeof` read.
- `type-design-analyzer-13` — narrow `ReservedResultItem.kind` to the closed
  union every construction site already supplies.
- `type-design-analyzer-15` — make `TestCount`'s fields `readonly`.

**Architecture (1)**
- `architecture-tech-lead-1` — extract Wave Gate decision-authority matching out
  of `decideOperation` into a named pure predicate in
  `handlers/helpers/programs/wave-gate.ts`, next to `waveGateAuthorityDigest`, so
  each mismatch dimension (runId / wave / authorityDigest / decisionId) becomes
  independently unit-testable instead of CLI-process-only.

**Simplification — production (15)** — `code-simplifier-2 … 16`. Reuse-before-
rewrite and the project's one-level ternary ceiling. `-2` is closed by C14.
`-3` route both authority comparators through the existing `sameHarnessBinding`.
`-4`/`-5` hoist duplicated closures. `-6`/`-14`/`-15`/`-16` flatten nested
ternaries. `-7`/`-8`/`-9` reuse the existing `facadeEffectRunner` and extract the
duplicated `appendEvent` shapes. `-10` table-drive `extractTestEvidence`'s five
copies of one rule. `-11` extract `claimIdempotentWrite`. `-12` extract
`exactFieldsError`. `-13` extract the shared candidate-directory search.

**Simplification — tests (10)** — `code-simplifier-17 … 26`. Deduplicate fixtures
and setup blocks; `-26` in particular restores `mkdtempSync` where a second temp
dir regressed to the `Date.now()`-only naming the same file's helper rejects.

### Deferred (3)

- `type-design-analyzer-5` — `Finding.review_generation` / `review_packet_id`
  independently optional despite being a documented biconditional.
- `type-design-analyzer-6` — `Task.critical_findings` / `advisory_findings` as
  separately-optional derived views over `Task.findings`.
- `type-design-analyzer-7` — `Task.id` is a bare `string` rather than a branded,
  parser-constructed identifier.

**Reason (all three):** each is a change to the schema root (`engine/src/types.ts`)
that ripples through every writer, parser, and persisted JSON artifact in the
repository. The review surfaced no defect any of them currently causes — the
invariants are enforced at runtime today by the six-writer findings-lockstep
proof and the load-boundary re-proofs, both of which the reviewers separately
confirmed accurate. Folding a schema-root migration into this remediation would
put changes far outside the adjudicated findings into the same verified index.
Each warrants its own change with its own review.

### Dismissed (2)

- `type-design-analyzer-14` — `Violation.file` is documented as an absolute path
  but nothing enforces it.

**Reason (re-dispositioned during implementation):** initially accepted, and the
absoluteness check was written into `makeViolation`. It failed 36 tests across 7
files, and the failures were correct: the linter's rule handlers are legitimately
invoked with REPO-RELATIVE paths, and the boundary rules
(`no-cross-boundary-imports`, `no-io-in-pure-modules`) match module ownership on
repo-relative prefixes. Only `lintFile`/`lintFiles` `resolve()` before executing
rules, so "absolute" describes those two entry points, not the type. Enforcing it
at the constructor would have changed the contract for direct handler callers,
which the repo's own suite exercises as supported usage. The claim describes an
inaccurate comment, not an unenforced invariant — so the comment was corrected to
state what actually holds, and no check was added.

- `type-design-analyzer-9` — `FinalPayload.bytes: readonly number[]` should be
  `Uint8Array` or base64.

**Reason:** `readonly number[]` is this repository's uniform representation for
bytes that cross the JSON boundary — `context-packets.ts:82,177`,
`remediation-machine.ts:1593`, `standalone-review.ts:964`, and
`programs/helpers.ts:339` all produce and re-parse the same shape, and every
consumer reconstitutes it with `Uint8Array.from(...)` at the point of use. The
payload is serialized into run-directory capture records; switching one member to
a typed array would break JSON round-tripping for existing run directories and
make `FinalPayload` the only inconsistent member of that convention. The claim
describes a repo-wide serialization convention, not a defect in this type.

---

## Validation commands

```bash
bun run typecheck          # engine + pi
bun test                   # full engine test suite
```

Both must pass before any staging. Remediation is installed only through the
registered remediation program's verified temporary index.

## Remediation run

Fresh remediation Run Directory under
`.claude/reviews/review-and-fix-runs`, with `sourceRun: run.raf20260819b`.

`supportPaths` — every path this remediation created that the frozen review
scope does not contain:

- `.claude/plans/2026-08-19-pr-remediation-round2.md` (this file)
- `engine/src/core/shell-quoting.ts` (shared scanner extracted for C20)
- `engine/tests/handlers/helpers/programs/wave-gate-decision-authority.test.ts`
  (unit tests for the predicate extracted for `architecture-tech-lead-1`)
- `engine/tests/fixtures/git-repository.ts` (shared Git fixture, `code-simplifier-20`)
- `engine/tests/fixtures/agent-request-authority.ts` (shared authority builder,
  `code-simplifier-21`)
