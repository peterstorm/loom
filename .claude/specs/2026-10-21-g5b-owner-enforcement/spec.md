# Feature: G5b — owner-map enforcement and matrix-test discipline

**Status:** Draft 2026-10-21. Design source: the G5 proposal (vault `programming/plans/loom/generation-quality-sequence.md`, "G5b — the teeth") and the G5a design note (D7 deferrals). Operator decisions (2026-10-21): a bespoke owner mutator built on the TypeScript compiler API, not StrykerJS; surviving mutants block the Wave Gate unless the plan declares an explicit exemption with a reason; the family-site metric ships now, and the fail-closed path-probe consolidation is G5b's live pilot vehicle (shell and claim families follow later).

## Summary

G5a (#82) made every plan Invariant name one owner module, its sibling entry points and a matrix test. Plan validation checks that those paths exist, hold one role each and are built owner-first. Nothing checks that the matrix test is any good. A matrix test that imports one sibling, or that still passes when the owner's predicate is broken, satisfies G5a today. The G5a note records this hole for INV-5 (`findings-guards.test.ts` is partial) and defers the fix to G5b.

G5b gives the declaration teeth in three places, all at the Wave Gate, where the engine already owns verification:

1. **Sibling coverage.** When a Wave changes an owned family, its matrix test must reach the owner and every declared sibling entry point.
2. **Mutation verification.** When a Wave changes an owned family, the engine breaks the owner module on its changed lines, one deterministic mutation at a time, and runs the matrix test against each mutant. The test must fail on every mutant. A surviving mutant blocks the gate unless the plan exempts that Invariant with a reason.
3. **The second-copy lens.** Wave reviewers receive the owner map and a standing rule from the engine: a diff that implements a declared-owned invariant outside its owner module is a finding against that Invariant. It is critical when the second copy diverges from the owner, and advisory when it behaves identically.

A repo-hygiene metric counts raw second sites for the three known families, so single-homing progress is measurable rather than asserted.

Nothing is model-chosen. Mutation sites come from the owner's changed lines, mutation operators are a fixed engine set, the runner is operator-declared, and kill or survival is read from the structured test report.

## User Scenarios

### US1: [P1] A Wave that changes an owned family proves its matrix test reaches every entry point

**As an** operator
**I want** the Wave Gate to refuse a matrix test that does not exercise the owner and every declared sibling entry point
**So that** "single home" is checked against all the callers the plan names, not only the ones the test author remembered

**Acceptance Scenarios:**
- AS-001: Given an owned Invariant whose family the Wave changed, and a matrix test that imports the owner module and every declared sibling entry point, when the Wave Gate runs, then the sibling-coverage check passes for that Invariant
- AS-002: Given the same Invariant whose matrix test does not import one declared sibling, when the Wave Gate runs, then the gate blocks with a diagnostic naming the Invariant, the matrix test and the missing sibling path
- AS-003: Given an owned Invariant with `**Sibling entry points:** none`, when the Wave Gate runs, then sibling coverage requires only that the matrix test reaches the owner module
- AS-004: Given an owned Invariant whose family the Wave did not change, when the Wave Gate runs, then no sibling-coverage check runs for it
- AS-005: Given an unowned Invariant (`**Owner module:** none` with a reason), when the Wave Gate runs, then no sibling-coverage or mutation check runs for it
- AS-006: Given a matrix test that reaches a sibling only through a re-export, a relative path or a path alias that resolves to the sibling file, when the check runs, then the sibling counts as reached; a module specifier that resolves to a different file does not count

### US2: [P1] The owner's changed lines are mutation-verified against the matrix test

**As an** operator
**I want** the engine to break the owner module and require the matrix test to notice
**So that** a matrix test that passes whatever the owner does (a vacuous pin) cannot complete a Wave

**Acceptance Scenarios:**
- AS-007: Given an owned Invariant whose family the Wave changed, when the Wave Gate runs, then the engine first runs the matrix test against the unmutated workspace, and requires it to pass before generating any mutant
- AS-008: Given the unmutated matrix test fails, when the Wave Gate runs, then the gate blocks with a diagnostic saying the matrix test is red before mutation, and no mutant is run
- AS-009: Given an owner module whose changed lines in the Wave contain mutable constructs, when the mutation check runs, then each mutant is produced by one operator from the fixed engine set (condition negation, comparison flip, logical operator swap, boolean literal flip, return-value replacement, removed statement) applied to one site on a changed line, and the mutant set is identical on every run for the same owner bytes and Wave base
- AS-010: Given a mutant against which the matrix test's structured report shows at least one failing testcase, when the check runs, then that mutant is killed
- AS-011: Given a mutant against which the matrix test passes, when the check runs, then that mutant survives, and the gate blocks with a diagnostic naming the Invariant, the owner file, the line, the operator and the original and mutated text
- AS-012: Given a mutant that does not compile or load, so the report shows only collection or import errors, when the check runs, then that mutant is invalid: it is neither killed nor survived, and it is reported as invalid. A run whose every generated mutant is invalid carries no mutation evidence: the gate blocks with the `no-valid-mutants` infrastructure diagnostic instead of passing
- AS-013: Given a mutant whose matrix-test run exceeds its per-mutant time limit, when the check runs, then that mutant is killed by timeout and reported as such
- AS-014: Given an owner module whose changed lines contain no mutable construct, when the check runs, then it passes and records that zero mutants were generated, and says so in the gate evidence and status
- AS-015: Given more candidate sites than the per-Invariant mutant cap, when the check runs, then the engine selects mutants deterministically up to the cap and reports how many sites were not mutated
- AS-016: Given mutation runs, when any mutant runs, then it runs in an isolated copy of the workspace, and the real workspace bytes are identical before and after the check
- AS-017: Given an infrastructure failure (the runner cannot start, the report is missing or unreadable, the isolated copy cannot be made), when the check runs, then the gate blocks with a diagnostic naming the failure; an infrastructure failure never counts as a kill

### US3: [P1] The plan can exempt an Invariant from mutation, explicitly and with a reason

**As a** plan author
**I want** to declare that an owned Invariant's matrix test is exempt from mutation, with the reason
**So that** an owner whose behavior cannot be meaningfully mutated (generated tables, pure re-exports, I/O adapters) is an explicit, reviewed decision rather than a silent omission

**Acceptance Scenarios:**
- AS-018: Given an owned Invariant that declares a mutation exemption with a non-empty reason, when the Wave Gate runs, then sibling coverage still runs, the mutation check does not, and the gate evidence records the exemption and its reason
- AS-019: Given an Invariant that declares a mutation exemption with no reason, when the plan is validated at populate, repair or validate, then validation fails with a diagnostic naming the Invariant
- AS-020: Given an unowned Invariant that declares a mutation exemption, when the plan is validated, then validation fails: an exemption is meaningful only on an owned Invariant
- AS-021: Given a plan written before this feature (no exemption field anywhere), when it is validated, then it validates exactly as before

### US4: [P2] Wave reviewers check for second copies against the owner map

**As an** operator
**I want** the code-reviewer and architecture-tech-lead in each Wave review to receive the owner map and the second-copy rule from the engine
**So that** an implementation that re-homes a declared invariant outside its owner is found by rule, even though reviewers load frozen archived guidance

**Acceptance Scenarios:**
- AS-022: Given a Wave Gate review whose Task touches an owned Invariant's family, when the code-reviewer or architecture-tech-lead Context Packet is built, then it carries an engine-issued owner-map section listing, for each such Invariant, its id, title, owner module, sibling entry points, matrix test and statement
- AS-023: Given that packet, when it is issued, then it also carries the second-copy rule: a diff that implements a declared-owned invariant's predicate outside its owner module is a finding citing `<plan file>#INV-N` as the violated contract, critical when the copy's behavior diverges from the owner's on some input, and advisory when it is behaviorally identical
- AS-024: Given a Task that touches no owned family, when its review packets are built, then they carry no owner-map section, and their bytes are unchanged from before this feature
- AS-025: Given a review packet that carries the owner map, when its digest is computed, then the owner map is part of the digest, so retry identity covers it
- AS-026: Given other reviewer roles (silent-failure-hunter, pr-test-analyzer, comment-analyzer, type-design-analyzer, code-simplifier), when their packets are built, then they carry no owner-map section
- AS-027: Given a standalone review (`/review-and-fix` with no plan), when its packets are built, then they carry no owner-map section

### US5: [P2] Implementers and operators see the duty and the result

**As an** implementation agent and as an operator
**I want** the brief to state that the matrix test will be coverage- and mutation-checked, and status to show the outcome
**So that** the duty is known before the work, and a block is explained without reading engine logs

**Acceptance Scenarios:**
- AS-028: Given a Task whose file list makes it the owner or matrix-test author of an owned Invariant, when its implementation brief is rendered, then the ownership section states that the matrix test must import the owner and every sibling, and that the owner's changed lines will be mutation-verified (or names the declared exemption)
- AS-029: Given a Wave Gate run that ran the checks, when `helper orchestration status` is read (human or `--json`), then it reports per Invariant: coverage pass or the missing siblings, and mutants generated, killed, timed out, invalid, survived and unmutated sites, or the exemption
- AS-030: Given a blocked gate caused by a survivor or a missing sibling, when status is read, then the next action names the Invariant and the remedy (strengthen the matrix test, or declare an exemption with a reason)

### US6: [P2] The family-site metric makes single-homing measurable

**As an** operator
**I want** a command that counts raw second sites for the three known families
**So that** consolidation progress is a number recorded before and after, not a claim

**Acceptance Scenarios:**
- AS-031: Given the repository, when the metric command runs, then it reports, for each of the three families (fail-closed path probes, shell tokenizing, claim conservation), the count and file:line list of raw sites outside the family's owner modules, using patterns defined in one place
- AS-032: Given the same repository bytes, when the metric runs twice, then the output is identical
- AS-033: Given the metric's JSON output, when it is compared with a recorded baseline, then the command can report the per-family delta
- AS-034: Given this feature's merge, when the docs are read, then they record the baseline counts at the feature's base commit

### US7: [P3] Docs state the obligations and their honest limits

**Acceptance Scenarios:**
- AS-035: Given the operator docs and `references/executable-models.md`, when they are read, then they describe sibling coverage, mutation verification, the exemption grammar, the second-copy lens and their limits (an import is not proof of exercise; mutation covers changed lines only; an identical copy is advisory; standalone reviews carry no owner map)
- AS-036: Given `references/executable-models.md`, when its INV example is read, then every path it names exists in the repository or is clearly marked as illustrative

## Functional Requirements

### Scope of the checks
- FR-001: The sibling-coverage and mutation checks MUST run at the Wave Gate, for exactly the owned Invariants whose family the Wave changed, using G5a's existing family-change rule
- FR-002: The checks MUST read the Invariants from the plan the TaskGraph names. An unreadable or malformed plan, when the graph names one, MUST block the gate with a diagnostic, never skip the checks
- FR-003: Unowned Invariants MUST NOT be checked. Owned Invariants whose family the Wave did not change MUST NOT be checked
- FR-004: TaskGraphs populated before this feature MUST NOT newly owe these checks

### Sibling coverage
- FR-005: The matrix test MUST statically reach the owner module and every declared sibling entry point through its module imports, resolved to files (relative paths, re-exports and the project's path aliases)
- FR-006: A missing owner or sibling MUST block the gate with a diagnostic naming the Invariant, the matrix test and every missing path
- FR-007: The coverage decision MUST be a pure function of the matrix test's import graph and the declared paths

### Mutation verification
- FR-008: Before any mutant, the matrix test MUST pass against the unmutated workspace; a red baseline MUST block the gate
- FR-009: Mutation sites MUST be restricted to the owner module's lines changed in the Wave relative to the Wave's base, and to constructs the fixed operator set can mutate
- FR-010: The operator set MUST be fixed by the engine: condition negation, comparison operator flip, logical operator swap, boolean literal flip, return-value replacement, and removal of an expression statement
- FR-011: Mutant generation MUST be deterministic for the same owner bytes, changed-line set and cap, and MUST use the TypeScript compiler API to locate sites
- FR-012: Each Invariant MUST have a mutant cap and each mutant a time limit; when sites exceed the cap, selection MUST be deterministic and the unmutated count MUST be reported
- FR-013: The matrix test MUST run through an operator-declared manifest runner whose structured report decides each outcome. Killed: at least one failing testcase. Survived: the report passes. Invalid: only collection or import errors. Timed out: the time limit was exceeded, which counts as killed
- FR-014: Any survivor MUST block the gate unless the Invariant declares a mutation exemption
- FR-015: Every mutant MUST run in an isolated copy of the workspace; the real workspace MUST be byte-identical before and after
- FR-016: Infrastructure failures MUST block the gate with a named diagnostic and MUST NOT count as kills. They include an owner module the TypeScript parser reports syntax errors for (`owner-unparseable`) and a run that generated mutants of which every one was invalid (`no-valid-mutants`)
- FR-017: The mutation plan (sites, operators, selection) MUST be a pure function; running mutants is the shell's effect

### Exemption grammar
- FR-018: An owned Invariant MAY declare a mutation exemption with a mandatory non-empty reason, in the plan's Invariant grammar
- FR-019: Plan validation (populate, repair, validate) MUST reject an exemption without a reason and an exemption on an unowned Invariant, as malformed ownership
- FR-020: An exemption MUST disable only the mutation check; sibling coverage MUST still run
- FR-021: Plans without the exemption field MUST validate exactly as before

### Second-copy lens
- FR-022: Wave review Context Packets for code-reviewer and architecture-tech-lead MUST carry an engine-issued owner-map section for every owned Invariant whose family the reviewed Task touches, and the second-copy rule text
- FR-023: The owner-map section MUST be part of the packet's integrity digest
- FR-024: Packets for other roles, packets for Tasks that touch no owned family, and standalone review packets MUST NOT change
- FR-025: The second-copy rule MUST direct reviewers to cite `<plan file>#INV-N` as the violated contract, to rate a divergent copy critical with its diverging input as the consequence, and to rate a behaviorally identical copy advisory
- FR-026: The Refutation Panel and the existing severity rules MUST apply unchanged to second-copy findings

### Brief and status
- FR-027: The implementation brief's ownership section MUST state the coverage and mutation duties for the Invariants the Task touches, or the declared exemption
- FR-028: `helper orchestration status` (human and JSON, one projection) MUST report the per-Invariant coverage and mutation outcome of the latest Wave Gate run, and name the remedy in the next action when either blocks

### Family-site metric
- FR-029: A command MUST count raw sites for the three known families outside their owner modules, with every family's owners and patterns defined in one module
- FR-030: Its output MUST be deterministic, available as JSON, and comparable with a recorded baseline
- FR-031: The docs MUST record the baseline at this feature's base commit

### Docs
- FR-032: Operator docs, `references/executable-models.md`, `references/plan-template.md` and the architecture and decompose templates MUST describe the new duties, the exemption grammar and the limits; the nonexistent `path-presence.matrix.test.ts` example MUST be corrected

## Non-Functional Requirements

- NFR-001: Every decision (coverage, mutation plan, outcome classification, exemption parsing, owner-map selection) lives in the pure core; effects (copying the workspace, running the runner, reading reports) stay in the shell
- NFR-002: The checks are harness-agnostic: Claude Code and Pi Wave Gates produce the same verdict from the same workspace
- NFR-003: No new runtime dependency: mutation uses the TypeScript compiler API already in the engine's dependencies
- NFR-004: The mutation check's total time per Wave Gate is bounded by the per-Invariant cap times the per-mutant limit, and the bound is reported

## Success Criteria

- SC-001: On a fixture matrix test that omits one sibling, the gate blocks 100% of the time, naming that sibling; on one that imports all of them, it passes
- SC-002: On a vacuous fixture matrix test (asserts nothing about the owner), 100% of non-invalid mutants survive and the gate blocks; on a discriminating one, 0 survive
- SC-003: The mutant set for a fixture owner is byte-identical across 10 runs
- SC-004: Real workspace bytes are identical before and after every mutation-check test
- SC-005: Review packets for Tasks touching no owned family are byte-identical to their pre-feature bytes in 100% of packet tests
- SC-006: All acceptance scenarios pass through the real Wave Gate, plan validation, review-packet, brief, status and metric entry points
- SC-007: The metric's baseline for the three families is recorded in the docs at merge

## Out of Scope

- OOS-001: Consolidating any family's raw sites (the path-probe consolidation is the separate live pilot; shell and claim families follow later)
- OOS-002: StrykerJS or any external mutation dependency
- OOS-003: Mutating sibling entry points, unchanged owner lines, or files other than the owner module
- OOS-004: Mutation at SubagentStop (the stop hook's budget is reserved for I7)
- OOS-005: An owner map for standalone reviews, or a repository-wide owner registry
- OOS-006: Plan-qualified family ids (`<plan-slug>#INV-N`) for defect-family accounting
- OOS-007: Requiring a lint rule's exclude patterns to equal the owner module
- OOS-008: Deciding "identical versus divergent" mechanically; the reviewer decides and the Refutation Panel checks
- OOS-009: A rubric version change; the second-copy rule rides in the packet as an explicit project obligation under the existing rubric

## Dependencies

- G5a ownership grammar, path roles and family-change rule (#82)
- The Wave Gate registered program, completion suite and verification manifest (schema 2, frozen at population)
- Reviewer Protocol v2 Context Packets and their digest
- Structured test report parsing (JUnit, vitest JSON) and per-file results (#99)

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Owned Invariant | A plan INV whose ownership is `owned`: one owner module, its sibling entry points and a matrix test |
| Family change | G5a's rule (`changesFamily`) that a Wave changes an Invariant's family when its Tasks' files include the owner or a sibling entry point; a change to the matrix test alone is not a family change |
| Sibling coverage | The matrix test's import graph reaches the owner and every declared sibling entry point |
| Mutant | A copy of the owner module with one fixed operator applied to one site on a line changed in the Wave |
| Killed | The matrix test's report shows at least one failing testcase against the mutant, or the run timed out |
| Survived | The matrix test passes against the mutant |
| Invalid mutant | A mutant whose run shows only collection or import errors; a run of only invalid mutants blocks as `no-valid-mutants` |
| Mutation exemption | An owned Invariant's explicit, reasoned declaration that the mutation check does not apply |
| Second copy | An implementation of a declared-owned invariant's predicate outside its owner module |
| Family-site metric | The count of raw sites per known family outside its owner modules |

## Change Log

- 2026-10-21: initial spec from the G5 proposal, the G5a D7 deferrals and the operator's decisions on mutation tooling, survivor policy and hygiene scope
- 2026-10-23: glossary amendment (plan AD-4): "Family change" is the owner or a sibling entry point, matching G5a's `changesFamily`; the matrix test was wrongly included. No FR or AS changes
- 2026-10-25: PR #131 review remediation (ADR-0036, ADR-0037): AS-012 and FR-016 amended. A run whose every generated mutant is invalid blocks as the `no-valid-mutants` infrastructure failure instead of passing, and an owner with syntax errors blocks as `owner-unparseable`. No FR or AS added or removed
