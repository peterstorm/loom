# G1: contracts before code — implementation plan

- **Branch:** `feat/g1-contracts-before-code`
- **Design:** vault `programming/plans/loom/g1-contracts-before-code-design.md` (D1–D6, user decisions Q1 expected-red, Q2 RED/GREEN + freeze, Q3 retro-pilot then one PR)
- **Precedent:** G5a (#82) — grammar in `core/parse-plan-models.ts`, checks in `validate-model-bindings.ts`, brief rendering.

## What ships

1. **Grammar.** `## Contracts` → `### CT-N: title` blocks with `**Types file:**` (path, or `none` + `**No types reason:**`),
   `**Acceptance tests:**` (`- path — FR-n, AS-n` lines), optional `**Supported domain:**` (one of the acceptance paths),
   and `**Statement:**`. Parsed to `PlanContract` with a `declared | malformed` declaration; strays cover near-miss
   headings, bad `CT-` headings and contract labels outside the section.
2. **Plan-binding validation** (populate, repair, validate-task-graph):
   - exactly one Task owns every path of a contract (the **contract task**); no other Task lists a frozen path;
   - every covered anchor is claimed (`spec_anchors`) by at least one other Task, and every claimant depends on the
     contract task, directly or transitively;
   - the contract task claims none of its covered anchors (its tests are red by design);
   - a path is frozen by at most one contract; the types file is never also an acceptance file;
   - the `covered-by-acceptance-contract` new-test waiver is admitted only on a Task that claims a covered anchor and
     depends on that contract's task;
   - a plan with contracts needs a verification manifest with a project check that writes a report (populate).
3. **TaskGraph `acceptance_contracts`**, stamped at population, parsed at load: contract id, statement, contract task,
   types file, acceptance files, covered anchors, and a freeze (`awaiting-red` → `frozen`), plus revision history.
4. **Per-testcase JUnit projection** in `core/structured-test-report.ts`: `{classname, name, outcome, failureType}`;
   a testcase whose name equals its classname is Vitest's synthetic collection-error case (probe A1).
5. **Wave Gate acceptance.** The completion result gains engine-observed `acceptance` facts (only the acceptance
   files' testcases, plus the count of other failures, bound to the report digest).
   `evaluateWaveCompletionSuite(authority, result, expectation)`:
   - **RED** in the contract task's Wave: every acceptance file yields ≥1 real (non-synthetic) testcase and every one
     fails; a non-zero exit is excused only when the acceptance testcases are the report's only failures;
   - **GREEN** in every later Wave: each frozen testcase is present and passed.
   The shell re-hashes frozen paths before accepting (`frozen-acceptance-drifted`) and stamps the freeze
   (hashes + red roster) in the same locked update that installs the accepted receipt.
6. **Contract Revision** — `helper revise-contract --contract CT-n --reason …`: operator-only, refused while a Wave
   Gate is active, before the freeze, or when a claimant sits in a completed Wave; re-stamps hashes, clears the roster
   (the next gate re-records it green) and returns completed claimants of the current Wave to
   `revalidation_required`.
7. **Brief.** New `{acceptance_contract}` variable: the contract task is told to write declarations-only types,
   dedicated acceptance tests that fail by assertion, and compiling stubs; a claimant sees the frozen paths, the
   testcases it must turn green, and that only a Contract Revision can change them.
8. **Docs.** `references/plan-template.md`, `references/executable-models.md`, `phase-architecture.md`,
   `phase-decompose.md` (rule 1 exception, rule 7 extension), `impl-agent-context.md`, `skills/code-implementer`,
   `CONTEXT.md` (Contract, Acceptance Freeze, Contract Revision), `docs/architecture.md`, vault notes.

## Deviations from the design note (recorded there too)

- **Freeze timing.** The design stamped the freeze when the contract task completes. It is stamped instead when the
  contract Wave's gate observes RED, in the same locked update as the accepted receipt: the frozen bytes are exactly
  the bytes observed red (both bound to one workspace digest), and the roster is known only then.
- **No `frozen-acceptance-intact` task obligation.** Task settlement already refuses any write outside the Task's
  file list (`task-byte-scope-violation`), and validation keeps frozen paths exclusive to the contract task, so a
  per-task hash obligation would duplicate it. Drift from outside any Task is caught where it matters: every later
  Wave Gate re-hashes the frozen paths.
- **D5 is a waiver reason with a checked precondition**, `covered-by-acceptance-contract`, not a new evidence kind:
  the obligation the waiver replaces is enforced by the GREEN gate.

## Known limits (documented in `executable-models.md`)

- A project check that runs more after its test runner (`tsc && vitest && lint`) skips the later steps at the
  contract gate when the runner exits non-zero; put the test runner in its own check or last.
- Acceptance observation needs a JUnit report (Vitest `--reporter=junit`, Surefire). Vitest JSON is refused for
  contracts with a named reason.
- v1 claims identity and RED→GREEN, not discrimination; mutation is G5b.
