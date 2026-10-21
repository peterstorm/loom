# Plan: G5b — owner-map enforcement and matrix-test discipline (sibling coverage + bespoke mutation verification at the Wave Gate, plan mutation-exemption grammar, second-copy reviewer lens via engine-issued Context Packet section, family-site metric)

**Spec:** .claude/specs/2026-10-21-g5b-owner-enforcement/spec.md
**Created:** 2026-10-21

## Summary

G5b turns G5a's ownership declarations into Wave Gate obligations. Population stamps every owned Invariant into the TaskGraph as an **Owner Obligation**. When a Wave changes an owned family, the completion suite runs a new engine-reserved check, `loom:owner-verification`. The check has two parts:

- **Sibling coverage.** A pure import-graph decision: the matrix test's imports, closed under re-exports, must reach the owner and every declared sibling.
- **Mutation verification.** A deterministic mutation plan is built over the owner's lines changed in the Wave, using the TypeScript compiler API. Each mutant runs through the frozen `affectedRunner` in a detached git worktree, and its JUnit report decides killed, survived, invalid or timed out.

The per-Invariant verdict rides in the completion-suite result and receipt. It blocks the gate through the existing `checkWaveCompletionSuite`, and status projects it.

Code-reviewer and architecture-tech-lead packets gain an engine-issued owner-map section with the second-copy rule. A pure `family-sites` metric with an in-repo baseline makes single-homing measurable.

Approach: **B — a new engine check kind in the completion suite** (chosen at the approach gate, as recommended).

---

## Architectural Decisions

### AD-1: Owner verification is an engine-reserved completion-suite check (approach B)

**Choice:** Add a third variant, `engine-owner-verification`, to `AuthorizedWaveCompletionCheck` in `engine/src/core/completion-suite.ts`, beside `engine-full-tier-lint`:

```
{ kind: "engine-owner-verification"; checkId: "loom:owner-verification"; scope: "wave"; reportPolicy: { kind: "not-required" }; obligationsDigest: ArtifactDigest }
```

- `authorizeWaveCompletionSuite` (`verification-manifest.ts`) injects the check only when the Wave owes owner verification. That means the graph carries `owner_obligations` and at least one obligation's family was changed by the Wave's Tasks (AD-4).
- `WaveCompletionSuiteResult` and `AcceptedWaveCompletionReceipt` gain an optional `ownerVerification: OwnerVerificationObservation`, mirroring `acceptance?: AcceptanceObservation`.
- `CompletionSemanticFailure` gains `owner-verification-rejected` (carrying `NonEmpty<OwnerVerificationFailure>`). `CompletionInfrastructureFailure` gains `owner-verification-infrastructure`.
- The check is part of the suite digest, so receipt reuse, workspace-digest binding, replay and status all come for free. `checkWaveCompletionSuite` in `complete-wave-gate` blocks on it unchanged.

**Why:**
- The completion suite already runs outside the StateManager lock and installs a digest-bound receipt inside it. It is harness-agnostic: Claude Code's and Pi's Wave Gates both reach `ensureWaveCompletionSuite` through `programs/wave-gate.ts` (NFR-002).
- Acceptance Contracts proved that the result/receipt carries a rich typed observation.

**Rejected:**
- A dedicated gate stage (A): a second receipt and digest scheme that duplicates suite authority, plus a new program step for both harnesses to sequence.
- Inline in `complete-wave-gate` (C): minutes of mutant runs under the protected-state lock, or a TOCTOU window between check and commit.

### AD-2: Owner Obligations are stamped at population; the gate re-reads the plan and fails closed on drift (interview Q2a)

**Choice:**
- `populate-task-graph` stamps `owner_obligations: readonly OwnerObligation[]` on every graph it populates, including an empty array when the plan declares no owned Invariant. It is derived purely by `obligationsFromPlan(models)`.
- An **absent** field means the graph was populated before G5b, and it owes nothing (FR-004). Re-population replaces the field, like `acceptance_contracts`.
- At the gate, the shell re-reads `graph.plan_file` (`loadPlanModelsSource`) and re-derives the obligations. Any of the following blocks as `owner-verification-infrastructure` and never skips: an unreadable plan, a plan with model strays or malformed ownership, or a set of obligations that is not canonically equal to the stamp (FR-002).

```
OwnerObligation = Readonly<{
  invariant: string;            // "INV-3"
  title: string;
  statement: string | null;
  owner: string;
  siblings: readonly SiblingEntryPoint[];
  matrixTest: string;
  mutation: MutationPolicy;     // { kind: "verify" } | { kind: "exempt"; reason: NonEmptyText }
}>
```

**Why:** Pure selection everywhere, from the gate, the review packets and the brief alike, because the stamp is data in the graph. The plan re-read keeps FR-002's "read from the plan the TaskGraph names". An always-present stamp separates "pre-feature" from "no owned Invariants" without a second marker.

**Rejected:**
- Re-parse only, plus a schema marker: every reader needs I/O.
- Stamping only non-empty obligations: absence would become ambiguous, so plan drift would go unchecked.

### AD-3: Exemption grammar — one field, two new problems (interview Q4a)

**Choice:**
- An owned Invariant may carry the label `Mutation exemption` in the usual bold-colon form, followed by a reason.
- `parseOwnership` reads it into `owned.mutation`:
  - absent: `{ kind: "verify" }`
  - non-blank: `{ kind: "exempt"; reason }`
  - present but blank or whitespace: malformed, with `{ kind: "exemption-without-reason" }`
- On an `Owner module: none` block it is malformed, with `{ kind: "exemption-on-unowned" }`.
- The label joins the parser's model-label list, so a misplaced one outside `## Invariants` is a stray.
- `renderOwnershipProblem` in `validate-model-bindings.ts` renders both new kinds. Populate, repair and validate therefore refuse them with no new call site (FR-019).
- Plans without the field produce byte-identical `PlanModels` except for the new `mutation: { kind: "verify" }` member (FR-021).

**Why:** The field reuses G5a's three-state `InvariantOwnership`. A malformed declaration names every problem, and none of them is ever a silent opt-out.

**Rejected:**
- A two-field `Mutation:` plus `Exemption reason:` pair adds a state (exempt without a reason line) that the grammar would have to refuse.

### AD-4: Family scope keeps G5a's `changesFamily`; selection has one owner (interview Q1d; INV-3)

**Choice:** `engine/src/core/owner-verification/obligations.ts` is the sole home of three selections:

- `waveChangedObligations(waveTasks, obligations)` decides the gate's scope. It is true for an obligation when any Wave Task's `file_list` satisfies `changesFamily(invariantRoles(...))`, meaning the owner or a sibling. A change to the matrix test alone does not trigger the checks.
- `obligationsTouchedBy(fileList, obligations)` decides review packets and brief duties. It is true when the Task plays any role: owner, sibling or matrix test.
- `ownerVerificationOwed(graph, wave)` is the predicate used by suite authorization and suite readiness.

**Why:** G5a's validator, the brief and the gate already classify roles through `plan-paths.ts`. G5b adds selections over obligations, and they must not drift between the gate, readiness, packets and the brief.

**Spec amendment:** The spec glossary defines "Family change" as including the matrix test. That is wrong against G5a's `changesFamily` and this decision. T12 corrects the glossary entry to "owner or a sibling entry point". No FR or AS changes.

### AD-5: Sibling coverage = direct imports closed under re-exports, resolved to files (FR-005..FR-007)

**Choice:**
- `import-graph.ts` (TS compiler API seam, INV-1) exports `moduleEdges(path, text): { imports; reexports }`. It parses with `ts.createSourceFile` and collects:
  - static `import … from`, side-effect `import "…"` and `import x = require("…")`
  - string-literal `import("…")` and `require("…")`
  - `export … from` (a re-export)
- `coverage.ts` resolves specifiers purely against a shell-supplied file set and the matrix test's tsconfig `baseUrl`/`paths`:
  - relative specifiers try the extension ladder `""`, `.ts`, `.tsx`, `.mts`, `.cts`, `.js→.ts`, `/index.ts`
  - aliases follow TypeScript's `paths` matching with a single `*`
  - bare package specifiers are external and never reach anything
- **Reached** = the files the matrix test imports directly, closed under re-export edges only.
- `decideCoverage(reached, obligation)` returns `{ kind: "covered" }` or `{ kind: "missing"; paths: NonEmpty<string> }`, with paths in declared order and the owner first.
- The shell gathers files with a pure frontier step, `coverageFrontier(state, readFiles)`, bounded at 512 files. Exceeding the bound is an infrastructure failure.

**Why:** AS-006 names re-exports, relative paths and aliases, but not arbitrary transitive imports. A full transitive closure would make the owner "reached" through any sibling (siblings import the owner), which would empty AS-003's owner requirement. Only an import is proof of reach, not of exercise; T12 documents that limit (AS-035).

**Rejected:**
- Regex specifier scanning: comments and strings defeat it, and that is a second tokenizer.
- `ts.resolveModuleName` with a host: I/O in the core.

### AD-6: Deterministic mutation plan over changed owner lines (FR-009..FR-012, FR-017; interview Q3b)

**Choice:** `mutation-plan.ts` (TS compiler API seam, INV-1) exports:

```
mutationPlan(input: { ownerPath: string; ownerText: string; changedLines: ReadonlySet<number>; cap: MutantCap }): MutationPlan
```

- It parses the owner with `ts.createSourceFile(…, ScriptTarget.Latest, true, ScriptKind.TS)` and walks it in pre-order. A node is a candidate when its first token starts on a changed line (1-based).
- Fixed operators, in this order:
  1. `condition-negation`: the condition of `if`, `while`, `do`, `for` and `?:` becomes `!(…)`.
  2. `comparison-flip`: `<`↔`>=`, `>`↔`<=`, `===`↔`!==`, `==`↔`!=`.
  3. `logical-swap`: `&&`↔`||`.
  4. `boolean-literal-flip`: `true`↔`false`.
  5. `return-value-replacement`: `return e` becomes `return undefined`, for non-empty returns not already the literal `undefined`.
  6. `statement-removal`: an `ExpressionStatement` becomes `;`, excluding prologue directives.
- Candidates sort by `(start, operator order)`. When there are more than the cap, the selection is the evenly spaced indices `floor(i * n / cap)` for `i < cap`.
- Each `Mutant` carries `{ id, operator, line, column, start, end, original, replacement }`, where `id = sha256(ownerPath, start, end, operator)`. `unmutated = n - selected`.
- Engine constants: `MUTANT_CAP_PER_INVARIANT = 24` and `MUTANT_TIMEOUT_MS = 60_000`, clamped to at most the frozen `affectedRunner.timeoutMs`.
- The reported bound is `Σ owed non-exempt obligations × (1 baseline + selected) × per-mutant limit` (NFR-004).
- The changed lines come from a new pure `changedHeadLines(base, head)` exported by `core/unified-diff.ts`, the module's own edit script. `base` is the owner's bytes at the **Wave base**: the `start_sha` of the Wave Tasks whose `file_list` includes the owner, or their `git merge-base --octopus` when several do. A null base (new file) marks every line changed.
- When no Wave Task lists the owner, its changed-line set is empty. Zero mutants are generated, and the verdict says `owner unchanged in Wave` (AS-014).
- A missing `start_sha` on an owner Task is an infrastructure failure.

**Why:** It is deterministic for the same owner bytes, changed lines and cap (SC-003), uses no new dependency (NFR-003), and every choice is engine-fixed.

**Rejected:**
- StrykerJS (OOS-002).
- Random sampling: not deterministic.
- First-N selection: it clusters mutants at the top of the file.

### AD-7: Outcome classification reads only the structured report (FR-013, FR-016)

**Choice:** `outcome.ts` exports `classifyMutantRun(observation, matrixTest)` and `classifyBaseline(observation, matrixTest)`. Testcases are attributed to the matrix test through `attributeReportedFile` (`report-file-attribution.ts`), and collection errors are recognized by `isCollectionErrorTestcase`.

| Observation | Mutant | Baseline |
|---|---|---|
| process timed out | `timed-out` (counts as killed) | infrastructure `baseline-timed-out` |
| spawn failed, report missing or unreadable, report unparseable | infrastructure (never a kill) | infrastructure |
| ≥1 attributed failing non-collection testcase | `killed` | `red` (AS-008) |
| failures exist and every one is a collection/import error | `invalid` | `red` |
| zero attributed testcases | infrastructure `matrix-test-not-collected` | infrastructure |
| all attributed testcases pass, exit 0 | `survived` | `green` |
| all pass but non-zero exit or signal | infrastructure `exit-unexplained-by-report` | same |

`verdict.ts` assembles one `InvariantVerdict` per owed obligation. `ownerVerificationFailures(observation)` lists the blocking failures purely: missing siblings, red baseline, every survivor (unless exempt) and every infrastructure failure. A survivor diagnostic carries the Invariant, owner file, line, operator, original text and mutated text (AS-011).

**Why:** Kill and survival are read, never inferred from exit codes (FR-013). Every ambiguous case fails closed as infrastructure (FR-016; interview Q3d).

**Rejected:**
- Exit-code classification: a crash looks like a kill.

### AD-8: Isolation — one detached worktree per Invariant, with the real workspace digested before and after (FR-015; interview Q2c, Q2d)

**Choice:** The new shell `orchestration/owner-mutation-workspace.ts` creates the isolated workspace:

- `git worktree add --detach <mkdtemp> HEAD`.
- It overlays every path in the reviewed workspace that differs from HEAD: changed, untracked-not-ignored and deleted paths, taken from `git status --porcelain=v2 -z --untracked-files=all`.
- It symlinks the repository root's `node_modules` and the runner cwd's `node_modules` read-only, without copying them.
- Per mutant, it rewrites only the owner file in the worktree, deletes the runner's report path, runs, and then restores the original owner bytes.
- `git worktree remove --force` plus `git worktree prune` run in `finally`.

The real workspace digest (`observeCurrentWaveWorkspace`) is taken before the first worktree and after the last. Any difference is the blocking infrastructure failure `real-workspace-changed` (SC-004).

`orchestration/owner-verification-runner.ts` runs the baseline and then each mutant through the frozen manifest's `affectedRunner`:

- The command is formed by `affectedRunnerCheck` with `{files}` set to the validated repo-relative matrix test only.
- It runs through the process-group runner in `completion-check-runner.ts`, exported in a form that takes the worktree root.
- No command text ever comes from the plan.

A Wave that owes non-exempt owner verification with no frozen `affectedRunner` blocks as infrastructure. Population also refuses such a plan up front (`owner-verification-runner-missing`, beside the contract JUnit refusal).

**Why:**
- A worktree shares the object store, so it is cheap and exact.
- One worktree per Invariant amortizes setup across the cap.
- Reusing the existing frozen runner means no manifest change (interview Q3a).

**Rejected:**
- A full `cp -r`: slow, and it copies `node_modules`.
- A tmpdir of tracked files only: it loses the uncommitted Wave work.
- A new `mutationRunner` manifest key: a schema change for no gain.

### AD-9: The second-copy lens is an engine-issued packet section (FR-022..FR-026; OOS-009)

**Choice:** `core/owner-verification/owner-map.ts` exports `renderOwnerMapSection(planFile, obligations)`. For each obligation it lists the id, title, owner, siblings with notes, matrix test and statement, followed by the fixed **second-copy rule** text:

- A diff that implements a declared-owned invariant's predicate outside its owner module is a finding citing `<plan file>#INV-N` as the violated contract.
- It is critical when the copy diverges from the owner on some input, and the diverging input is the consequence.
- It is advisory when the copy is behaviorally identical.
- The existing severity rules and the Refutation Panel apply unchanged.

`wave-review-authority.ts` appends the section as a fixed section, so it is inside the packet digest (FR-023), only under all of these conditions:

- `registration.schemaVersion === 2`
- `subject.taskId !== null`
- `subject.role` is `code-reviewer` or `architecture-tech-lead`
- `graph.owner_obligations` is defined
- `obligationsTouchedBy(task.file_list)` is non-empty

Every other packet is byte-identical (AS-024, AS-026, AS-027; SC-005). Standalone review never sees a TaskGraph, so it is untouched by construction.

**Why:** Reviewer shims load frozen archived guidance (`references/reviewer-protocol-v2/agents/*.md`, off-limits), so the obligation must arrive in the packet. `REVIEWER_IMPACT_RUBRIC_V1` already admits explicit project obligations as a critical basis, so no rubric change is needed.

### AD-10: Brief duties and status projection (FR-027, FR-028; interview Q3c)

**Choice:**

- **Brief.** `core/implementation-brief.ts`'s ownership section gains a duty paragraph per Invariant the Task touches. The paragraph says the matrix test must import the owner and every sibling (named), and that the owner's lines changed in the Wave will be mutation-verified by the fixed operator set against the matrix test, or it names the declared exemption and its reason. The paragraph is rendered only when the graph carries `owner_obligations`, so pre-feature graphs get no false duty. `orchestration/implementation-brief.ts` passes that fact through.
- **Status.** `core/owner-verification/status.ts` projects the latest persisted completion result's `ownerVerification` into one `OwnerVerificationStatus[]`, one per Invariant, carrying:
  - coverage `pass` or the missing paths
  - the counts generated, killed, timed out, invalid, survived and unmutated, or the exemption, or the infrastructure failure
  - the bound

  `loom-status.ts` renders human output and `--json` from that one projection. When the suite rejected the Wave for owner verification, the next action names the Invariant and the remedy: "strengthen `<matrix test>` to import `<missing>`", or "strengthen `<matrix test>` to kill the survivor at `<file>:<line>` (`<operator>`), or declare a mutation exemption with a reason on INV-N".
- No new log channel (Q3c).

### AD-11: Family-site metric — one pure module, an in-repo baseline (FR-029..FR-031; interview Q4b)

**Choice:** `core/family-sites.ts` holds the `FAMILIES` table and pure functions:

- `scanFamilySites(files: readonly { path; text }[]) → FamilySiteReport`, with sorted per-family `{ family, owners, count, sites: "path:line"[] }`
- `familySiteDelta(report, baseline)`
- `renderFamilySites`

The `FAMILIES` table:

| Family | Owners | Raw-site patterns (initial; T3 calibrates against the known second copies and records the final ones only here) |
|---|---|---|
| `fail-closed-path-probes` | `engine/src/utils/path-presence.ts` | `\bexistsSync\(`; `["']ENOENT["']` |
| `shell-tokenizing` | `engine/src/core/shell-quoting.ts`, `shell-command.ts`, `shell-normalize.ts`, `shell-substitution.ts`, `shell-write-targets.ts`, `shell-ansi-c.ts` | whitespace-split of command text (`\.split\(\s*/\\s\+/`); hand-rolled quote-state tokenizing |
| `claim-conservation` | `engine/src/core/findings.ts` | hand-derived `critical_findings`/`advisory_findings` views and multiset claim removal outside the owner |

The scan covers `engine/src/**/*.ts` minus test files (`isTestFile`) and minus each family's owners. It is sorted by path and then line, so it is byte-identical for the same bytes (AS-032).

The shell `helper family-sites [--json] [--baseline <file>] [--root <dir>]` reads files and prints.

**Baseline.** T3 records `docs/family-sites.baseline.json` by running the helper with `--root` against a detached worktree of the feature's base commit `626db7fb` (the `main` merge this branch starts from). The base therefore stays exact even after later Waves add files. T12 cites the counts in the docs (AS-034, SC-007).

### AD-12: The TypeScript compiler API enters through two pure seams (INV-1; deviation from interview Q4d)

**Choice:** INV-1 confines `typescript` imports to `mutation-plan.ts` **and** `import-graph.ts`.

**Deviation:** The interview answer named `mutation-plan.ts` alone. Sibling coverage (AD-5) needs real specifier parsing, including re-exports and dynamic imports. The alternatives were a regex tokenizer, which would be a second copy, or putting import parsing inside the mutation module. Both are worse than a second named seam. Both seams parse already-read text only: no `ts.sys`, no Program, no language service.

`typescript` stays in `engine/package.json` `devDependencies`. It is installed by the documented `bun install --frozen-lockfile`, exactly like `ts-pattern`, which 59 engine modules import at runtime. No new dependency (NFR-003). T12 states this in the operations docs.

### AD-13: The pure core is enforced by the purity linter, not a project regex rule (INV-2; deviation from interview Q4d)

**Choice:** T4 adds the directory entry `engine/src/core/owner-verification/` to `DEFAULT_PURE_MODULES` (`no-io-in-pure-modules.ts` supports trailing-slash directory patterns). That bans `child_process`, `fs`, the clock, randomness and `process.*` in every core file of the package at the full-tier lint the Wave Gate runs. T3 adds `engine/src/core/family-sites.ts` the same way.

**Deviation:** The interview asked for a checkable regex INV. Project regex rules match line text and support only file-suffix excludes, so they cannot be scoped to a directory. A repo-wide "no `child_process`" regex would be false. Per policy, INV-2 is therefore tiered `advisory` in the plan grammar, and its real enforcement is the programmatic purity rule.

---

## File Structure

### Contract CT-1 (T1, Wave 1)

```
engine/src/core/owner-verification/types.ts                       — NEW, declarations only: OwnerObligation, MutationPolicy, MutationOperator, Mutant, MutationPlan, MutantCap, MutantOutcome, BaselineOutcome, CoverageVerdict, MutationVerdict, InvariantVerdict, OwnerVerificationObservation, OwnerVerificationFailure, OwnerInfrastructureFailure, and the function-type aliases of the core entry points
engine/src/core/owner-verification/coverage.ts                    — NEW compiling stub (throws "not implemented"); T5 implements
engine/src/core/owner-verification/mutation-plan.ts               — NEW compiling stub; T6 implements
engine/src/core/owner-verification/outcome.ts                     — NEW compiling stub; T6 implements
engine/tests/acceptance/owner-verification-core.acceptance.test.ts — NEW
engine/tests/acceptance/mutation-exemption.acceptance.test.ts     — NEW
engine/tests/acceptance/owner-verification-gate.acceptance.test.ts — NEW
engine/tests/fixtures/owner-verification-repo.ts                  — NEW fixture builder: temp git repo with owner, siblings, re-export barrel, path alias, matrix tests (discriminating, vacuous, sibling-omitting), a fake affectedRunner script writing JUnit
```

### Contract CT-2 (T2, Wave 1)

```
engine/tests/acceptance/owner-map-packet.acceptance.test.ts        — NEW
engine/tests/acceptance/owner-verification-status.acceptance.test.ts — NEW
```

### Family-site metric (T3, Wave 1)

```
engine/src/core/family-sites.ts                          — NEW pure: FAMILIES table, scan, delta, render
engine/src/handlers/helpers/family-sites.ts              — NEW shell: helper family-sites [--json] [--baseline] [--root]
engine/src/handler-routes.ts                             — register the read-only helper
engine/src/linter/programmatic/no-io-in-pure-modules.ts  — list engine/src/core/family-sites.ts
docs/family-sites.baseline.json                          — NEW baseline at base commit 626db7fb
engine/tests/core/family-sites.test.ts                   — NEW unit + determinism property
engine/tests/handlers/family-sites.test.ts               — NEW helper: JSON, human, --baseline delta, --root
```

### Plan grammar and obligations (T4, Wave 2)

```
engine/src/types.ts                                      — OwnershipProblem += exemption-without-reason | exemption-on-unowned; owned ownership += mutation: MutationPolicy; TaskGraph += owner_obligations?: readonly OwnerObligation[] (re-exported from core/owner-verification/types.ts)
engine/src/core/parse-plan-models.ts                     — parse the Mutation exemption label; add it to the misplaced-label list
engine/src/handlers/helpers/validate-model-bindings.ts   — renderOwnershipProblem for the two new kinds
engine/src/core/owner-verification/obligations.ts        — NEW pure (INV-3 owner): obligationsFromPlan, obligationsDigest, obligationsAgree, waveChangedObligations, obligationsTouchedBy, ownerVerificationOwed
engine/src/linter/programmatic/no-io-in-pure-modules.ts  — list engine/src/core/owner-verification/
engine/tests/core/parse-plan-models-exemption.test.ts    — NEW
engine/tests/core/owner-obligations.matrix.test.ts       — NEW (INV-3 matrix; owner rows)
```

### Sibling coverage core (T5, Wave 2)

```
engine/src/core/owner-verification/import-graph.ts       — NEW pure TS seam: moduleEdges
engine/src/core/owner-verification/coverage.ts           — implement: resolveSpecifier, coverageFrontier, reachedFiles, decideCoverage, coverageOverFiles
engine/tests/core/owner-verification-import-graph.test.ts — NEW
engine/tests/core/owner-verification-coverage.test.ts    — NEW incl. fast-check properties
```

### Mutation plan, outcome, verdict (T6, Wave 2)

```
engine/src/core/owner-verification/mutation-plan.ts      — implement (TS seam): mutationPlan, applyMutant, constants
engine/src/core/owner-verification/outcome.ts            — implement: classifyMutantRun, classifyBaseline
engine/src/core/owner-verification/verdict.ts            — NEW pure: invariantVerdict, ownerVerificationFailures, mutationBoundMs, renderOwnerVerificationFailure
engine/src/core/unified-diff.ts                          — export changedHeadLines(base, head)
engine/tests/core/owner-verification-mutation-plan.test.ts — NEW incl. fast-check properties
engine/tests/core/owner-verification-outcome.test.ts     — NEW
engine/tests/core/owner-verification-verdict.test.ts     — NEW
engine/tests/core/unified-diff-changed-lines.test.ts     — NEW
```

### Population and wire (T7, Wave 3)

```
engine/src/core/task-graph-population.ts                 — stamp owner_obligations (always, [] allowed); refuse owner-verification-runner-missing
engine/src/state-file-wire.ts                            — parse/validate owner_obligations
engine/src/handlers/helpers/populate-task-graph.ts       — pass parsed invariants into the population command
engine/tests/core/task-graph-population-owner-obligations.test.ts — NEW
engine/tests/state-file-wire-owner-obligations.test.ts   — NEW
```

### Mutation execution shell (T8, Wave 3)

```
engine/src/orchestration/owner-mutation-workspace.ts     — NEW shell: worktree create/overlay/symlink/rewrite/restore/remove
engine/src/orchestration/owner-verification-runner.ts    — NEW shell: coverage file gathering, Wave base + changed lines, baseline run, mutant runs, observation
engine/src/orchestration/completion-check-runner.ts      — export a root-parameterized runner-command execution
engine/tests/orchestration/owner-mutation-workspace.test.ts — NEW (real git fixture)
engine/tests/orchestration/owner-verification-runner.test.ts — NEW (real git fixture + fake runner)
```

### Review owner map and brief (T9, Wave 3)

```
engine/src/core/owner-verification/owner-map.ts          — NEW pure: renderOwnerMapSection, OWNER_MAP_SECTION, SECOND_COPY_RULE
engine/src/core/wave-review-authority.ts                 — append the owner-map fixed section (AD-9 conditions)
engine/src/core/implementation-brief.ts                  — duty paragraph per touched obligation
engine/src/orchestration/implementation-brief.ts         — pass "graph carries owner_obligations" into the brief
engine/tests/core/owner-obligations.matrix.test.ts       — add the packet and brief sibling rows
engine/tests/core/owner-map-packet.test.ts               — NEW incl. byte-identity regressions
engine/tests/core/implementation-brief-owner-duties.test.ts — NEW
```

### Completion-suite integration (T10, Wave 4)

```
engine/src/core/completion-suite.ts                      — check kind, ownerVerification on result/receipt, failure variants, parsers, evaluation
engine/src/core/verification-manifest.ts                 — authorizeWaveCompletionSuite: inject the owner check when owed
engine/src/core/wave-completion-suite-readiness.ts       — authorize with the same owed predicate
engine/src/handlers/helpers/wave-completion-suite.ts     — plan re-read + drift check, run owner verification, attach observation, diagnostics
engine/tests/core/owner-obligations.matrix.test.ts       — add the gate-scope and readiness sibling rows
engine/tests/core/completion-suite-owner-verification.test.ts — NEW
engine/tests/handlers/wave-completion-suite-owner-verification.test.ts — NEW
```

### Status (T11, Wave 5)

```
engine/src/core/owner-verification/status.ts             — NEW pure projection + remedy text
engine/src/core/loom-status.ts                           — owner-verification reasons and next action
engine/src/handlers/helpers/orchestration.ts             — include the projection in human and --json output
engine/tests/core/owner-verification-status.test.ts      — NEW
```

### Docs (T12, Wave 5)

```
docs/operations.md                                       — G5b duties, status fields, remedies, metric command, baseline counts, typescript install note
docs/architecture.md                                     — owner verification in the completion suite
references/executable-models.md                          — coverage, mutation, exemption grammar, lens, limits; fix the path-presence.matrix.test.ts example
references/plan-template.md                              — Mutation exemption field in the INV template
commands/templates/phase-architecture.md                 — exemption grammar and duties
commands/templates/phase-decompose.md                    — matrix-test duties for owner/sibling Tasks
CONTEXT.md                                               — Owner Obligation, Owner Verification, Mutation Exemption, Owner Map, Second Copy, Family-site Metric
.claude/specs/2026-10-21-g5b-owner-enforcement/spec.md   — glossary amendment: Family change = owner or sibling (AD-4)
```

---

## Component Design

### Owner-verification types (CT-1 surface)

**Responsibility:** The declarations every G5b module and test shares. Its bytes freeze at the Wave 1 gate.
**Files:** `engine/src/core/owner-verification/types.ts`
**Interface:**

```
type MutationPolicy = { kind: "verify" } | { kind: "exempt"; reason: string };
type MutationOperator = "condition-negation" | "comparison-flip" | "logical-swap"
  | "boolean-literal-flip" | "return-value-replacement" | "statement-removal";
type Mutant = { id: string; operator: MutationOperator; line: number; column: number;
  start: number; end: number; original: string; replacement: string };
type MutationPlan = { mutants: readonly Mutant[]; candidates: number; unmutated: number; cap: number };
type MutantOutcome = { kind: "killed" } | { kind: "timed-out" } | { kind: "survived" }
  | { kind: "invalid"; collectionErrors: NonEmpty<string> }
  | { kind: "infrastructure"; failure: OwnerInfrastructureFailure };
type BaselineOutcome = { kind: "green" } | { kind: "red"; failures: NonEmpty<string> }
  | { kind: "infrastructure"; failure: OwnerInfrastructureFailure };
type CoverageVerdict = { kind: "covered" } | { kind: "missing"; paths: NonEmpty<string> }
  | { kind: "infrastructure"; failure: OwnerInfrastructureFailure };
type MutationVerdict =
  | { kind: "exempt"; reason: string }
  | { kind: "red-baseline"; failures: NonEmpty<string> }
  | { kind: "verified"; generated: number; killed: number; timedOut: number; invalid: number;
      survivors: readonly SurvivorDiagnostic[]; unmutated: number; ownerChangedInWave: boolean }
  | { kind: "infrastructure"; failure: OwnerInfrastructureFailure };
type InvariantVerdict = { invariant: string; title: string; owner: string; matrixTest: string;
  coverage: CoverageVerdict; mutation: MutationVerdict };
type OwnerVerificationObservation =
  | { kind: "verified"; obligationsDigest: ArtifactDigest; boundMs: number; verdicts: NonEmpty<InvariantVerdict> }
  | { kind: "unavailable"; failure: OwnerInfrastructureFailure };   // plan unreadable/drifted, no runner, workspace changed
type OwnerInfrastructureFailure = { kind: "plan-unreadable" | "plan-malformed" | "plan-drift" | "runner-missing"
  | "worktree-failed" | "spawn-failed" | "report-missing" | "report-unreadable" | "matrix-test-not-collected"
  | "exit-unexplained-by-report" | "baseline-timed-out" | "missing-wave-base" | "coverage-bound-exceeded"
  | "real-workspace-changed"; detail: string };
type OwnerVerificationFailure = /* missing-siblings | red-baseline | survivor | infrastructure, each naming the Invariant */;
type CoverageOverFilesFn = (input: { matrixTest: string; obligation: OwnerObligation;
  files: ReadonlyMap<string, string>; aliases: PathAliases }) => CoverageVerdict;
type MutationPlanFn = (input: { ownerPath: string; ownerText: string;
  changedLines: ReadonlySet<number>; cap: number }) => MutationPlan;
type ClassifyMutantRunFn = (run: MatrixTestRun, matrixTest: string) => MutantOutcome;
type ClassifyBaselineFn = (run: MatrixTestRun, matrixTest: string) => BaselineOutcome;
```

`OwnerObligation` is defined here as in AD-2. `SiblingEntryPoint` is imported as a type from `../../types`.

**Depends on:** none

### Plan grammar and obligations

**Responsibility:** Parse the exemption into `InvariantOwnership`, and own every selection over Owner Obligations (INV-3).
**Files:** `engine/src/types.ts`, `engine/src/core/parse-plan-models.ts`, `engine/src/handlers/helpers/validate-model-bindings.ts`, `engine/src/core/owner-verification/obligations.ts`
**Interface:**

```
obligationsFromPlan(models: PlanModels): readonly OwnerObligation[]          // owned INVs only, plan order
obligationsDigest(obligations): ArtifactDigest                               // canonical JSON sha256
obligationsAgree(stamped, fromPlan): boolean                                 // canonicalStructuralEquals
waveChangedObligations(waveTasks: readonly Task[], obligations): readonly OwnerObligation[]   // changesFamily
obligationsTouchedBy(fileList: readonly string[], obligations): readonly OwnerObligation[]    // any role
ownerVerificationOwed(graph: TaskGraph, wave: number): readonly OwnerObligation[]             // [] when owner_obligations absent
```

**Depends on:** CT-1 types

### Sibling coverage core

**Responsibility:** Decide whether a matrix test's import graph reaches the owner and every sibling (pure).
**Files:** `import-graph.ts`, `coverage.ts`
**Interface:**

```
moduleEdges(path: string, text: string): { imports: readonly string[]; reexports: readonly string[] }
resolveSpecifier(from: string, specifier: string, aliases: PathAliases, known: ReadonlySet<string>): string | null
coverageFrontier(state: CoverageGraphState, read: ReadonlyMap<string, string>): { next: readonly string[]; state: CoverageGraphState }
coverageOverFiles: CoverageOverFilesFn
```

**Depends on:** CT-1 types

### Mutation plan, outcome, verdict

**Responsibility:** The deterministic mutant set, the run classification and the per-Invariant verdict (pure).
**Files:** `mutation-plan.ts`, `outcome.ts`, `verdict.ts`, `core/unified-diff.ts`
**Interface:**

```
MUTANT_CAP_PER_INVARIANT = 24; MUTANT_TIMEOUT_MS = 60_000
mutationPlan: MutationPlanFn
applyMutant(ownerText: string, mutant: Mutant): string
changedHeadLines(base: string | null, head: string): ReadonlySet<number>
classifyMutantRun: ClassifyMutantRunFn; classifyBaseline: ClassifyBaselineFn
invariantVerdict(obligation, coverage, baseline | "exempt", plan, outcomes): InvariantVerdict
ownerVerificationFailures(observation: OwnerVerificationObservation): readonly OwnerVerificationFailure[]
mutationBoundMs(owed: readonly OwnerObligation[], plans: ReadonlyMap<string, MutationPlan>, perMutantMs: number): number
```

**Depends on:** CT-1 types

### Population and wire

**Responsibility:** Stamp obligations at population, refuse a non-exempt owned plan without a frozen `affectedRunner`, and round-trip the field through the state wire.
**Files:** `task-graph-population.ts`, `state-file-wire.ts`, `populate-task-graph.ts`
**Interface:** the population command gains `invariants: readonly PlanInvariant[]`. The new reject reason is `owner-verification-runner-missing`. The wire validates each obligation's shape and refuses an exemption with a blank reason.
**Depends on:** Plan grammar and obligations

### Mutation execution shell

**Responsibility:** All effects of owner verification: worktrees, file reads for coverage, git base resolution, runner execution and real-workspace digests.
**Files:** `orchestration/owner-mutation-workspace.ts`, `orchestration/owner-verification-runner.ts`, `orchestration/completion-check-runner.ts`
**Interface:**

```
runOwnerVerification(input: { root: CanonicalRepositoryRoot; graph: TaskGraph; wave: number;
  owed: NonEmpty<OwnerObligation>; manifest: FrozenVerificationManifest;
  observeWorkspace: () => DomainResult<ArtifactDigest, string> }): Promise<OwnerVerificationObservation>
```

It never throws to the caller. Every failure becomes `unavailable` or a per-Invariant `infrastructure` verdict. Workspace cleanup runs in `finally`.
**Depends on:** Sibling coverage core; Mutation plan, outcome, verdict

### Review owner map and brief

**Responsibility:** Issue the owner-map section and the second-copy rule to the two reviewer roles, and state the duties in the brief.
**Files:** `owner-map.ts`, `wave-review-authority.ts`, `core/implementation-brief.ts`, `orchestration/implementation-brief.ts`
**Interface:** `renderOwnerMapSection(planFile: string, obligations: NonEmpty<OwnerObligation>): string`, and `OWNER_MAP_SECTION = "owner-map"` as the byte-section id.
**Depends on:** Plan grammar and obligations

### Completion-suite integration

**Responsibility:** Authorize, run, record, evaluate and replay the owner check inside the existing suite.
**Files:** `completion-suite.ts`, `verification-manifest.ts`, `wave-completion-suite-readiness.ts`, `handlers/helpers/wave-completion-suite.ts`
**Interface:** `authorizeWaveCompletionSuite(manifest, active, workspaceDigest, owner: { obligationsDigest } | null)`. `evaluateWaveCompletionSuite` adds the owner failures from `ownerVerificationFailures`.
**Depends on:** Population and wire; Mutation execution shell

### Status

**Responsibility:** One projection of the latest owner-verification result for human output and JSON, plus the remedy.
**Files:** `core/owner-verification/status.ts`, `core/loom-status.ts`, `handlers/helpers/orchestration.ts`
**Depends on:** Completion-suite integration

### Family-site metric

**Responsibility:** Count raw second sites per known family, deterministically, with a baseline delta.
**Files:** `core/family-sites.ts`, `handlers/helpers/family-sites.ts`
**Depends on:** none

---

## Data Flow

```
plan.md ──parsePlanModels──► PlanInvariant[] ──obligationsFromPlan──► owner_obligations (stamped at populate)
                                                                              │
Wave Gate: ensureWaveCompletionSuite                                          ▼
  ownerVerificationOwed(graph, wave) ── [] ──► suite without the owner check (bytes as before)
        │ non-empty
        ▼
  re-read plan → obligationsAgree? ── no ──► unavailable(plan-drift) ──► rejected
        │ yes
        ▼
  runOwnerVerification (shell, outside lock)
    digest real workspace
    per owed obligation:
      read matrix-test import frontier ──coverageOverFiles──► CoverageVerdict
      exempt? ──► MutationVerdict.exempt
      else: Wave base (start_sha / merge-base) ─► changedHeadLines ─► mutationPlan (cap 24)
            worktree(HEAD + overlay) ─► baseline via affectedRunner ─► classifyBaseline
            green ─► each mutant: applyMutant → run → classifyMutantRun → restore
      invariantVerdict
    digest real workspace (must equal)
        ▼
  WaveCompletionSuiteResult.ownerVerification ─► evaluateWaveCompletionSuite
        ├─ accepted ─► receipt (digest-bound) ─► complete-wave-gate
        └─ rejected(owner-verification-rejected / -infrastructure) ─► status projection + remedy
```

Everything that decides lives in the pure core. The shell only reads bytes, runs git and the runner, and digests the workspace.

---

## Invariants

### INV-1: The TypeScript compiler API enters only through the two owner-verification seams

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-1-typescript-compiler-api-seam.json`
**Owner module:** none
**Unowned reason:** An import-confinement prohibition. The rule forbids a dependency edge everywhere except two named files, and has no implementation of its own to home.
**Statement:** No engine, Pi or script TypeScript file other than `engine/src/core/owner-verification/mutation-plan.ts` and `engine/src/core/owner-verification/import-graph.ts` imports, requires or dynamically imports `typescript` or a `typescript/` subpath. Test files are exempt.

### INV-2: The owner-verification core performs no I/O

**Tier:** advisory
**Owner module:** none
**Unowned reason:** A purity prohibition over a directory. A project regex rule cannot be scoped to a directory, so it is enforced instead by the programmatic `no-io-in-pure-modules` rule once T4 lists `engine/src/core/owner-verification/` in `DEFAULT_PURE_MODULES`.
**Statement:** No file under `engine/src/core/owner-verification/` imports `child_process`, `fs`, `os`, `process`, `crypto` (beyond the `createHash` capability), or reads the clock, randomness or `process.*`. Worktrees, runner processes and file reads live only in `engine/src/orchestration/owner-mutation-workspace.ts` and `engine/src/orchestration/owner-verification-runner.ts`.

### INV-3: Which owned Invariants a Wave or Task owes is decided only by obligations.ts

**Tier:** advisory
**Owner module:** `engine/src/core/owner-verification/obligations.ts`
**Sibling entry points:**
- `engine/src/handlers/helpers/wave-completion-suite.ts` — the Wave's owed obligations that the owner check runs for
- `engine/src/core/wave-completion-suite-readiness.ts` — re-authorizing the suite roster with the same owed predicate
- `engine/src/core/wave-review-authority.ts` — obligations a reviewed Task touches, which gate the owner-map section
- `engine/src/core/implementation-brief.ts` — obligations a Task touches, which drive the duty paragraph
**Matrix test:** `engine/tests/core/owner-obligations.matrix.test.ts`
**Statement:** Every call site that decides which Owner Obligations apply calls `waveChangedObligations`, `obligationsTouchedBy` or `ownerVerificationOwed`, and never classifies roles or compares `owner_obligations` inline. That covers gate scope, suite authorization, suite readiness, review-packet owner maps and brief duties. The Wave scope uses G5a's `changesFamily` (owner or sibling); the touch scope uses any role.

---

## Contracts

### CT-1: Owner verification — coverage, mutation, exemption and the gate verdict

**Types file:** `engine/src/core/owner-verification/types.ts`
**Acceptance tests:**
- `engine/tests/acceptance/owner-verification-core.acceptance.test.ts` — FR-005, FR-006, FR-007, FR-009, FR-010, FR-011, FR-012, FR-013, FR-017, AS-001, AS-002, AS-003, AS-006, AS-009, AS-010, AS-011, AS-012, AS-013, AS-014, AS-015
- `engine/tests/acceptance/mutation-exemption.acceptance.test.ts` — FR-018, FR-019, AS-019, AS-020
- `engine/tests/acceptance/owner-verification-gate.acceptance.test.ts` — FR-001, FR-002, FR-008, FR-014, FR-015, FR-016, FR-020, AS-007, AS-008, AS-016, AS-017, AS-018
**Supported domain:** `engine/tests/acceptance/owner-verification-core.acceptance.test.ts`
**Statement:** A matrix test covers an owned Invariant only when its direct imports, closed under re-exports and resolved through relative paths and tsconfig aliases to files, include the owner and every declared sibling; otherwise the verdict names every missing path. The mutant set is a pure, deterministic function of owner bytes, changed lines and cap: exactly the six fixed operators, on changed lines only, capped at 24 with an evenly spaced selection and the unmutated count reported. A report with a failing non-collection testcase kills, a timeout kills, collection-only errors are invalid and a passing report survives; a missing, unreadable, empty or exit-unexplained report is infrastructure and never a kill. The plan grammar refuses an exemption without a reason and an exemption on an unowned Invariant. Through `ensureWaveCompletionSuite`, a Wave that changed an owned family blocks on a red baseline before any mutant runs, on any survivor of a non-exempt Invariant, on a missing sibling, on any infrastructure failure, and on an unreadable or drifted plan; it records an exemption and still runs coverage; and it leaves the real workspace byte-identical.

### CT-2: Second-copy lens, brief duties and status

**Types file:** none
**No types reason:** The slice consumes CT-1's types and drives entry points that exist today: wave review issuance in `wave-review-authority.ts`, the implementation-brief renderer, and `helper orchestration status`.
**Acceptance tests:**
- `engine/tests/acceptance/owner-map-packet.acceptance.test.ts` — FR-022, FR-023, FR-025, AS-022, AS-023, AS-025
- `engine/tests/acceptance/owner-verification-status.acceptance.test.ts` — FR-027, FR-028, AS-028, AS-029, AS-030
**Statement:** A code-reviewer or architecture-tech-lead packet for a Task that touches an owned family carries an engine-issued owner-map section, inside the packet digest, with each touched Invariant's id, title, owner, siblings, matrix test and statement, plus the second-copy rule: cite `<plan file>#INV-N`, critical when the copy diverges (with the diverging input as the consequence), advisory when it is identical. The brief names the coverage and mutation duties, or the exemption. Status, in human output and `--json`, reports per Invariant the coverage result and the mutant counts or the exemption, and a blocked gate's next action names the Invariant and the remedy.

---

## Implementation Phases

Twelve Tasks over five Waves. Byte-preservation scenarios already hold today, so they cannot be observed RED and stay out of the contracts. They are claimed as ordinary regression tests by the Task that could break them: AS-004, AS-005, AS-021, AS-024, AS-026 and AS-027, plus FR-003, FR-004, FR-021, FR-024 and FR-026. Every acceptance testcase must assert the **new** evidence (for example, that the owner check ran and recorded its verdict), so it is RED before the feature exists.

### Phase 1: Contracts and the metric (no dependencies)

- **T1 — CT-1 contract.**
  - Write `types.ts` (declarations only) and the three CT-1 acceptance files. Each testcase is named `FR-0NN: …` or `AS-0NN: …`.
  - Write the compiling stubs `coverage.ts`, `mutation-plan.ts` and `outcome.ts`. Each exports its CT-1 function-type alias with a body that throws `not implemented (G5b)`, so the core tests load and fail behaviorally.
  - Write the fixture builder `owner-verification-repo.ts`. It creates a temp git repo holding:
    - an owner, two siblings, a re-export barrel and a tsconfig `paths` alias
    - three matrix tests: discriminating, vacuous and sibling-omitting
    - a fake runner script that runs the real engine vitest over one file, or a deterministic stand-in that writes JUnit
  - The gate tests drive `ensureWaveCompletionSuite` with a fixture graph carrying `owner_obligations`. The exemption tests drive `parsePlanModels` and `validateModelBindings`.
- **T2 — CT-2 contract.** Write the two CT-2 acceptance files.
  - The packet tests drive wave review issuance with an in-memory graph carrying `owner_obligations`.
  - The brief tests drive the core brief renderer.
  - The status tests drive the status projection from a persisted completion result fixture.
  - No stubs.
- **T3 — Family-site metric** (claims FR-029, FR-030, AS-031, AS-032, AS-033).
  - Implement AD-11: `family-sites.ts`, the helper with `--json`, `--baseline` and `--root`, and route registration. Add the module to `DEFAULT_PURE_MODULES`.
  - Calibrate the patterns against the known second copies and record the final patterns only in `FAMILIES`.
  - Generate `docs/family-sites.baseline.json` from a detached worktree of `626db7fb` via `--root`, then remove the worktree.
  - Write a test that two runs give identical bytes, and a delta test.
- **Files:** see File Structure, CT-1, CT-2 and Family-site metric.

**Claim map (for decompose).** Each anchor falls due at the Wave of its last claimant.

| Anchors | Claimed by |
|---|---|
| FR-018, FR-019, AS-019, AS-020 | T4 |
| FR-005, FR-006, FR-007, AS-001, AS-002, AS-003, AS-006 | T5 |
| FR-009..FR-013, FR-017, AS-009..AS-015 | T6 |
| FR-001, FR-002, FR-014, FR-020, AS-018 | T7 and T10 |
| FR-008, FR-015, FR-016, AS-007, AS-008, AS-016, AS-017 | T8 and T10 |
| FR-022, FR-023, FR-025, AS-022, AS-023, AS-025, FR-027, AS-028 | T9 |
| FR-028, AS-029, AS-030 | T11 |
| FR-029, FR-030, AS-031..AS-033 | T3 (not in a contract) |
| FR-031, FR-032, AS-034..AS-036 | T12 (not test-decided) |

### Phase 2: Pure core (depends on Phase 1)

- **T4 — Plan grammar and obligations** (claims FR-018, FR-019, FR-021, AS-019, AS-020, AS-021; depends on T1).
  - Implement AD-3 in `types.ts`, `parse-plan-models.ts` and `validate-model-bindings.ts`, including the misplaced-label stray.
  - Add `owner_obligations?` to `TaskGraph`.
  - Implement `obligations.ts` (AD-2, AD-4; INV-3 owner).
  - List `engine/src/core/owner-verification/` in `DEFAULT_PURE_MODULES` (INV-2). This puts the stubs and T5/T6's modules under the purity rule.
  - Write `owner-obligations.matrix.test.ts` with the owner rows: Wave scope vs touch scope over owner-only, sibling-only, matrix-only and unrelated file lists, and absent vs empty `owner_obligations`.
  - Write a regression test that every existing plan fixture, plus `.claude/plans/2026-10-16-g4-slice-2-oracle.md`, parses to the same `PlanModels` apart from `mutation: { kind: "verify" }` (AS-021).
- **T5 — Sibling coverage core** (claims FR-005..FR-007, AS-001..AS-003, AS-006; depends on T1).
  - Implement AD-5. `import-graph.ts` is an INV-1 seam.
  - Property tests:
    - resolution and reach are permutation-invariant over the file map's insertion order
    - adding an unrelated file never changes the verdict
    - a re-export chain of any length reaches its target, while a plain import chain longer than one hop does not
- **T6 — Mutation plan, outcome, verdict** (claims FR-009..FR-013, FR-017, AS-009..AS-015; depends on T1).
  - Implement AD-6 and AD-7, and `changedHeadLines` in `unified-diff.ts`. `mutation-plan.ts` is an INV-1 seam.
  - Property tests:
    - the plan is byte-identical across 10 runs (SC-003)
    - every mutant changes exactly one site, on a changed line
    - `applyMutant` differs from the original only within `[start, end)`
    - the selection never exceeds the cap, and `selected + unmutated = candidates`
    - an empty changed-line set yields zero mutants
  - Outcome table tests cover every row of AD-7.
- **Files:** see File Structure, T4, T5 and T6.

### Phase 3: Population, execution shell, lens (depends on Phase 2)

- **T7 — Population and wire** (claims FR-001, FR-002, FR-004, AS-018; depends on T4).
  - Stamp `owner_obligations` on every population, `[]` included.
  - Refuse `owner-verification-runner-missing` when a non-exempt owned Invariant meets a frozen manifest with no `affectedRunner`.
  - Validate the field in `state-file-wire.ts`.
  - Write a regression test that a graph without the field loads and owes nothing (FR-004).
  - Write a test that re-population replaces the field.
- **T8 — Mutation execution shell** (claims FR-008, FR-015, FR-016, AS-007, AS-008, AS-016, AS-017; depends on T5 and T6).
  - Implement AD-8 and `runOwnerVerification`: the coverage frontier loop with real file reads and tsconfig `paths` via `jsonc-parser`, the Wave base via git, the baseline-first ordering, and per-mutant rewrite/run/restore.
  - Export the root-parameterized runner from `completion-check-runner.ts`.
  - Integration tests on the T1 fixture repo:
    - a discriminating test kills every non-invalid mutant
    - a vacuous test lets every non-invalid mutant survive (SC-002)
    - a red baseline runs zero mutants
    - a runner that cannot start or writes no report is infrastructure
    - the worktree is removed even when a run throws
    - the real workspace digest is unchanged before and after every test (SC-004)
- **T9 — Review owner map and brief** (claims FR-022..FR-027, AS-022..AS-028; depends on T4).
  - Implement AD-9 and AD-10's brief half. Add the `wave-review-authority.ts` and `implementation-brief.ts` rows to the INV-3 matrix test.
  - Write regression tests that packet bytes are identical to the pre-feature fixtures for:
    - a Task touching no owned family (AS-024; SC-005)
    - the five other reviewer roles (AS-026)
    - the spec-check subject
    - a schema-1 registration
    - a graph without `owner_obligations`
  - AS-027 holds by construction, because standalone review never builds a wave packet. Assert it with a test that the standalone packet builders import nothing from `core/owner-verification/`.
- **Files:** see File Structure, T7, T8 and T9.

### Phase 4: Completion-suite integration (depends on Phase 3)

- **T10 — Completion-suite integration** (claims FR-001..FR-003, FR-008, FR-014..FR-016, FR-020, AS-004, AS-005, AS-007, AS-008, AS-016..AS-018; depends on T7 and T8).
  - Implement AD-1: the check kind, its parsers and digest, and the result/receipt `ownerVerification` with its parsers.
  - Add the evaluation through `ownerVerificationFailures`, authorization in `verification-manifest.ts`, and readiness in `wave-completion-suite-readiness.ts`, both through `ownerVerificationOwed`.
  - In `wave-completion-suite.ts`: the plan re-read and `obligationsAgree` drift block, the `runOwnerVerification` call outside the lock, and diagnostics that render each failure.
  - Add the gate-scope and readiness rows to the INV-3 matrix test.
  - Write regression tests that the suite roster and digest are byte-identical to the pre-feature fixtures when nothing is owed (AS-004, AS-005, FR-003).
  - Write a test that receipt reuse still holds for an unchanged workspace.
  - Write an end-to-end test that the Pi wave-gate program path produces the same verdict as the Claude path from the same fixture (NFR-002).
- **Files:** see File Structure, T10.

### Phase 5: Status and docs (depends on Phase 4)

- **T11 — Status** (claims FR-028, AS-029, AS-030; depends on T10).
  - Implement AD-10's status half: the pure `status.ts` projection, `loom-status.ts` reasons and next action, and helper output from one projection for human and `--json`.
- **T12 — Docs** (claims FR-031, FR-032, AS-034, AS-035, AS-036; depends on T3, T9 and T10).
  - Update every doc in File Structure. State the limits (AS-035):
    - an import is not proof of exercise
    - mutation covers the owner's changed lines only
    - invalid mutants are neither killed nor survived, so an all-invalid run passes and says so
    - an identical copy is advisory
    - standalone reviews carry no owner map
    - a matrix-test-only change does not trigger the checks
    - `typescript` is installed by the documented `bun install`
  - Correct `references/executable-models.md`'s `path-presence.matrix.test.ts` example: point it at a real file, or mark it illustrative (AS-036).
  - Record the baseline counts from `docs/family-sites.baseline.json` (AS-034).
  - Apply the AD-4 spec glossary amendment.
  - Add the CONTEXT.md terms.
  - This Task waives new tests with reason `documentation-only`.
- **Files:** see File Structure, T11 and T12.

---

## Testing Strategy

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| Plan grammar and obligations | exemption parse states, problem rendering, strays; obligation selection | populate/repair/validate refusing malformed exemptions (CT-1 exemption file) | Wave scope ⊆ touch scope for every file list; absent `owner_obligations` ⇒ nothing owed |
| Sibling coverage core | `moduleEdges` over every import form; `resolveSpecifier` ladder and aliases; `decideCoverage` order | none (pure) | permutation invariance; unrelated-file invariance; re-export chains reach, plain chains do not |
| Mutation plan, outcome, verdict | each operator on each construct; selection spacing; every AD-7 table row; failure rendering | none (pure) | determinism ×10 (SC-003); one site per mutant; confinement to changed lines; cap arithmetic |
| Mutation execution shell | Wave base resolution (single, octopus, missing) | real git fixture: kill/survive/invalid/timeout/infrastructure; worktree cleanup on throw; real-workspace digest equality (SC-004) | none |
| Population and wire | stamp `[]` vs non-empty; runner-missing refusal; wire round-trip | populate on a fixture plan | none |
| Review owner map and brief | section rendering; rule text; brief duty and exemption | issuance over a fixture graph; byte-identity regressions (SC-005) | packet bytes unchanged ⇔ no touched obligation or non-target role |
| Completion-suite integration | check-kind parse/digest; evaluation failure mapping | `ensureWaveCompletionSuite` on fixture repos (CT-1 gate file); Pi vs Claude parity; receipt reuse | none |
| Status | projection per verdict kind; remedy text | `helper orchestration status` human vs `--json` equivalence | none |
| Family-site metric | per-family pattern hits; owner exclusion; delta | helper `--json`, `--baseline`, `--root` | output byte-identical across runs |

Verification Policy:
- Every code Task requires new tests and regression tests.
- T1 and T2 are contract Tasks, judged RED by the Wave 1 gate.
- T12 waives new tests as `documentation-only`.

---

## Security & NFR Notes

- **Command execution.** The matrix test runs only through the frozen manifest `affectedRunner`, formed by `affectedRunnerCheck`, with `{files}` = one validated repo-relative path. The plan contributes paths, never command text. The runner's cwd and report path come from the frozen manifest.
- **Workspace isolation.** Mutants exist only inside a mkdtemp worktree. The real workspace is digested before and after, and any difference blocks. `node_modules` is symlinked, never written. Removal runs in `finally`, and `git worktree prune` clears a crashed predecessor.
- **Deserialization.** `owner_obligations` passes the state wire's exact-record validation. The persisted result's `ownerVerification` passes completion-suite parsers before evaluation or status reads it.
- **Bounded time (NFR-004).** At most 24 mutants plus 1 baseline per owed, non-exempt Invariant, at no more than 60 s each, clamped to `affectedRunner.timeoutMs`. The bound is reported in the observation and in status.
- **Fail-closed (primary axis).** Every ambiguous observation is infrastructure and blocks. No automatic retry: the operator re-runs the gate.

---

## Verification

1. `cd engine && bun run typecheck`, which must be clean.
2. `npm run verify` (Loom's `project:verify` check), which must be green. `bun "$LOOM_DIR"/engine/src/cli.ts helper validate-lint-rules .claude/linter/rules` must still load every rule.
3. `bun engine/src/cli.ts helper family-sites --json` twice: the outputs must be byte-identical. `--baseline docs/family-sites.baseline.json` shows the delta since `626db7fb`.
4. On the T1 fixture repo:
   - a Wave changing the owner, with the sibling-omitting matrix test, blocks naming the sibling
   - the vacuous test blocks naming survivors
   - the discriminating test passes
   - `helper orchestration status --json` shows the per-Invariant counts and the remedy
