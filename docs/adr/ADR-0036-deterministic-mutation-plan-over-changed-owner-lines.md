# ADR-0036: Deterministic mutation plan over changed owner lines

## Status
Accepted (2026-10-23). Shipped with the G5b owner-enforcement feature
(`.claude/specs/2026-10-21-g5b-owner-enforcement/spec.md`, FR-009..FR-012, FR-017, SC-003, NFR-003, NFR-004;
plan `.claude/plans/2026-10-21-g5b-owner-enforcement.md`, AD-6; interview Q3b).

## Context
G5a gave each owned Invariant one owner module and one matrix test. Sibling coverage (ADR-0035) proves
that the matrix test imports the owner and every sibling entry point. It does not prove that the matrix test
checks the owner's behaviour. A matrix test can import everything and still pass whatever the owner does.
G5b closes that gap with mutation verification: the gate changes the owner's code and requires the matrix test
to fail. A mutant that survives blocks the Wave Gate.

Several forces shape how the mutants are chosen:

- **Determinism (SC-003).** The gate's verdict is evidence the Wave Gate settles on. The same owner bytes, the
  same changed lines and the same cap must give the same mutants, in the same order and with the same
  identities. A re-run must never turn a pass into a block, or a block into a pass, by chance.
- **No new dependency (NFR-003, OOS-002).** The engine already ships `typescript` (a runtime dependency loaded
  by the INV-1 seams; see ADR-0042). It must not pull in a mutation framework with its own runner, configuration and
  reporter model.
- **Bounded cost (NFR-004).** Every mutant is a full run of the matrix test through the operator's frozen
  `affectedRunner`. An owner can offer hundreds of mutation sites, so the work per Invariant needs a hard cap,
  and the operator must see the worst-case time before it is spent.
- **Scope to the Wave's work (FR-017).** A Wave answers for the owner lines it changed, not for the whole
  owner's history. Mutating unchanged lines would make every Wave that touches a family pay again for code
  verified long ago, and would block Waves on survivors they did not write.
- **No policy from the plan.** Operators, cap and time limit must be engine-fixed, so a plan cannot weaken the
  check by choosing a smaller cap or a softer operator set. The only plan-level escape is an explicit mutation
  exemption with a reason (ADR-0033).

## Options Considered

1. **StrykerJS (or another off-the-shelf mutation framework)**
   - Pros: a mature operator catalogue; a known tool with its own reporting.
   - Cons: a new dependency tree, ruled out by OOS-002 and NFR-003. It brings its own test-runner integration,
     sandbox and configuration, which would compete with the frozen `affectedRunner` as the one authority over
     how tests run. Its mutant selection and identities belong to the tool, not the engine, so determinism and
     the per-Invariant cap would depend on outside versions. It also mutates whole files by default, while the
     scope needed here is changed lines only.

2. **Random sampling of candidate sites up to a cap**
   - Pros: even coverage on average; simple to write.
   - Cons: not deterministic. Two runs over the same bytes choose different mutants, so a survivor can appear
     or vanish between gate attempts (it breaks SC-003). A fixed seed would only hide the randomness. The
     selection would still be hard to explain from the code alone.

3. **First-N selection (the first `cap` candidates in source order)**
   - Pros: deterministic and simple.
   - Cons: mutants cluster at the top of the file. A large change gets its imports, early guards and helpers
     mutated, while the logic further down is never touched. The cap then decides which part of the change
     goes unchecked, which is a silent blind spot.

4. **Engine-owned plan: a fixed operator set over a TypeScript AST, limited to changed lines, with an evenly
   spaced selection under an engine cap (chosen)**
   - Pros: deterministic for the same owner bytes, changed lines and cap. It uses the `typescript` package the
     engine already ships. All policy (operators, order, cap, time limit) is engine constants. The selection
     covers the whole changed region. Mutant identities are content-addressed, so a survivor can be named in
     diagnostics.
   - Cons: a small, fixed operator catalogue (six operators) that is weaker than a full framework's; TypeScript
     owners only; the engine owns the operator code and its edge cases (see Consequences).

## Decision
**The engine computes a deterministic mutation plan per owed, non-exempt Invariant: six fixed AST operators,
applied only at sites on owner lines changed since the Wave base, selected by even spacing under a cap of 24,
each mutant run with a time limit of at most 60 s.**

### The plan (pure core)
`engine/src/core/owner-verification/mutation-plan.ts` exports
`mutationPlan({ ownerPath, ownerText, changedLines, cap }): DomainResult<MutationPlan, OwnerUnparseable>` and
`applyMutant(ownerText, mutant)`. It is one of the two INV-1 seams allowed to import `typescript` (the other is
`import-graph.ts`). It parses already-read text through `parseModule(ownerPath, ownerText)`, exported by
`import-graph.ts`: `ts.createSourceFile` with the script kind the owner path's extension names, so a `.tsx` or
`.jsx` owner is parsed with JSX, the same rule the coverage import graph uses. No `ts.sys`, no Program, no
language service, no filesystem. An owner the parser reports syntax errors for has no plan: the result is
`owner-unparseable` with every diagnostic (`line:column message`), which the shell records as that
infrastructure failure instead of mutating a recovered tree.

- **Operators.** The fixed order is: 1. `condition-negation` (the condition of `if`, `while`, `do`, `for` and
  `?:` becomes `!(…)`); 2. `comparison-flip` (`<`↔`>=`, `>`↔`<=`, `===`↔`!==`, `==`↔`!=`); 3. `logical-swap`
  (`&&`↔`||`); 4. `boolean-literal-flip` (`true`↔`false`, never inside a literal type node);
  5. `return-value-replacement` (the value of a non-empty `return e` becomes `undefined`, unless `e` is
  already the identifier `undefined`); 6. `statement-removal` (an expression statement becomes `;`, except
  directive-prologue strings of a file or function body). The union `MutationOperator` in
  `core/owner-verification/types.ts` names exactly these six.
- **Candidates.** Each node, walked in pre-order, offers its sites in operator order. **Shipped behavior:** a
  site is a candidate when the *replaced span* starts on a changed (1-based) line. For example, a comparison
  flip uses the operator token's line, and a condition negation uses the condition expression's line. The plan
  said "the node's first token", but the replaced span is the more precise anchor for a multi-line
  expression.
- **Order and selection.** Candidates sort by `(start, operator order, end)`. The plan's sort key had no `end`;
  the shipped code adds `end` as a final tie-break, so the order is total. With `n` candidates and `n > cap`, the
  selection is the indices `floor(i * n / cap)` for `i < cap`. Otherwise every candidate is selected.
- **Mutant.** Each `Mutant` is `{ id, operator, line, column, start, end, original, replacement }`. `[start, end)`
  is the UTF-16 span and `line` / `column` are 1-based. `id = sha256Hex(JSON.stringify([ownerPath, start, end,
  operator]))`.
- **Plan type.** `MutationPlan` is branded and carries `{ mutants, candidates, cap }`. Only `mutationPlanOf` builds
  one, and it refuses a `candidates` that is not a count, more mutants than candidates, and more mutants than
  the cap. **Shipped behavior:** `unmutated` is derived as `candidates - mutants.length` and never stored, so it
  cannot disagree with the plan. `MutantCap` is also branded: `parseMutantCap` (a positive integer) and the
  engine constant are its only sources.
- **Constants.** `MUTANT_CAP_PER_INVARIANT = 24` and `MUTANT_TIMEOUT_MS = 60_000`.
  `mutantTimeoutMs(runnerTimeoutMs) = min(60_000, runnerTimeoutMs)` clamps the limit to the frozen
  `affectedRunner.timeoutMs`.

### Changed lines
`changedHeadLines(base: string | null, head: string): ReadonlySet<number>` in `engine/src/core/unified-diff.ts`
returns the 1-based head lines that the edit script `base → head` inserts. These are exactly the `+` lines of
`unifiedDiff`, from the same edit script, so the two cannot drift apart. A `null` base (a new file) marks every
head line changed. A deletion changes no head line. A final line that gains or loses its newline counts as
changed.

### The Wave base (execution shell)
The decisions are pure: `waveBaseOf` and `ownerTasks` in `engine/src/core/owner-verification/wave-base.ts`
choose the base and the owner Tasks. `engine/src/orchestration/owner-verification-runner.ts` (`planMutation`,
`resolveWaveBase`, `ownerAtBase`) only runs the Git calls they ask for. Together they resolve the inputs:

- The owner Tasks are the Wave's Tasks whose `file_list` names the owner. With none, the plan is `null`: zero
  mutants, and the verdict and status say `owner unchanged in Wave` (AS-014). **Shipped behavior:** the
  unmutated baseline run of the matrix test still runs in this case, so a red matrix test still blocks.
- With one distinct `start_sha`, the base is that commit (`git rev-parse --verify`). With several, it is
  `git merge-base --octopus` of them. A missing or empty `start_sha` on any owner Task, or a base that cannot be
  resolved, is the `missing-wave-base` infrastructure failure.
- The owner's bytes at the base come from `git ls-tree` / `git cat-file`. An empty listing means the owner did
  not exist at the base (`null` base, every line changed). An owner that cannot be read in the workspace is
  `plan-drift`.

### Runs and the reported bound
The runner forms the command only from the frozen `affectedRunner`, through `affectedRunnerCheck` with the
matrix test as its only file. It then re-authorizes the command with the clamped time limit, so no command text
comes from the plan. In one isolated worktree (AD-8), the baseline runs first. Only if the baseline is green
does each mutant run, in plan order. The first infrastructure failure ends the run.
`mutationBoundMs` in `engine/src/core/owner-verification/verdict.ts` reports the bound as the sum, over owed
obligations with `mutation.kind === "verify"`, of `(1 baseline + selected mutants) × mutantTimeoutMs(runner.timeoutMs)`.
An owner-unchanged obligation therefore counts one baseline run. At most this is 25 runs × 60 s = 25 minutes per
Invariant. `docs/operations.md` ("Owner verification blocks a Wave Gate (G5b)") documents the operator-facing
contract.

### Tests
`engine/tests/core/owner-verification-mutation-plan.test.ts` and `engine/tests/core/unified-diff-changed-lines.test.ts`
cover the plan and the changed-line set, alongside the CT-1 acceptance tests
(`engine/tests/acceptance/owner-verification-core.acceptance.test.ts`).

## Consequences

**Positive:**
- Deterministic (SC-003). The plan is a pure function of owner path, owner bytes, changed lines and cap, and
  mutant ids are content-addressed. Re-running a gate reproduces the same mutants, and a survivor diagnostic
  (`<owner>:<line>:<column>`, operator, original and mutated text) names something stable.
- No new dependency (NFR-003). The operators are about 150 lines over the `typescript` parser the engine
  already loads, and execution reuses the frozen `affectedRunner` and its JUnit report.
- The plan sets no policy. Operators, order, cap and time limit are engine constants, and the brands on
  `MutantCap` and `MutationPlan` make an over-cap or inconsistent plan impossible to construct.
- Cost is bounded and visible before it is spent (NFR-004). It is at most 24 mutants plus one baseline per
  Invariant, each at most 60 s, and status reports the total.
- Even spacing covers the whole changed region instead of its first lines, and `unmutated` is reported so the
  operator can see what the cap left out.
- Scoping to changed lines makes a Wave answer only for the code it wrote. Waves that change only a sibling or
  the matrix test pay for one baseline run, not a full mutation pass.

**Negative:**
- The operator set is deliberately small. Arithmetic operators, string and number literals, optional chaining,
  call removal inside larger expressions and many other mutations are not generated. A matrix test can kill
  all six operator kinds and still miss real defects, so mutation verification is a floor, not proof of
  adequacy.
- A changed line with no construct the six operators rewrite yields zero mutants and passes. The verdict says
  so, but the line goes unchecked.
- Changed-line scope means an old weakness in unchanged owner code is never mutated. A Wave can also change
  code in a way that weakens older lines' behaviour without any of those lines counting as changed.
- Over the cap, some changed sites are never mutated. Even spacing is fixed, so the same sites are skipped
  every time for the same bytes. A survivor among them stays hidden until the owner text shifts.
- The plan parses an owner with the script kind its extension names (TypeScript, TSX, JavaScript, JSX). As
  shipped in #127 every owner was parsed as `ScriptKind.TS`, so a `.tsx` owner's JSX was garbled; the PR #131
  review remediation shares the import-graph seam's rule. Owners in other languages are out of scope, and an
  owner with syntax errors blocks as `owner-unparseable`. The parser's diagnostics are read from a property
  outside TypeScript's public typings, so a TypeScript that stopped exposing them would fail every owner
  closed, and the mutation-plan tests would show it.
- The worst-case cost is real: 25 minutes per Invariant at the default limit, summed over every owed Invariant
  in the Wave. The clamp to the runner's own `timeoutMs` keeps it within the operator's limit but can make
  slow mutants count as timed-out kills.
- The Wave base depends on `start_sha` being recorded on every owner Task. A missing one is a blocking
  infrastructure failure, not a fallback to the whole file, so old or hand-edited graphs fail closed.
- Two documented deviations from the plan text (the candidate line comes from the replaced span, and `end` is a
  final sort tie-break) must remain consistent with this ADR if the operators change.
