# Executable Models: Enforcement

How the engine enforces the executable-model declarations a plan makes, and what that enforcement cannot see. This is maintainer and operator reference. The authoring rules an architecture agent follows (what to declare and the exact grammar) are in [`references/executable-models.md`](../references/executable-models.md); nothing here is needed to write a plan.

Contents: [Owner verification at the Wave Gate](#owner-verification-at-the-wave-gate) · [The second-copy lens](#the-second-copy-lens) · [The contract lifecycle](#the-contract-lifecycle) · [What the engine does with export bindings](#what-the-engine-does-with-export-bindings) · [Enforcement points](#enforcement-points) · [Known residuals](#known-residuals-honest-limits)


## Owner verification at the Wave Gate

Declaring an owner makes it an obligation the Wave Gate checks.

- **The stamp.** Population stamps every owned invariant into the TaskGraph
  as an **Owner Obligation** (`owner_obligations`: id, title, statement,
  owner, siblings, matrix test, mutation policy). The stamp is always
  written, `[]` included; only a graph populated before G5b lacks it, and such
  a graph owes nothing.
- **Plan integrity.** Whenever the graph carries the stamp, the completion
  suite gains the engine-reserved check `loom:owner-verification`. It re-reads
  the plan the graph names and blocks when there is no `plan_file`, the plan
  is unreadable, it has strays or malformed ownership, or the obligations it
  derives differ from the stamp (`plan-drift`: re-populate, or restore the
  plan). This runs even in a Wave that owes nothing.
- **Which invariants are checked.** Exactly the owned invariants the Wave
  owes: the owner is due (below), and some Wave Task other than a contract
  Task has the owner or a sibling in its `file_list`. A change to the matrix
  test alone does not trigger the checks. A contract Task writes at most a
  compiling stub of the owner, so its change owes nothing: verification
  starts with the first Wave whose implementation Task changes the family.
  Unowned invariants are never checked. One module decides this
  (`core/owner-verification/obligations.ts`).
- **Families grow Wave by Wave.** A family path is *due* by a Wave when no
  Task lists it (it exists already) or a Task of that Wave or an earlier one
  does. A sibling that only a later Wave lists is not yet due, so a plan may
  add siblings across Waves and update the matrix test in each. A due path
  the matrix test fails to reach still blocks. Population refuses a plan
  whose matrix test first lands after the first Wave that owes the family.
- **Sibling coverage.** The matrix test's direct imports — static `import`,
  side-effect imports, `import x = require`, string-literal `import()` and
  `require()` — plus everything reached through `export … from` re-exports,
  resolved to files through relative paths (the extension
  ladder `""`, `.ts`, `.tsx`, `.mts`, `.cts`, a `.js`-family specifier mapped
  to its TypeScript source, then `index.ts`/`index.tsx`) and the matrix test's
  tsconfig `paths`, must include the owner and every sibling due by the Wave.
  Direct imports and re-export chains of any length count; plain import
  chains are not followed, so a module that merely imports the owner does
  not credit it: siblings import the owner, so following them would make the
  owner "reached" through any sibling. Type-only imports and type-only
  re-exports are erased at runtime and never count. A miss
  blocks, naming every missing path, owner first. Bare package specifiers
  reach nothing; a walk reading more than 512 files is an infrastructure
  failure.
- **Mutation verification.** The owner's lines changed in the Wave — against
  the `start_sha` of the Wave Tasks listing the owner, or their octopus
  merge-base — are mutated by six fixed operators: condition negation,
  comparison flip, logical swap, boolean-literal flip, return-value
  replacement (`return undefined`) and expression-statement removal. Sites
  are found with the TypeScript compiler API; the set is deterministic, at
  most 24 per invariant (evenly spaced over the candidates, the rest
  reported as unmutated). Each mutant runs in one detached git worktree per
  invariant (HEAD plus every uncommitted, untracked and deleted path of the
  real workspace, `node_modules` shared by symlink, replacing any the
  checkout carries) through the frozen
  manifest's `affectedRunner`, with the matrix test as its only file and a
  time limit of 60 s clamped to the runner's own timeout. The matrix test
  must first pass unmutated: a red baseline blocks and runs no mutant. The
  runner's JUnit report decides each mutant: a failing testcase kills it, a
  timeout kills it, only collection errors make it invalid, a passing report
  means it survived. Any survivor blocks. A missing, unreadable or empty
  report, a spawn failure, or a passing report with a non-zero exit is an
  infrastructure failure that blocks and is never a kill. The real workspace
  is digested before and after, and any difference blocks
  (`real-workspace-changed`).
- **The runner.** Mutation verification needs a schema-2 verification
  manifest with an `affectedRunner` writing JUnit. Population refuses a plan
  with a non-exempt owned invariant and no such runner
  (`owner-verification-runner-missing`). An exempt invariant needs none.
- **Mutation exemption.** It disables only the mutation half; coverage still
  runs, and the exemption and its reason are recorded in the verdict and in
  status.
- **Where it shows.** The implementation brief of every Task that touches the
  family (as owner, sibling or matrix-test author) states the coverage duty
  and the mutation duty, or names the exemption. `helper orchestration
  status` reports each invariant's coverage and mutant counts, or the
  exemption, and a blocked gate's next action names the invariant and the
  remedy.

## The second-copy lens

A Wave review packet for the code-reviewer and the architecture-tech-lead,
for a Task that touches an owned family, carries an engine-issued **owner
map** (such a Task's Wave review roster appends the architecture-tech-lead to
the base five reviewers, ADR-0047, so both packets are issued): each touched invariant's id, title, statement, owner, siblings, matrix
test and `<plan file>#INV-N` contract, then the fixed second-copy rule. The
section is inside the packet digest. The rule: a diff that implements a
declared-owned invariant's predicate outside its owner is a finding citing
`<plan file>#INV-N`; it is critical when the copy diverges from the owner on
some input (that input is the consequence), advisory when it is behaviorally
identical. Severity rules and the Refutation Panel apply unchanged. Packets
for the other roles, for Tasks touching no owned family and for standalone
reviews are byte-identical to what they were.

## The contract lifecycle

1. **Population** persists each contract as an Acceptance Contract with its
   one contract Task (the only Task writing every frozen path) and freeze state
   `awaiting-red`. A plan with contracts is refused unless the verification
   manifest has a project check that writes a JUnit report — the only way RED
   and GREEN can be observed.
2. **The contract Wave's gate expects RED.** Every acceptance testcase must be
   collected (a file that fails to load is not a behavioral RED) and FAIL, and
   nothing outside the acceptance files may fail. Each testcase must name a
   covered Requirement, and each covered Requirement must have a testcase. The
   accepted gate stamps the **Acceptance Freeze**: the sha256 of every frozen
   path and the roster of testcases it observed red. The stamp lands at
   completion, after the advisory decision, so status lists the advisories on
   frozen paths at that pause (`acceptance-freeze-pending`). Fix the relevant
   ones before approving: abandon the run, reopen the contract Task
   (`helper orchestration reopen-task`), re-dispatch it, and start a fresh gate.
   Abandoning freezes nothing, so the fresh gate sees no drift. After approval,
   only a Contract Revision can change those bytes.
3. **Red window.** A testcase is *pending* until the Wave completing all its
   Requirements, and *due* from then on. A pending testcase's failure is
   excused only at the Wave Gate — never in a task's own run. So every task
   from the contract Wave through the last Wave completing a covered
   Requirement that has no regression waiver of its own (an authored waiver
   is kept) gets the engine-only regression waiver `acceptance-red-window`,
   and the Wave Gate's engine-run suite (which knows what is pending) is their
   regression authority. Every other failure still fails the gate.
4. **Claimant Waves expect GREEN by Requirement.** Each due testcase must be
   present and passing; a roster testcase that no longer runs fails the gate.
   With an `acceptanceRunner` in the verification manifest (schema 2), each
   claimant meets this earlier: the **Acceptance Stop Check** runs its owed
   testcases when its agent stops and keeps that agent working while one
   fails (`docs/operations.md`). It is advisory to the gate, never evidence.
5. **Frozen means frozen.** Every gate re-hashes the frozen paths before it
   reuses or installs a suite receipt; any drift blocks as an artifact
   failure. Task byte-scope proof already stops a task writing a path outside
   its `file_list`, and only the contract task lists the frozen paths.
6. **Contract Revision** is the one way to change frozen bytes: the operator
   edits them and runs `helper revise-contract --contract CT-n --reason "…"`.
   It is refused while a Wave Gate is live, before the freeze, before the
   contract Wave completes, while implementation is reserved, and while any
   claimant sits in a completed Wave (reopen that Wave first). It re-stamps
   the bytes, clears the roster so the next gate re-records it green, appends
   an audited revision, returns the current Wave's implemented claimants to
   revalidation, and retires the current Wave's review and suite authority.

## What the engine does with export bindings

**Population stamps** the bindings into the TaskGraph (`export_bindings`);
the brief refuses to render while the plan's bindings drift from the stamp.

1. **Contract stubs at the contract Task's stop.** Before its stop checks, the
   engine reads the contract Task's not-yet-frozen types file and writes a
   stub at every bound file of the contract, so the acceptance tests compile
   and fail by assertion. The contract Task never writes a stub, and a bound
   path is never in its `file_list`. An unresolvable binding writes no stub and
   is named in the stop output; the gate then sees an uncollected file, which
   is no behavioral RED. Freeze semantics are unchanged: a stub is no frozen
   path, and in its owning Wave it is a skeleton like any other.
2. **Skeletons at spawn.** When a Task is admitted, the engine resolves its
   bindings against the frozen types file (stage two: the bytes must equal the
   freeze stamp, and each alias must be a declared, non-generic function type),
   then writes a skeleton at each bound path that does not exist yet, before
   the attempt baselines are captured — engine bytes are never the
   implementer's write. A stage-two problem blocks the spawn
   (`skeleton-bindings-unresolved` in status) with every problem named. When
   status itself cannot read a skeleton path or types file it blocks nothing
   and names the gap under the `skeletons-unobserved` reason; registration
   reads them again and is the authority. An existing file is never
   overwritten.
3. **Canonical bytes.** TypeScript: a header comment, `import type` of exactly
   the bound aliases (specifier style copied from the frozen acceptance tests),
   and one `export const name: Alias = () => { throw new
   Error("unimplemented: <name>"); };` per binding. Java: one `public final
   class` named after the file, with a private constructor and one
   `public static final Alias name = (p0, …) -> { throw new
   UnsupportedOperationException("unimplemented: <name>"); };` per binding.
   Deterministic, never formatted.
4. **Completion conformance.** The `declared-artifact-changed` obligation fails
   `declared-artifact-contract-violated` when a bound export is `deleted`,
   `renamed`, `retyped` (no longer `export const name: Alias` / `static final
   Alias name` with the alias imported from the types file) or `still
   unimplemented` (the initializer still holds the exact marker string; any
   other throw is fine). Engine-written bytes never count as "changed".
5. **Contract Revision** refreshes every untouched skeleton to the revised
   types and leaves a modified one on disk flagged stale.
6. **Outcomes.** Every non-test `file_list` path gets exactly one outcome, in
   both the brief and status: skeleton written, no bound exports, contract has
   no types file, unsupported language, or exists, not skeletonized. A Distill
   Task holds no skeleton: its bound scope path that a sibling deleted is
   absent, no skeleton owed.

## Enforcement points

1. **`validate-task-graph`** (Phase 4a) cross-checks bindings fail-closed:
   every `LC-N` machine file appears in some task's `file_list`; the
   `AuthoredDag` sidecar exists, is structurally sound, AND every node named in
   the plan's `## Pipeline` table appears in the sidecar (a plan node absent
   from the sidecar is plan↔sidecar drift — the gate blocks it here rather than
   letting it reach fugue runtime; checked against the exact non-empty `id` of
   each node object, the narrow identity boundary Loom needs while Fugue retains
   ownership of deeper DAG-shape validation);
   every checkable `INV-N` rule file exists and is rule-shaped; every `INV-N`
   declares well-formed ownership, and an owned one's owner, siblings and
   matrix test each exist on disk or appear in a task's `file_list` (only
   ENOENT reads as absent), each path has one role, a task touching the family
   comes with a task touching the matrix test, and sibling tasks depend on the
   owner's task; near-miss declarations (typo'd headings/labels) are errors;
   an unreadable `plan_file` is an error, never a skipped check.
2. **`populate-task-graph`** — the only whitelisted helper that populates
   tasks into `active_task_graph.json` — runs the same binding checks before
   any state write, resolving the plan path from evidence-derived state
   (`plan_file`, else the recorded architecture phase artifact) in preference
   to the decompose payload, and persists the same path it validated. The 4a
   run advises the orchestrator; this one is the gate.
3. **`validate-lint-rules`** proves invariant rules load through the linter's
   fail-closed loader (malformed JSON, missing fields, ReDoS-unsafe patterns
   all fail) before implementation starts.
4. **PostToolUse `lint-file`** enforces checkable invariants on every edit,
   forever — they outlive the feature that introduced them.
5. **`complete-wave-gate`** verifies as evidence that every lifecycle machine
   file bound to a completing wave's tasks actually exists on disk — the
   decompose-time promise is re-checked when the wave claims it delivered.
   The plan is resolved from state `plan_file`, falling back to the recorded
   architecture phase artifact; a named-but-unreadable plan fails the gate.
   Only when state carries neither (legacy flows that never ran the
   architecture phase) is the check skipped, and it says so.
6. **The Wave Gate's completion suite** judges every Acceptance Contract the
   Wave owes something (RED in the contract Wave, GREEN by Requirement after),
   installs only the accepted receipt, and blocks on frozen-path drift before
   reusing any receipt. The Acceptance Freeze is stamped from that receipt by
   the locked completion commit, in the same write as the completed-Wave
   history entry, so an abandoned run freezes nothing (ADR-0044).
   Whenever the TaskGraph carries `owner_obligations`, the same suite runs
   `loom:owner-verification`: the plan re-read, then sibling coverage and
   mutation verification for each owned invariant the Wave owes (see "Owner
   verification at the Wave Gate").

## Known residuals (honest limits)

- **Sibling completeness is declared, not proven.** Validation checks that
  every declared path is real and correctly ordered; it cannot know an entry
  point the plan forgot. Plan alignment (`OWN-N`) and review catch omissions.
  Sibling coverage proves the matrix test imports every *declared* entry
  point, and mutation verification proves it kills mutants of the owner; a
  forgotten entry point stays invisible to both.
- **An import is not proof of exercise.** Sibling coverage is a static import
  check: a matrix test that imports a sibling but never calls it through the
  rule passes coverage. Only imports that load the module count: a type-only
  import or re-export (`import type`, `export type … from`, every specifier
  `type`) is erased at runtime and reaches nothing. Mutation verification mutates the owner only, never a
  sibling, so a sibling that bypasses the owner is caught only by a matrix
  test that really drives it — and by the second-copy lens in review.
- **Mutation covers the owner's changed lines only.** Unchanged owner lines,
  siblings and every other file are never mutated, and a Wave that changed
  only a sibling runs the baseline but zero mutants (`owner unchanged in
  Wave`). Only constructs the six fixed operators can rewrite count; at most
  24 mutants run per invariant and the rest are reported as unmutated.
- **Invalid mutants are neither killed nor survived.** A mutant whose run
  shows only collection or import errors is counted `invalid`, and the
  verdict and status report the invalid count. A run whose every generated
  mutant is invalid carries no mutation evidence, so it blocks as the
  `no-valid-mutants` infrastructure failure rather than passing.
- **A matrix-test-only change triggers nothing.** The checks run when the Wave
  owes the family; a Wave touching only the matrix test owes no coverage or
  mutation run (the plan is still re-read).
- **A contract Task's stub is trusted to be a stub.** A contract Task's change
  to an owner owes nothing, and lines it wrote are part of the base a later
  Wave's mutants are planned from. A contract Task that put real logic in an
  owner would leave that logic unmutated; contract review and the frozen
  acceptance tests, not owner verification, guard against it.
- **The second-copy lens is review judgment.** Whether a copy diverges or is
  identical is the reviewer's call, checked by the Refutation Panel; an
  identical copy is advisory, so it does not block a Wave by itself.
  Standalone reviews carry no owner map at all: there is no TaskGraph to read
  obligations from, and there is no repository-wide owner registry.
- **"The matrix test exists" is not "the matrix test is complete".** A test
  that covers only well-formed input still satisfies the path check; mutation
  verification narrows this only for the owner's changed lines.
- **RED/GREEN is not discrimination.** A frozen acceptance test that a wrong
  implementation also passes still turns green. G5b's mutation verification
  runs against owned invariants' matrix tests, not against frozen acceptance
  tests, so this residual stands for contracts.
- **Mutation evidence is JUnit only.** The `affectedRunner` report is read as
  JUnit; testcases are attributed to the matrix test by reported file. A
  runner writing another format makes every run an infrastructure failure.
- **The family-site metric is a gauge.** `helper family-sites` counts line
  regex hits per known family outside its owners; a pattern can miss a
  reworded copy or count an innocent line. It blocks nothing.
- **Acceptance is observed through JUnit only.** Testcases are attributed by
  file (Vitest's relative `classname`, or a JVM class name) and by the
  `FR-n:`/`AS-n:` name prefix; a report in another format cannot carry a
  contract.
- **A non-zero exit is excused from the report alone.** The gate excuses a
  check's non-zero exit when every failing testcase in its JUnit report is a
  RED or pending acceptance testcase. A cause that never appears as a failing
  testcase — a coverage threshold, a chained lint or typecheck step, a crash
  after the report was written — is invisible to that judgment and would be
  absorbed. So the test runner must be its own project check, or the last
  step of one, with no thresholds that fail the exit code: then the report
  accounts for every way the exit can go non-zero. A runner followed by
  other steps also stops at the failing test step in the contract Wave, so
  those later steps would go unobserved there.

- **Import discipline is advisory-plus-lint.** "Dependents import the machine,
  never re-implement transitions" is enforced only where a paired checkable
  invariant (e.g. a no-raw-state-literals rule) can catch the violation;
  otherwise it is prompt guidance verified by wave-gate reviewers, not by the
  deterministic core. Mandating auto-generated rules from state lists is
  future work.
- **Generated-code STRUCTURE hand-edit protection is tamper-EVIDENT (integrity hash).**
  `fugue new --from` stamps each generated `dag.ts` with a banner whose
  `@fugue-integrity sha256:<hex>` covers the STRUCTURAL PROJECTION of the body —
  the generated body with each `@fugue-body-start … @fugue-body-end` region
  collapsed. So the machine-owned structure (imports, schemas, node ids, wiring,
  registration) is hashed, but the placeholder node bodies the scaffold tells you
  to implement live inside `@fugue-body` regions and are EXCLUDED — implementing
  them leaves the hash intact (no false positive on the sanctioned workflow).
  Loom ships the `fugue-generated-integrity` programmatic lint rule, which runs
  in the "full"/wave-gate tier ONLY (PostToolUse `lint-file` runs the regex
  rules plus the immediate-tier programmatic rules, and this rule is not one
  of them), recomputes the hash over
  the same projection, and blocks on a mismatch, so a structural hand-edit during
  a loom wave is caught at the wave gate — the same detection-at-gate mechanism as
  every other lint rule, needing no path-based edit gate (which loom's model does
  not have). The tamper-evidence window is a wave, not a single tool call. The
  coupling is the marker convention (`@fugue-integrity sha256:` + the two
  `@fugue-body` strings + the collapse rule): fugue stamps it, loom verifies it,
  neither imports the other. Residual (honest): the target is an ACCIDENTAL
  structural edit. Removing the banner outright, or wrapping hand-edited structure
  in fake `@fugue-body` markers, both disable the check for that file and are
  equivalent deliberate circumventions — but `--from --force` regeneration
  overwrites the edit (a fixed point). Fugue itself does not re-verify the stamp;
  the detection lives in loom's rule.
- **Wave-gate artifact verification is existence, not semantics.** The machine
  file must exist; that it exports a real reducer is verified by its property
  tests and the trusted test-evidence machinery, not by the gate. An empty
  file at the declared path passes the gate and fails at test evidence.
- **Report artifacts are agent-writable.** A trusted-pass verdict rests on a
  report artifact (vitest JSON / JUnit XML) that the agent's own tools can
  write. The recorder rejects an explicit `--outputFile` path that appears as
  a `FileWrite` in the agent's own epoch (loudly) — Edit/Write tool calls AND
  Bash redirect/`tee` targets both mint `FileWrite`, including targets of the
  very command line being judged — and report freshness is call-scoped: a
  disk artifact may vouch only when its mtime is at/after the START of the
  tool call being judged (the PreToolUse call-start stamp orders it), so a
  previous-epoch or pre-staged artifact fails the ordering check. The
  remaining residuals (see machines/README.md "known residual limits") are
  same-call staging via a Bash write with no static target in the command
  text (`cp`/`mv`, `dd of=`, an interpreter-authored file via
  `python -c 'open(...)'`) and a "test" script that itself emits runner-shaped
  JSON. Full integrity (HMAC / out-of-reach storage) is the known follow-up.
