# Plan: G4 slice 2: the oracle inside the loop (I6 red-then-green, I7 affected-test stop check, Pi ledger capture)

**Spec:** .claude/specs/2026-10-16-g4-slice-2-oracle/spec.md
**Created:** 2026-10-16

## Summary

Slice 2 adds three things.

- **I6, a fail-closed red-then-green proof obligation.** It is judged at completion by a pure function. The inputs are the epoch's ordered ledger facts, and TestRun facts now carry per-file results taken from the structured report.
- **I7, a fail-open affected-test stop check.** The one shared stop-check planner plans it next to the acceptance check, and one stop shell runs both checks in sequence under one lock and inside one 300 s budget.
- **A Pi evidence ledger recorder.** The operator chose this at architecture interview Q1. It mints the same facts as Claude Code's recorder, through one shared minting rule.

The approach chosen at the gate is Approach 1, facts plus two judges behind one planner. Interview answers: Q1 C, Q2 A, Q3 A, Q4 A, Q5 A, Q6 A, Q7 A, Q8 A.

**Rollout constraint (binding on every Task).** Loom runs its hooks live from this checkout. A Task that edits a hook-imported engine file lands its whole change set in one commit. No two Tasks in one Wave edit the same hook-imported file. The hook-imported files are those under `engine/src/machine/`, `engine/src/handlers/`, `engine/src/state-file-wire.ts`, `engine/src/core/verification-manifest.ts`, `engine/src/core/proof-obligations.ts`, `engine/src/core/acceptance-contract/*` and `pi/*`. Signature changes on a module that a later-Wave Task's consumer still calls are additive: the old export stays, implemented through the new one, until the consumer's Task removes it (AD-9).

---

## Architectural Decisions

### AD-1: Approach 1: facts plus two pure judges behind one planner

**Choice:** TestRun facts gain per-file results. I6 is a pure judgment over ordered epoch facts, read at completion time. I7 is planned by extending the existing single planner, and one stop shell runs both checks.
**Why:** This is the only approach that keeps FR-012 (judgments are computed at read time from facts) and FR-027 (one pure decision point for both checks) together. It reuses `testcaseAcceptanceFile`, `acceptanceRunnerCheck`, the runner lock, and exact settlement.
**Rejected:**
- Persisting the I6 judgment on the Task at stop. That stores a derived judgment, violating the facts-only doctrine, and it adds wire schema.
- A sibling I7 planner and shell. That violates FR-027 and moves lock, budget and message composition into dispatch.

### AD-2: Per-file results live inside the report summary, behind one reconcile function

**Choice:** `TestReportSummary` gains `files: TestReportFiles`, where:

```
TestReportFiles = { kind: "unrecorded" } | { kind: "recorded"; results: readonly TestFileResult[] }
TestFileResult  = { file: string; executed: number; failed: number; collectionError: boolean }
```

`file` is the report's identity exactly as written: the JUnit testcase `classname`, or a Vitest JSON `testResults[].name`. The capture cwd never rewrites it (FR-002).

One pure function, `reconcileFileResults(summary, results)`, checks that the per-file counts agree with the summary under each format's counting rule. It runs in the parsers, in `mergeSummaries`, and in the ledger read-back.

A ledger `report` whose `files` is malformed or does not reconcile makes the whole report `null`, so the run is untrusted (interview Q3 A, which matches how `parseReportField` treats bad counts today). A missing `files` reads as `unrecorded` (AS-003).

A collection error is distinguishable from a behavioral failure in both formats:
- JUnit: Vitest's synthetic testcase whose `name === classname`, the existing convention.
- Vitest JSON: a failed `testResults[]` entry with no `assertionResults`.

**Why:** The facts stay facts, and one smart constructor gates the shape for every producer, both harnesses included.
**Rejected:**
- A separate ledger event kind. It needs a second dedup and fold path.
- Dropping only the per-file part on malformed data (Q3 C). That keeps a half-trusted report alive.

### AD-3: Report file to `file_list` attribution is one neutral pure module, applied at read time

**Choice:** Move `testcaseAcceptanceFile` from `core/acceptance-contract/gate.ts` into a new `engine/src/core/report-file-attribution.ts`, as `attributeReportedFile(declared, reported, repositoryRoot)`. It keeps the existing unique-suffix and JVM-class rules, and adds one rule: an absolute reported path is made repository-relative before matching.

`gate.ts` re-imports it. The I6 judge and the I7 failure renderer call it (interview Q2 A).
**Why:** A single mapping (INV-5). The neutral module also avoids the `acceptance-contract` barrel import cycle described in the `stop-check-planner.ts` header.
**Rejected:**
- Mapping at capture. That stores a judgment.
- Accepting path-shaped identities only. That makes JVM Tasks unable to satisfy I6.

### AD-4: The I6-era marker is the frozen test-file classification

**Choice:**
- **Manifest source.** Schema 2 gains two optional keys:
  - `affectedRunner`, with the same form checks as `acceptanceRunner`, `{files}` as one whole argument, a `required-file` JUnit report beneath `.loom/completion-reports/`, `timeoutMs <= MAX_AFFECTED_RUNNER_TIMEOUT_MS = 120_000`, and a report path distinct from `acceptanceRunner`'s and every Wave check's;
  - `testFileSuffixes: NonEmpty<string>`.
- **Frozen manifest.** Every freeze made after this feature carries `testFiles: { source: "operator-manifest" | "engine-default"; suffixes: NonEmpty<string> }`. It enters the manifest digest. `affectedRunner` enters the digest only when it is declared.
- **Freeze cases.** Population always freezes a manifest. `populate-task-graph.ts` reads `.loom/verification-manifest.json`; when the read fails with ENOENT, it freezes `defaultVerificationManifest()`, and `task-graph-population.ts` writes the result as `verification_manifest`. So no post-feature TaskGraph lacks one. T5 makes every freeze path carry `testFiles`:
  - a schema-2 operator manifest with `testFileSuffixes` freezes `{ source: "operator-manifest", suffixes }`;
  - a schema-2 operator manifest without the key, and any schema-1 manifest, freeze `{ source: "engine-default", suffixes: DEFAULT_TEST_FILE_SUFFIXES }`;
  - no manifest file at all freezes `defaultVerificationManifest()`, which now also carries `{ source: "engine-default", suffixes: DEFAULT_TEST_FILE_SUFFIXES }`.

  Only TaskGraphs frozen before this feature lack `testFiles`: those carrying a pre-feature frozen manifest, and those carrying none.
- **Legacy default stays.** `defaultVerificationManifest()` is also the read-time fallback for old graphs that carry no `verification_manifest` (`state-file-wire.ts` suite-receipt digest check, `wave-completion-suite-readiness.ts`). Their receipts were stamped with the old default's digest, so T5 splits the function:
  - `defaultVerificationManifest()` is the population freeze and carries `testFiles`;
  - `legacyDefaultVerificationManifest()` keeps today's bytes and digest exactly, and the two read-time fallbacks switch to it.

  An old graph therefore keeps both its receipts and its `not-owed` era. `parseFrozenVerificationManifest` admits `testFiles` as an optional key and re-checks the digest with it included only when present.
- **Obligation derivation.** `deriveProofObligations` takes `redThenGreen: RedThenGreenEra`, defined as `"owed-if-new-tests" | "not-owed"`. Only `redThenGreenEra(manifest: FrozenVerificationManifest | undefined): RedThenGreenEra` in `engine/src/core/proof-obligations.ts` computes it, from the presence of `testFiles` (INV-6). Population, the `state-file-wire` obligation-match check, `task-revalidation` and the reconcile helper all call `redThenGreenEra(graph.verification_manifest)`. None of them tests `testFiles` presence inline.

An old TaskGraph has no `testFiles`, so its re-derived obligations stay exactly as they were (FR-005). Claimants already carry `newTests: waived(covered-by-acceptance-contract)`, so they are never obligated (FR-010).
**Why:** The frozen classification already has to exist (FR-014), and its presence is exactly "populated after this feature", so no second marker field is needed. Digest changes reach only new freezes (FR-016, AS-019).
**Rejected:**
- A separate TaskGraph boolean. It duplicates what the frozen manifest already says.
- Deriving from the TaskGraph schema version. That would obligate unrelated older graphs.

### AD-5: I6 judgment shape and qualifying runs (interview Q7 A)

**Choice:** `judgeRedThenGreen(facts, classification, repositoryRoot, untrustedEvidence)` returns `RedThenGreenObservation` (CT-1 types).

- **Qualifying run.** A TestRun with `exit !== null`, a non-null `report`, and `report.files.kind === "recorded"`. Both harnesses produce these.
- **Red.** The first qualifying run in which some Task test file has `failed > 0` and is not `collectionError`-only (FR-007).
- **First implementation write.** The first FileWrite, `via` tool or shell, to a Task implementation file (FR-013, AS-010).
- **Green.** A qualifying run after that write with `exit === 0`, in which every Task test file is attributed, each with `executed >= 1`, `failed === 0`, and no collection error.

Gaps are reported with this precedence:

```
no-test-files
  > implementation-write-missing
  > red-missing | red-after-first-implementation-write
  > green-missing
```

`red-missing` and `green-missing` each carry `untrustedOnly: boolean`. It is true when the step is unmet by qualifying runs, but the epoch holds a non-qualifying TestRun or the Task's test result has `pi-structured` provenance (AS-011, AS-038).

**Why:** The spec glossary is literal: "trusted" means an exit code plus a parsed report. Requiring every Task test file in the green run stops a subset run from greening the Task.
**Rejected:**
- `judgeTestRun`'s trust verdict, which accepts a null exit.
- Green as a whole-run pass only.

### AD-6: I6 enters proof as one obligation, one failure variant and one evidence variant

**Choice:**

```
ProofObligation += { kind: "red-then-green" }
ProofFailure    += { kind: "red-then-green-unproven"; gap: RedThenGreenGap }
ProofEvidence   += { kind: "red-then-green"; red: RunRef; implementationWrite: string; green: RunRef }
ObservedProofEvidence += redThenGreen?: RedThenGreenObservation
```

A missing observation evaluates as `ledger-unavailable`.

The judgment input comes from a `LedgerObservation`:

```
LedgerObservation = { kind: "read"; events: readonly Evidence[] } | { kind: "unreadable"; reason: string }
```

It is added to `ExactImplementationTransportFacts`.

- **Claude.** It comes from the epoch events that `update-task-status` already folds.
- **Pi.** It comes from the child's epoch (AD-8).

An `unreadable` ledger becomes an `implementation-observation-unavailable` infrastructure failure, so it does not consume semantic retry budget. `reconcileTaskFromStoredEvidence` has no ledger, so it carries forward a prior satisfied `red-then-green` result, the same way it carries forward `taskCompletionWasObserved`, and otherwise observes `ledger-unavailable`.

`proofFailureKind` mints `proof:red-then-green-unproven:<gap>`.
**Why:** Every I6 failure becomes a distinct named proof failure (FR-009), and settlement retries it through the existing semantic path. The judgment is decided at completion only (FR-011).
**Rejected:** Reusing `new-tests-not-observed`. It cannot name the step.

### AD-7: The brief states I6 up front and names the repair on retry (interview Q6 A)

**Choice:** `core/implementation-brief.ts` renders an "I6 red-then-green" section for every Task that owes the obligation. The section covers:
- the Task's test files and implementation files, from the classification;
- the required order;
- the fact that only ledger runs with a structured report count, naming the manifest's report-producing command form.

A retry whose lineage `failureKinds` contains `proof:red-then-green-unproven:*` adds the remedy:
- restore the Task's implementation files to the attempt baseline with `git restore --source <start_sha> -- <files>`, which is a Bash call that mints no FileWrite;
- run the tests and observe red;
- then implement.

I6 is judged per attempt epoch.
**Why:** The order lies in the past, so a retry that does not restore can never show red. Telling the first attempt the rule up front avoids burning a retry.
**Rejected:**
- Judging across attempts, where another agent's red would count.
- Leaving the agent to discover the rule.

### AD-8: Pi ledger capture through one shared minting rule (interview Q1 C)

**Choice:**
- **Shared pure core.** `extractEvidence` is refactored to take a normalized `HarnessToolCall`:

  ```
  { tool: "Read" | "Write" | "Edit" | "MultiEdit" | "Bash" | "Other"; input; outcome: { failed; exit; stdout; interrupted }; callId; cwd }
  ```

  It stays in `machine/extract-evidence.ts`, which is already on the pure list. `extractShellWriteTargets` adds literal `mv`, `git mv` and `cp` destinations (FR-034, interview Q4 A).
- **Shared shell.** A new `engine/src/machine/tool-evidence-recorder.ts` holds `recordToolEvidence(target, call, ports)`. It is the only caller of `extractEvidence` and of `.appendEvidence` (INV-4). It wires `findReport` with the agent-authored-artifact veto and the call-start stamp, resolves FileWrite paths against `call.cwd`, and appends to the ledger.
- **Claude adapter.** `handlers/post-tool-use/record-evidence.ts` keeps attribution (`attributeEvidence`), maps the hook payload to `HarnessToolCall` with `claudeToolCall`, and calls the shared shell.
- **Pi adapter.** A new `pi/evidence-recorder.ts`:
  - **Tool mapping.** `piToolCall(event)` maps Pi's lowercase tool names through the existing `TOOL_NAME_MAP`. The bash exit is `details.exitCode` when it is numeric, otherwise `isError ? 1 : 0` (FR-033). A probe step in T6 confirms Pi 0.83's `tool_result` shape and records it in a code comment.
  - **Ledger address.** `IssuedWriteGrant` gains `evidenceLedger: { sessionId: SessionId; agentType: AgentType }`, minted by the parent at spawn from its own session and the spawn item's agent. The child records into the parent's ledger under `epochOf(grant.agentId, agentType)`. One child process is one agent, so attribution is exact by construction. A child with no grant or a rejected grant records nothing and writes a stderr note (AS-039).
  - **Stamps.** The `tool_call` handler keeps writing call-start stamps under the child's own session, and the recorder reads them there.
  - **The write grant is not a lifecycle (executable-models policy).** It is pre-existing, bounded mechanics, already owned by `pi/write-grant.ts` (issue, consume, revoke) and `pi/child-write-grant.ts`, whose `ActiveChildWriteGrant` ADT and `rejectedSessions` set cover activated, cleanup-pending and rejected. This feature adds no state or transition to it; it only adds the `evidenceLedger` field the grant carries. The recorder's only decision on that state is one pure total function: `piEvidenceTarget(grant: ActiveChildWriteGrant | undefined, rejected: boolean, consumed: ConsumedWriteGrant | null): EvidenceTarget | { kind: "no-record"; reason: "no-grant" | "grant-rejected" | "cleanup-pending" }`, in `pi/evidence-recorder.ts`. `engine/tests/pi/evidence-recorder.test.ts` pins it with one case per grant state (AS-039: no grant, rejected and cleanup-pending record nothing, with a note; an active grant targets the parent ledger under `epochOf(grant.agentId, agentType)`).
  - **Parent reads.** `piChildEvidence(parentSession, slotToken, agentType)` recomputes the granted agent id from the slot's grant token, as `issuePiWriteGrant` does, and returns the child's `LedgerObservation`. Settlement (T9) and the Pi report-only stop check (T10) consume it (FR-035).
- **Pure modules.** `HarnessToolCall` adapters `claudeToolCall` and `piToolCall` live in a new pure module, `engine/src/core/harness-tool-call.ts`, added to `DEFAULT_PURE_MODULES`.

**Why:** One rule mints facts for both harnesses, proven by a matrix test (SC-007, INV-4). Pi gets real ledger facts, so I6 and I7 are not dead on Pi (NFR-002).
**Rejected:**
- A Pi-only transcript-to-ledger converter run at settlement. It reads text after the fact, and the minting rules would diverge.
- Recording into the child's own session. The parent cannot address it.

### AD-9: One planner, `planStopChecks`, with changed files as an explicit input

**Choice:** `stop-check-planner.ts` adds:

```
planStopChecks(graph, taskId, changed: ChangedFiles): StopChecksPlan
StopChecksPlan = { kind: "unknown-task" } | { kind: "known"; wave; acceptance: AcceptancePlan; affected: AffectedPlan }
```

`AcceptancePlan` is today's `off | on` arm, unchanged. Its type is:

```
AffectedPlan = { kind: "off"; reason: AffectedOffReason } | { kind: "on"; files: NonEmpty<string>; command; reportPath }
```

`AffectedOffReason` has three cases, in precedence order:
- `no-runner`;
- `no-changed-files`, with an optional `outsideCwd` detail when files existed but none lie beneath the runner cwd (interview Q5 A);
- `command-refused`.

The planner filters changed files to those beneath `affectedRunner.cwd` before calling the runner-command builder (`runnerCheck`, shared with `acceptanceRunnerCheck`). The changed files are a parsed input:

```
ChangedFiles = { kind: "none" } | { kind: "some"; files: NonEmpty<RepositoryRelativePath> }
```

One pure module derives the changed files: `engine/src/core/changed-files.ts`, which owns INV-7. It exposes:

```
changedFilesAtStop(events, repositoryRoot, exists: (repositoryRelativePath) => boolean): ChangedFiles
```

It takes the epoch's FileWrite paths, deduplicated in first-write order and kept only when inside the repository. It then drops every path for which the injected `exists` predicate is false (absent at stop time, FR-019), and parses the rest into `ChangedFiles`. A renamed file's new path arrives as its own `mv`/`cp` destination FileWrite (FR-034). The three shells supply only the `exists` predicate and the epoch events:
- `dispatch.ts`, from the evidence snapshot;
- `pi/subagent-stop.ts`, from `piChildEvidence`;
- `helper stop-check-plan`, from `liveAttemptEvidence`.

None of them filters or dedupes itself.

`planStopCheck(graph, taskId)` stays as a wrapper returning `planStopChecks(...).acceptance`, so the live hook keeps compiling until T10 switches it. T10 removes the wrapper.
**Why:** The live hook and the helper both consume one total pure plan (FR-027, SC-002). The filesystem fact enters only through the parsed `ChangedFiles` value.
**Rejected:**
- Reading the ledger inside the planner, which would break purity.
- A second planner.

### AD-10: One stop shell runs both checks: sequence, lock, budget and counters

**Choice:** A new `engine/src/handlers/subagent-stop/stop-checks.ts` holds `runStopChecks(input, ports)`, which replaces `runAcceptanceStopCheck` as the dispatch entry. The order of operations:
1. Plan with `planStopChecks`.
2. Acquire the existing per-repository runner lock once. Its file name stays the same, so old and new hooks never hold two different locks.
3. Run acceptance, then affected (FR-024).
4. Read each report digest-checked under the lock (AS-031).

Budget: the shell takes `hookStartedAtMs`, and `STOP_HOOK_BUDGET_MS = 300_000` minus `SETTLEMENT_RESERVE_MS = 30_000` gives the deadline. The affected runner launches only if `deadline - now >= affectedRunner.timeoutMs`; otherwise the check notes `budget exhausted` (AS-030, SC-003).

Counters: each check has its own per-agent counter file:
- acceptance keeps `*.acceptance-stop-check.json` with `ACCEPTANCE_STOP_CHECK_MAX_BLOCKS = 3`;
- affected adds `*.affected-stop-check.json` with `AFFECTED_STOP_CHECK_MAX_BLOCKS = 3`.

A check's counter increments only when that check contributes failures to a block. All counters clear when the stop proceeds (FR-023, AS-029).

The block counter is not a lifecycle (executable-models policy). It is a bounded integer, 0 to 3, per agent and per check. Slice 1 already runs this mechanic for the acceptance check, and it has no domain states. Its whole transition rule is one pure, total function in `engine/src/core/affected-stop-check.ts` (T8):

```
stopCheckBlockDecision(
  issued: { acceptance: BlockCount; affected: BlockCount },
  verdicts: { acceptance: CheckVerdict; affected: CheckVerdict },
  cap: 3,
): { outcome: "block" | "proceed"; record: { acceptance: number | "clear"; affected: number | "clear" }; notes: readonly string[] }
```

The rules it applies:
- an unreadable count fails open: the check cannot block, and a note is added;
- a count at the cap fails open with a cap note;
- a failing verdict under the cap blocks, and records `count + 1` for that check only;
- `proceed` clears both counters.

The shell only reads and writes the counter files that this function names. `engine/tests/core/affected-stop-check.test.ts` pins every transition: 0 to 1 to 2 to 3, then cap-reached fail-open, unreadable fail-open, an independent cap per check (AS-029), and clear on proceed. A property test asserts that no agent is blocked more than 3 times by either check (SC-005).

Verdicts and messages come from the pure `judgeAffectedRun(projection)` (CT-2 types):
- failing testcases are named with file and name, collection errors included;
- zero testcases is `passed` with a note (AS-023).

`renderStopChecksBlock` renders one combined block message, with a heading per check (AS-028). Every infrastructure fault fails open with a note naming its cause (FR-022).

The outcome type exposes only `skip | passed | block | note` and carries no completion data. Dispatch maps it to a block or a system message, exactly as it maps today's outcome (INV-3, FR-026). On Pi, `REPORT_ONLY` ports keep both checks report-only.
**Why:** One lock means the two runners never interleave report writes. Per-check counters give each check its own cap, and the deadline arithmetic keeps the 300 s hook budget.
**Rejected:**
- Two lock acquisitions. A third stop could interleave between them.
- Clipping the affected timeout to the remaining budget. The spec requires a full run or fail-open.

### AD-11: The plan view adds an affected section without touching CT-1's frozen view types

**Choice:** The new CT-2 types file `engine/src/core/affected-stop-check-types.ts` declares:
- `AffectedStopCheckView` and its off-reason text;
- the combined `StopChecksPlanRendering`;
- `RenderStopChecksPlanFn = (graph, taskId, changed: ChangedFiles) => StopChecksPlanRendering`.

`acceptance-contract/stop-check-plan.ts` renders the unchanged acceptance lines, then an `affected tests:` section. That section shows either the changed files, `cwd`, `argv` and `report`, or `affected stop check off — <one reason>` (FR-028, AS-032, AS-033).

`helper stop-check-plan` resolves the Task's live attempt epoch read-only, through a `liveAttemptEvidence(taskId)` port. That port finds the Claude implementation sidecar whose authority names the Task, or the Pi reservation slot's grant, and derives the changed files from that epoch's events through `changedFilesAtStop`. With no live attempt, the changed files are `none`. The helper's refusals stay as they are (FR-029).

`engine/src/core/stop-check-plan-types.ts` (the old CT-1) is not edited.
**Why:** It is a frozen contract file, and the new view is additive.
**Rejected:** Widening `RenderStopCheckPlanFn` in place.

### AD-12: Test-file classification is one pure module (interview Q8 A)

**Choice:** A new `engine/src/core/test-file-classification.ts` owns:
- `DEFAULT_TEST_FILE_SUFFIXES`, moved from `linter/programmatic/config.ts`, which now imports it;
- `isTestFileBySuffixes(path, suffixes)`;
- `classifyTaskFiles(fileList, testFiles) => { testFiles: readonly string[]; implementationFiles: readonly string[] }`.

Every non-test `file_list` entry is an implementation file (FR-013). The manifest's `testFileSuffixes` overrides the default. INV-2 is checkable.
**Why:** A suffix list matches the existing default form, needs no glob engine, and has a trivial canonical digest.
**Rejected:**
- Globs, which need a matcher dependency.
- Regexes, which bring ReDoS and anchoring concerns.

### AD-13: Loom's own manifest declares an affected runner last

**Choice:** In the final Wave, the docs Task adds this to `.loom/verification-manifest.json`:

```
"affectedRunner": {
  "executable": "npm",
  "args": ["--prefix", "engine", "exec", "--", "vitest", "related", "--run", "--reporter=junit",
           "--outputFile=../.loom/completion-reports/affected.junit.xml", "{files}"],
  "cwd": ".",
  "timeoutMs": 120000,
  "report": { "kind": "required-file", "path": ".loom/completion-reports/affected.junit.xml" }
}
```

The implementer verifies the exact argv against Vitest's `related` behavior, including `cwd` and how `{files}` resolves relative to `engine/`. If it adjusts the argv, it records why in the commit.
**Why:** Today's parser refuses unknown manifest keys. Adding the key before T5 lands would break population. This run's TaskGraph is already frozen, so the change affects only later runs.
**Rejected:** Adding it in Wave 2.

---

## File Structure

### Contracts (Wave 1)

```
engine/src/core/red-then-green-types.ts                              — NEW CT-1 types: TestFileResult, TestReportFiles, RedThenGreenObservation, RedThenGreenGap, RunRef, TestFileClassification, LedgerObservation, JudgeRedThenGreenFn (structured-test-report.ts imports TestFileResult and TestReportFiles from here)
engine/tests/acceptance/ledger-per-file-results.acceptance.test.ts   — NEW CT-1 acceptance tests (AS-001..AS-004)
engine/tests/acceptance/red-then-green.acceptance.test.ts            — NEW CT-1 acceptance tests (AS-005..AS-014, AS-018)
engine/src/core/affected-stop-check-types.ts                         — NEW CT-2 types: ChangedFiles, AffectedPlan, AffectedOffReason, AffectedRunVerdict, StopChecksPlan, StopChecksOutcome, StopChecksPorts (a superset of today's StopCheckPorts), AffectedStopCheckView, RenderStopChecksPlanFn, fixed texts
engine/tests/acceptance/affected-runner-manifest.acceptance.test.ts  — NEW CT-2 acceptance tests (AS-015, AS-016, AS-017, AS-019)
engine/tests/acceptance/affected-stop-check.acceptance.test.ts       — NEW CT-2 acceptance tests (AS-020..AS-031)
engine/tests/acceptance/stop-check-plan-affected.acceptance.test.ts  — NEW CT-2 acceptance tests (AS-032..AS-034)
engine/src/machine/harness-tool-call-types.ts                        — NEW CT-3 types: HarnessToolCall, HarnessTool, ToolOutcome, EvidenceTarget, RecordToolEvidenceFn, PiEvidenceLedgerAddress
engine/tests/acceptance/pi-ledger-capture.acceptance.test.ts         — NEW CT-3 acceptance tests (AS-036..AS-041)
```

The contract Tasks write no stub implementation files. Every acceptance test reaches the code through an entry point that already exists and keeps its signature:
- `parseEvidenceLine` and `findReport`;
- `settleExactImplementation`, whose new `ledger` input is passed as a test-local variable typed `Parameters<typeof settleExactImplementation>[1] & { ledger: LedgerObservation }`, so it typechecks today;
- `runDispatch(stdin, args, cleanup, ports)`, where the ports are a `StopChecksPorts` value assignable to today's `StopCheckPorts` parameter;
- `createStopCheckPlanHandler(write)` over a temporary state and ledger directory;
- `runRecordEvidence`;
- the Pi extension's registered `tool_result` and spawn handlers, driven through a fake `pi` API.

So `npm run typecheck` stays green in Wave 1, and each acceptance test fails behaviorally (an assertion), never by failing to load. Fixtures that need new frozen-manifest keys are built inside each testcase, not at module top level.

### Ledger facts: per-file results (T4)

```
engine/src/core/structured-test-report.ts       — TestReportFiles/TestFileResult, per-file projection for Vitest JSON + JUnit (legacy and strict parsers), reconcileFileResults, mergeSummaries merges files
engine/src/machine/test-report.ts               — re-exports
engine/src/machine/evidence.ts                  — parseReportField reads `files` (absent → unrecorded; malformed/unreconciled → report null)
engine/src/machine/report-discovery.ts          — findReport returns summaries carrying per-file results from every source
engine/tests/core/structured-test-report-files.test.ts           — unit + property tests (reconcile laws, merge associativity)
engine/tests/core/report-summary-reconcile.matrix.test.ts        — INV-8 matrix: the same consistent/inconsistent per-file fixtures through every parser, mergeSummaries, parseReportField and findReport
engine/tests/machine/evidence-per-file-readback.test.ts          — legacy/malformed/round-trip read-back
```

### Manifest, classification, attribution (T5)

```
engine/src/core/verification-manifest.ts        — affectedRunner + testFileSuffixes parse; frozen testFiles on every freeze path (operator with/without key, schema 1, engine default) + affectedRunner; digest; legacyDefaultVerificationManifest (today's bytes); affectedRunnerCheck; MAX_AFFECTED_RUNNER_TIMEOUT_MS; report-path distinctness
engine/src/state-file-wire.ts                   — T5 only: the absent-manifest suite-receipt fallback switches to legacyDefaultVerificationManifest (T7 later edits the obligation-match check; different Waves)
engine/src/core/wave-completion-suite-readiness.ts — absent-manifest fallback switches to legacyDefaultVerificationManifest
engine/src/core/test-file-classification.ts     — NEW: DEFAULT_TEST_FILE_SUFFIXES, isTestFileBySuffixes, classifyTaskFiles
engine/src/core/report-file-attribution.ts      — NEW: attributeReportedFile (moved from gate.ts + absolute-path rule)
engine/src/core/acceptance-contract/gate.ts     — imports attributeReportedFile (testcaseAcceptanceFile becomes a re-export alias, removed only if no caller remains)
engine/src/linter/programmatic/config.ts        — imports DEFAULT_TEST_FILE_SUFFIXES (removes the INV-2 violation)
engine/src/linter/programmatic/no-io-in-pure-modules.ts — adds test-file-classification.ts, report-file-attribution.ts and the CT types files
engine/tests/core/test-file-classification.test.ts
engine/tests/core/report-file-attribution.matrix.test.ts   — INV-5 matrix (gate, I6 judge, affected renderer)
engine/tests/core/verification-manifest-affected.test.ts
```

### Shared minting rule and Pi recorder (T6)

```
engine/src/core/harness-tool-call.ts            — NEW pure adapters: claudeToolCall(payload), piToolCall(event)
engine/src/machine/extract-evidence.ts          — extractEvidence(call: HarnessToolCall, findReport); mv/git mv/cp destinations in extractShellWriteTargets
engine/src/machine/tool-evidence-recorder.ts    — recordToolEvidence (sole minting/appending shell)
engine/src/machine/index.ts                     — exports
engine/src/handlers/post-tool-use/record-evidence.ts — attribution + claudeToolCall + recordToolEvidence (removes INV-4 violation)
pi/evidence-recorder.ts                         — tool_result handler body, piChildEvidence(parentSession, slotToken, agentType)
pi/write-grant.ts                               — IssuedWriteGrant/ConsumedWriteGrant.evidenceLedger
pi/spawn-lifecycle.ts                           — issues the grant with the parent session + agent type
pi/child-write-grant.ts                         — keeps the consumed evidenceLedger on the active grant
pi/extension.ts                                 — registers the recorder on tool_result
engine/tests/machine/evidence-minting.matrix.test.ts   — INV-4 matrix: same fixtures through Claude and Pi adapters → identical records
engine/tests/pi/evidence-recorder.test.ts
engine/tests/machine/extract-shell-write-targets.test.ts — mv/cp cases (extend existing if present)
```

### I6 core (T7)

```
engine/src/core/red-then-green.ts               — judgeRedThenGreen (pure)
engine/src/core/proof-obligations.ts            — obligation/failure/evidence variants, parsers, redThenGreen derivation input, evaluation arm
engine/src/core/implementation-completion.ts    — proofFailureKind for the new failure; observation parser admits redThenGreen
engine/src/core/task-graph-population.ts        — passes the I6-era marker
engine/src/core/task-revalidation.ts            — passes the I6-era marker
engine/src/state-file-wire.ts                   — obligation-match check passes the marker
engine/tests/core/red-then-green.property.test.ts      — permutation property tests (SC-001)
engine/tests/core/red-then-green-era.matrix.test.ts    — INV-6 matrix. Rows: (a) operator schema 2 with testFileSuffixes, (b) operator schema 2 without the key, (c) operator schema 1, and (d) no manifest file (ENOENT → defaultVerificationManifest()), each frozen through population → owed-if-new-tests with the expected suffix source; (e) a pre-feature frozen manifest, and (f) a pre-feature graph with no verification_manifest → not-owed. Every row runs through population, state-file-wire, revalidation and reconcile, and gets the same answer.
engine/tests/core/proof-obligations-red-then-green.test.ts
```

### Planner and affected core (T8)

```
engine/src/core/acceptance-contract/stop-check-planner.ts — planStopChecks; planStopCheck kept as wrapper
engine/src/core/changed-files.ts                — NEW pure changedFilesAtStop (INV-7 owner), added to DEFAULT_PURE_MODULES
engine/tests/core/changed-files.test.ts         — dedupe order, outside-repository drop, absence filter, rename via mv destination
engine/src/core/affected-stop-check.ts          — judgeAffectedRun, renderStopChecksBlock, renderAffectedBlock
engine/src/core/acceptance-contract/stop-check-plan.ts — renderStopChecksPlan (acceptance lines + affected section)
engine/src/linter/programmatic/no-io-in-pure-modules.ts — adds the planner, the plan view and affected-stop-check.ts
engine/tests/core/stop-checks-planner.test.ts
engine/tests/core/affected-stop-check.test.ts
```

### Settlement wiring (T9)

```
engine/src/handlers/helpers/exact-implementation-settlement.ts — ExactImplementationTransportFacts.ledger; judges I6; unreadable → unavailable
engine/src/core/implementation-application.ts   — settleObservedImplementation carries redThenGreen into the observation
engine/src/handlers/subagent-stop/update-task-status.ts — passes the epoch LedgerObservation
pi/subagent-settlement.ts                       — reads piChildEvidence and passes it
engine/src/handlers/helpers/reconcile-implementation-proof.ts — carries forward prior satisfied I6 result
engine/src/core/implementation-brief.ts         — I6 section + retry remedy
engine/tests/handlers/i6-settlement.matrix.test.ts     — Claude vs Pi settlement from the same facts
```

### Stop shells and helper (T10)

```
engine/src/handlers/subagent-stop/stop-checks.ts       — NEW runStopChecks (sequence, lock, budget, counters, combined message)
engine/src/handlers/subagent-stop/acceptance-stop-check.ts — lock/counter/port primitives kept and shared; runAcceptanceStopCheck folded into runStopChecks
engine/src/handlers/subagent-stop/dispatch.ts          — calls runStopChecks with changed files from the snapshot + hookStartedAtMs
pi/subagent-stop.ts                                    — report-only runStopChecks with piChildEvidence changed files
engine/src/handlers/helpers/stop-check-plan.ts         — liveAttemptEvidence port; renders renderStopChecksPlan
engine/src/core/acceptance-contract/stop-check-planner.ts — removes the planStopCheck wrapper once unused
engine/tests/handlers/stop-checks.test.ts              — injected-port tests (timeouts, budget, caps, lock)
engine/tests/handlers/stop-checks-isolation.test.ts     — INV-3 isolation (settlement byte-identical under every affected outcome)
engine/tests/core/stop-check-planner-parity.matrix.test.ts — INV-1 matrix (hook vs helper vs Pi)
engine/tests/handlers/changed-files.matrix.test.ts     — INV-7 matrix: one ledger + filesystem fixture through dispatch, Pi subagent-stop and the helper gives identical ChangedFiles
```

### Docs and Loom's manifest (T11)

```
docs/operations.md                     — I7 affected check, manifest keys, plan view, Pi recorder
docs/deterministic-implementation.md   — I6 obligation, trust model, soundness limit (where the obligation is defined)
docs/architecture.md                   — shared minting rule, Pi ledger
machines/README.md                     — known residuals updated (mv/cp now minted; interpreter writes still silent)
CONTEXT.md                             — I6, I7, affected runner, test-file pattern, changed files, Pi ledger recorder
.loom/verification-manifest.json       — affectedRunner (AD-13)
Obsidian vault: G4 section, I6 note, I7 note (via the obsidian skills)
```

---

## Component Design

### Per-file report facts

**Responsibility:** Project per-file results from structured reports and gate them with one reconcile function.
**Files:** `engine/src/core/structured-test-report.ts`, `engine/src/machine/evidence.ts`, `engine/src/machine/report-discovery.ts`
**Interface:**

```
type TestFileResult = Readonly<{ file: string; executed: number; failed: number; collectionError: boolean }>;
type TestReportFiles = Readonly<{ kind: "unrecorded" }> | Readonly<{ kind: "recorded"; results: readonly TestFileResult[] }>;
type TestReportSummary = Readonly<{ total; failed; source; files: TestReportFiles }> & Brand;
function parseReportSummary(total, failed, source, files?: unknown): TestReportSummary | null; // sole constructor, reconciles
function reconcileFileResults(source, total, failed, results): boolean;
```

**Depends on:** none

### Test-file classification and report attribution

**Responsibility:** Split `file_list` into test and implementation files, and map a reported file identity to one declared file.
**Files:** `engine/src/core/test-file-classification.ts`, `engine/src/core/report-file-attribution.ts`
**Interface:**

```
const DEFAULT_TEST_FILE_SUFFIXES: NonEmpty<string>;
function classifyTaskFiles(fileList: readonly string[], testFiles: FrozenTestFiles): TestFileClassification;
function attributeReportedFile(declared: readonly string[], reported: string, repositoryRoot: string): string | null;
```

**Depends on:** none

### Verification manifest (affected runner, test files)

**Responsibility:** Parse, freeze and digest `affectedRunner` and the test-file suffixes, and form the affected command.
**Files:** `engine/src/core/verification-manifest.ts`
**Interface:**

```
type AffectedRunner = AcceptanceRunner;  // same shape, timeoutMs <= 120_000
type FrozenTestFiles = Readonly<{ source: "operator-manifest" | "engine-default"; suffixes: NonEmpty<string> }>;
FrozenVerificationManifest += { testFiles?: FrozenTestFiles; affectedRunner?: AffectedRunner }
function affectedRunnerCheck(runner: AffectedRunner, files: NonEmpty<string>): Parsed<ProjectWaveCompletionCheck>;
```

**Depends on:** Test-file classification

### Shared minting rule

**Responsibility:** Turn one normalized tool call into ledger facts, identically for both harnesses, and append them.
**Files:** `engine/src/core/harness-tool-call.ts`, `engine/src/machine/extract-evidence.ts`, `engine/src/machine/tool-evidence-recorder.ts`, `engine/src/handlers/post-tool-use/record-evidence.ts`, `pi/evidence-recorder.ts`
**Interface:**

```
type HarnessToolCall = Readonly<{ tool: HarnessTool; input: Record<string, unknown>; outcome: ToolOutcome; callId: string | null; cwd: string }>;
type EvidenceTarget = Readonly<{ ledgerSession: SessionId; epoch: Epoch; stampSession: SessionId }>;
function extractEvidence(call: HarnessToolCall, findReportForSegment): Evidence[];        // pure
function recordToolEvidence(target: EvidenceTarget, call: HarnessToolCall, ports: RecorderPorts): void; // shell
function piChildEvidence(parentSession: SessionId, slotToken: string, agentType: AgentType): LedgerObservation;
```

**Depends on:** Per-file report facts (at runtime only)

### I6 judge and proof obligation

**Responsibility:** Decide red, then first implementation write, then green, from ordered facts, and feed proof.
**Files:** `engine/src/core/red-then-green.ts`, `engine/src/core/proof-obligations.ts`
**Interface:**

```
type RedThenGreenGap =
  | { kind: "no-test-files" } | { kind: "implementation-write-missing" }
  | { kind: "red-missing"; untrustedOnly: boolean } | { kind: "red-after-first-implementation-write" }
  | { kind: "green-missing"; untrustedOnly: boolean } | { kind: "ledger-unavailable" };
type RedThenGreenObservation = { kind: "shown"; red: RunRef; implementationWrite: string; green: RunRef } | { kind: "unproven"; gap: RedThenGreenGap };
function judgeRedThenGreen(events: readonly Evidence[], classification: TestFileClassification,
  repositoryRoot: string, untrustedEvidence: boolean): RedThenGreenObservation;
```

**Depends on:** Per-file report facts, Test-file classification and report attribution

### Stop-check planner and affected core

**Responsibility:** Plan both stop checks from the TaskGraph plus parsed changed files, judge an affected run, and render the combined messages and view.
**Files:** `engine/src/core/acceptance-contract/stop-check-planner.ts`, `engine/src/core/affected-stop-check.ts`, `engine/src/core/acceptance-contract/stop-check-plan.ts`
**Interface:**

```
function changedFilesAtStop(events: readonly Evidence[], repositoryRoot: string, exists: (path: RepositoryRelativePath) => boolean): ChangedFiles; // changed-files.ts
function planStopChecks(graph: TaskGraph, taskId: string, changed: ChangedFiles): StopChecksPlan;
function judgeAffectedRun(projection: JunitTestcasesResult): AffectedRunVerdict;
function renderStopChecksBlock(parts: StopChecksBlockParts): string;
const renderStopChecksPlan: RenderStopChecksPlanFn;
```

**Depends on:** Verification manifest

### Settlement wiring

**Responsibility:** Hand each harness's epoch facts to the I6 judge at completion. `exact-implementation-settlement.ts` is the one place that classifies `file_list`, through `classifyTaskFiles` (INV-2), before calling `judgeRedThenGreen`.
**Files:** `engine/src/handlers/helpers/exact-implementation-settlement.ts`, `engine/src/handlers/subagent-stop/update-task-status.ts`, `pi/subagent-settlement.ts`, `engine/src/handlers/helpers/reconcile-implementation-proof.ts`, `engine/src/core/implementation-brief.ts`
**Depends on:** I6 judge, Shared minting rule

### Stop shells

**Responsibility:** Run both checks under one lock and one deadline, fail open, and keep per-check counters.
**Files:** `engine/src/handlers/subagent-stop/stop-checks.ts`, `engine/src/handlers/subagent-stop/acceptance-stop-check.ts`, `engine/src/handlers/subagent-stop/dispatch.ts`, `pi/subagent-stop.ts`, `engine/src/handlers/helpers/stop-check-plan.ts`
**Interface:**

```
type StopChecksInput = Readonly<{ loadGraph; stateFilePath; taskId; agentKey; changedFiles: () => ChangedFiles; hookStartedAtMs: number }>;
function runStopChecks(input: StopChecksInput, ports: StopChecksPorts): Promise<StopChecksOutcome>;
```

**Depends on:** Stop-check planner and affected core, Shared minting rule

---

## Data Flow

```
I6:  tool call ─(Claude hook | Pi child)→ HarnessToolCall → extractEvidence(+findReport per-file) → recordToolEvidence → ledger
     SubagentStop / Pi batch settle → LedgerObservation(epoch) → judgeRedThenGreen(classifyTaskFiles(file_list, frozen testFiles)) → ObservedProofEvidence.redThenGreen → evaluateProofObligations → retry | implemented
I7:  stop → changedFilesAtStop(epoch, root, exists) → ChangedFiles → planStopChecks → [lock] acceptance run → affected run (deadline) → judge → combined block | note | pass
view: helper stop-check-plan → liveAttemptEvidence → ChangedFiles → renderStopChecksPlan (same planStopChecks)
```

These ordered flows are function composition inside one hook process, on one call stack, with no stage boundary, queue, LLM node or human review between steps. They are not a multi-stage pipeline, so this plan declines the fugue Pipeline bridge and declares no AuthoredDag. Loom does not use fugue either.

The only transformations that touch the filesystem are report discovery, ledger reads and appends, the existence filter on changed files, runner execution, and lock and counter files. All of them are in shells. Every decision is a pure function of parsed values.

---

## Invariants

### INV-1: One planner decides both stop checks

**Tier:** advisory
**Owner module:** `engine/src/core/acceptance-contract/stop-check-planner.ts`
**Sibling entry points:**
- `engine/src/handlers/subagent-stop/stop-checks.ts` — the live SubagentStop decision (Claude blocking, Pi report-only)
- `engine/src/core/acceptance-contract/stop-check-plan.ts` — the `helper stop-check-plan` view
**Matrix test:** `engine/tests/core/stop-check-planner-parity.matrix.test.ts`
**Statement:** The acceptance and affected decisions at a Task's stop are decided only by `planStopChecks`. The live stop shell (on both harnesses) and the plan view consume that plan and never re-derive what is owed, which changed files run, or how a runner command is formed. A regex cannot express "does not re-derive", so this invariant is advisory and enforced by the parity matrix (SC-002).

### INV-2: One test-file classifier

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-2-one-test-file-classifier.json`
**Owner module:** `engine/src/core/test-file-classification.ts`
**Sibling entry points:**
- `engine/src/handlers/helpers/exact-implementation-settlement.ts` — the I6 split: calls `classifyTaskFiles(task.file_list, frozen testFiles)` and hands the ready `TestFileClassification` to `judgeRedThenGreen` (both harnesses settle through this shell)
- `engine/src/core/verification-manifest.ts` — applies `DEFAULT_TEST_FILE_SUFFIXES` when freezing `testFiles` for a manifest without `testFileSuffixes`, a schema-1 manifest, or no manifest file
- `engine/src/core/implementation-brief.ts` — the I6 brief section's test and implementation files
- `engine/src/linter/programmatic/config.ts` — the programmatic linter's test-file skip
**Matrix test:** `engine/tests/core/test-file-classification.test.ts`
**Statement:** Whether a path is a test file is decided only by `test-file-classification.ts`, against the frozen suffixes or the engine default.
- The I6 split of `file_list` happens in exactly one place, the settlement shell. `red-then-green.ts` never classifies: it receives a ready `TestFileClassification` (AD-5).
- The matrix runs one set of `file_list`s, under default and operator suffixes, through the settlement shell's classification, the brief section, the frozen default from `verification-manifest.ts` and the linter skip, and asserts that they agree.
- The rule refuses any other declaration of `TEST_FILE_SUFFIXES` and any inline `endsWith('.test.' | '.spec.')`, except in the owner and test files. The siblings comply by importing from the owner: `verification-manifest.ts` imports `DEFAULT_TEST_FILE_SUFFIXES`, which the `\bTEST_FILE_SUFFIXES` pattern does not match.
- `core/review-panel.ts`'s lens-routing text heuristic is not file classification and is out of scope.

### INV-3: Affected-check data never reaches proof, receipts or gate evidence

**Tier:** advisory
**Owner module:** none
**Unowned reason:** A prohibition on data flow. No module implements it; it holds because the stop shell's outcome type carries only `skip | passed | block | note` text, and nothing implements a path from that outcome into settlement.
**Statement:** No affected-run fact or stop-check outcome reaches settlement, proof, receipts or Wave Gate evidence, whether through `engine/src/handlers/subagent-stop/dispatch.ts` (Claude) or `pi/subagent-stop.ts` (Pi). `engine/tests/handlers/stop-checks-isolation.test.ts` (written by T10) settles the same Task under every affected outcome and asserts byte-identical proof, receipts and TaskGraph (SC-005, FR-026). It is advisory because import direction alone does not prove data isolation.

### INV-4: One evidence minting rule for both harnesses

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-4-one-evidence-minting-rule.json`
**Owner module:** `engine/src/machine/tool-evidence-recorder.ts`
**Sibling entry points:**
- `engine/src/handlers/post-tool-use/record-evidence.ts` — Claude Code PostToolUse adapter
- `pi/evidence-recorder.ts` — Pi child `tool_result` adapter
**Matrix test:** `engine/tests/machine/evidence-minting.matrix.test.ts`
**Statement:** Ledger facts are minted only by `extractEvidence` and appended only by `recordToolEvidence`. Both harness entry points normalize to `HarnessToolCall` and call the shared shell. The rule refuses `extractEvidence(` and `.appendEvidence(` anywhere except `extract-evidence.ts`, `tool-evidence-recorder.ts` and test files. The matrix runs the same fixtures through both adapters and asserts identical records, covering read, edit, write, multi-edit, a bash redirect, mv/cp, and a test run with JUnit or Vitest per-file results (SC-007, AS-036). Today `record-evidence.ts` violates the rule; T6 removes the violation in the same commit that introduces the shell.

### INV-5: One reported-file to declared-file attribution

**Tier:** advisory
**Owner module:** `engine/src/core/report-file-attribution.ts`
**Sibling entry points:**
- `engine/src/core/acceptance-contract/gate.ts` — acceptance testcase attribution at the Wave Gate and the acceptance stop check
- `engine/src/core/red-then-green.ts` — attributing per-file results to the Task's test files
- `engine/src/core/affected-stop-check.ts` — naming each failing affected test's file
**Matrix test:** `engine/tests/core/report-file-attribution.matrix.test.ts`
**Statement:** A report's file identity (a path relative to some runner cwd, an absolute path, or a JVM class) maps to a declared repository path only through `attributeReportedFile`, at every call site listed. It is advisory because the JVM and suffix rules are not expressible as a regex prohibition.

---

### INV-6: One I6-era test

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-6-one-red-then-green-era-test.json`
**Owner module:** `engine/src/core/proof-obligations.ts`
**Sibling entry points:**
- `engine/src/core/task-graph-population.ts` — derives a new Task's pending proof
- `engine/src/state-file-wire.ts` — checks that stored obligations match a re-derivation at TaskGraph load
- `engine/src/core/task-revalidation.ts` — re-derives a revalidated Task's pending proof
- `engine/src/handlers/helpers/reconcile-implementation-proof.ts` — re-evaluates proof from stored evidence
**Matrix test:** `engine/tests/core/red-then-green-era.matrix.test.ts`
**Statement:** Whether a TaskGraph owes `red-then-green` (when a Task also requires new tests) is decided only by `redThenGreenEra(graph.verification_manifest)`. It returns `owed-if-new-tests` exactly when the frozen manifest carries `testFiles`, and `not-owed` otherwise. All four listed sites pass its answer to `deriveProofObligations`, so a pre-feature TaskGraph is never newly obligated (FR-005), and claimants stay unobligated through their `newTests` waiver (FR-010). The rule refuses an inline `testFiles ===/!== undefined|null` test outside `proof-obligations.ts` and `verification-manifest.ts` (which parses and freezes the field) and test files. Population freezes `testFiles` on every post-feature path, including an operator manifest without `testFileSuffixes`, a schema-1 manifest and no manifest file (AD-4). So only pre-feature TaskGraphs read as `not-owed`. The matrix rows (a)–(f) cover all four post-feature freeze cases plus the two pre-feature shapes, through every site, and assert the same derived obligations.

### INV-7: One changed-files derivation at stop

**Tier:** advisory
**Owner module:** `engine/src/core/changed-files.ts`
**Sibling entry points:**
- `engine/src/handlers/subagent-stop/dispatch.ts` — Claude live stop, epoch events from the evidence snapshot
- `pi/subagent-stop.ts` — Pi report-only stop, epoch events from `piChildEvidence`
- `engine/src/handlers/helpers/stop-check-plan.ts` — the plan view, epoch events from `liveAttemptEvidence`
**Matrix test:** `engine/tests/handlers/changed-files.matrix.test.ts`
**Statement:** A Task's changed files at stop come only from `changedFilesAtStop(events, repositoryRoot, exists)`, with these steps owned by that one module (FR-019, FR-034):
- take the epoch's FileWrite paths, deduplicated in first-write order;
- drop paths outside the repository;
- drop paths absent at stop time, using the injected existence predicate;
- parse the result into `ChangedFiles`.

The three listed shells supply only epoch events and the predicate; none filters, dedupes or relativizes paths itself. The matrix runs one ledger-plus-filesystem fixture through all three and asserts identical `ChangedFiles`, a deleted file, a renamed file and an outside-repository write included. It is advisory because "does not re-filter" is not a regex prohibition. It complements INV-1: the planner consumes `ChangedFiles` and never derives it.

### INV-8: One report-summary constructor reconciles per-file results

**Tier:** checkable
**Rule file:** `.claude/linter/rules/inv-8-sole-report-summary-constructor.json`
**Owner module:** `engine/src/core/structured-test-report.ts`
**Sibling entry points:**
- `engine/src/machine/evidence.ts` — ledger read-back (`parseReportField`) re-mints the summary through it
- `engine/src/machine/report-discovery.ts` — capture: every report source returns only summaries it constructed
**Matrix test:** `engine/tests/core/report-summary-reconcile.matrix.test.ts`
**Statement:** A `TestReportSummary` exists only as the output of `parseReportSummary`, which runs `reconcileFileResults` before branding. That covers the summary and its per-file results, on both harnesses (FR-001, FR-003). Inside the owner, every format parser and `mergeSummaries` funnel through it. Outside it, the ledger read-back and capture only call it. The rule refuses a brand cast `as TestReportSummary` anywhere but the owner and test files. The matrix feeds the same consistent and inconsistent per-file fixtures through the Vitest JSON parser, the JUnit parsers, `mergeSummaries`, `parseReportField` and `findReport`, and asserts that each consistent one survives and each inconsistent one becomes `null`.

## Contracts

### CT-1: I6 red-then-green judgment over per-file ledger facts

**Types file:** `engine/src/core/red-then-green-types.ts`
**Acceptance tests:**
- `engine/tests/acceptance/ledger-per-file-results.acceptance.test.ts` — FR-001, FR-002, FR-003, FR-004, AS-001, AS-002, AS-003, AS-004
- `engine/tests/acceptance/red-then-green.acceptance.test.ts` — FR-005, FR-006, FR-007, FR-008, FR-009, FR-010, FR-012, FR-013, FR-014, AS-005, AS-006, AS-007, AS-008, AS-009, AS-010, AS-011, AS-012, AS-013, AS-014, AS-018
**Statement:** A TestRun fact records exactly the per-file results its structured report lists, reconciled with its counts. Legacy facts read as unrecorded, and malformed facts make the report untrusted. A non-claimant implementation Task with `newTests: required` in an I6-era TaskGraph settles only when its epoch shows three things in order: a qualifying behavioral red on one of its test files, then the first write to an implementation file, then a qualifying green covering every test file. Every other ordering, an untrusted-only run, a collection-only red and a `file_list` with no test files are each refused with the distinct named gap, and the same facts give the same judgment.

### CT-2: I7 affected-test stop check and its plan view

**Types file:** `engine/src/core/affected-stop-check-types.ts`
**Acceptance tests:**
- `engine/tests/acceptance/affected-runner-manifest.acceptance.test.ts` — FR-015, FR-016, FR-017, AS-015, AS-016, AS-017, AS-019
- `engine/tests/acceptance/affected-stop-check.acceptance.test.ts` — FR-018, FR-019, FR-020, FR-021, FR-022, FR-023, FR-024, FR-025, FR-026, AS-020, AS-021, AS-022, AS-023, AS-024, AS-025, AS-026, AS-027, AS-028, AS-029, AS-030, AS-031
- `engine/tests/acceptance/stop-check-plan-affected.acceptance.test.ts` — FR-027, FR-028, FR-029, AS-032, AS-033, AS-034
**Statement:** The operator-declared `affectedRunner` is admitted only under the acceptance runner's form checks, and it is frozen and digest-checked. Every implementation Task's stop runs it over the Task's existing changed files, and blocks the stop with every failing test and file named, up to 3 times. It fails open with a named note on timeout, missing report, start failure, budget exhaustion or a reached cap. It shares one lock and one combined message with the acceptance check, and never reaches proof. `helper stop-check-plan` shows the same affected plan the hook uses, or exactly one off-reason.

### CT-3: Pi ledger capture through the shared minting rule

**Types file:** `engine/src/machine/harness-tool-call-types.ts`
**Acceptance tests:**
- `engine/tests/acceptance/pi-ledger-capture.acceptance.test.ts` — FR-031, FR-032, FR-033, FR-034, FR-035, AS-036, AS-037, AS-038, AS-039, AS-040, AS-041
**Entry point:** `pi/extension.ts`
**Statement:** The same tool calls produce identical ledger facts through Claude Code's recorder and through a Pi implementation child. The Pi child records into the parent session's ledger under the epoch of its parent-issued grant identity, and a child without a valid grant records nothing. Pi settlement satisfies I6, and the Pi report-only stop check plans I7, from that epoch. Pi-structured transcript evidence alone never satisfies I6. A literal `mv`, `git mv` or `cp` mints a shell FileWrite for its destination on both harnesses.

---

## Implementation Phases

Eleven Tasks over five Waves. The user-requested Pi recorder fits inside the 12-Task limit without merges. The shared minting core and the Pi adapter are one Task (T6), because the adapter is only a normalization over the shell T6 extracts. The mv/cp destination minting rides in T6 too, because it is part of the same minting rule (INV-4) and edits the same file.

### Phase 1: Contracts (no dependencies)

- **T1 — CT-1 contract.** Write `red-then-green-types.ts` (declarations only) and the two CT-1 acceptance files, with one testcase per anchor named `AS-0NN: …`. Ledger-fact tests drive `parseEvidenceLine` and `findReport` against real JUnit (Vitest, Surefire) and Vitest JSON fixtures. I6 tests drive `settleExactImplementation` with a fixture TaskGraph and a test-local facts variable carrying a `LedgerObservation`. Write no stub implementation files.
- **T2 — CT-2 contract.** Write `affected-stop-check-types.ts` and the three CT-2 acceptance files.
  - Stop-check tests drive `runDispatch` with injected `StopChecksPorts`: a fake runner that times out, is killed or produces no report; a fake clock for the budget; a fake lock; per-check counters.
  - Manifest tests drive `freezeVerificationManifest` and `parseFrozenVerificationManifest`.
  - Plan-view tests drive `createStopCheckPlanHandler` and compare its output with the hook's plan for the same fixtures (AS-034).
  - Write no stub implementation files.
- **T3 — CT-3 contract.** Write `harness-tool-call-types.ts` and `pi-ledger-capture.acceptance.test.ts`. The tests drive `runRecordEvidence` and the Pi extension's registered handlers (through a fake `pi` API) with the same recorded tool calls, then settle a Pi batch (AS-037, AS-040), using a temporary state and ledger directory. Write no stub implementation files.
- **Files:** see File Structure, Contracts.

**Claim map (for decompose).** CT-1 and CT-2 declare no entry point: their tests drive entry points that exist today. Each anchor is claimed by every Task that must land before it can pass, so a testcase falls due only at the Wave of its last claimant:

| Anchors | Claimed by |
|---|---|
| AS-001..AS-004 | T4 |
| AS-005..AS-014 | T7 and T9 |
| AS-018 | T5, T7 and T9 |
| AS-015, AS-016, AS-017, AS-019 | T5 |
| AS-020..AS-031 | T10 |
| AS-032, AS-033 | T8 and T10 |
| AS-034 | T10 |
| AS-036 | T4 and T6 |
| AS-039, AS-041 | T6 |
| AS-037, AS-038 | T9 |
| AS-040 | T10 |
| AS-035 | T11 (not test-decided) |

CT-3's entry point `pi/extension.ts` is written by T6, and T9 and T10 depend on T6.

### Phase 2: Facts, manifest, minting (depends on Phase 1)

- **T4 — Per-file TestRun results** (claims FR-001..FR-004, AS-001..AS-004). Implement AD-2 across the structured-report parsers (legacy and strict), `mergeSummaries`, ledger read-back and `findReport`. `parseReportSummary` stays the sole constructor and runs `reconcileFileResults` (INV-8 owner). `evidence.ts`'s `parseReportField` and `report-discovery.ts` only call it. T4 writes the INV-8 matrix. This is one atomic commit, because these are hook-imported machine files.
- **T5 — Manifest, classification, attribution** (claims FR-013..FR-017, AS-015..AS-019). Implement AD-3, AD-4 (the manifest half) and AD-12, plus `affectedRunnerCheck`. T5 owns the freeze change: `testFiles` on all four freeze cases (operator with key, operator without key, schema 1, no file), plus the `legacyDefaultVerificationManifest` split and the switch of the two read-time fallbacks. T5 writes rows (a) to (d) of the INV-6 era matrix as freeze-output assertions, and a test that `legacyDefaultVerificationManifest().manifestDigest` equals today's default digest. T7 extends the same rows through the derivation sites. Move `TEST_FILE_SUFFIXES`, which removes the INV-2 violation in `config.ts`. Add the new pure modules to `DEFAULT_PURE_MODULES`.
- **T6 — Shared minting rule and Pi recorder** (claims FR-031..FR-034, AS-036, AS-039, AS-041). Implement AD-8. First, probe Pi's `tool_result` event and grant flow and pin the shapes in comments. Refactor `extractEvidence` to `HarnessToolCall`, add the mv/cp destinations, extract `recordToolEvidence`, and switch `record-evidence.ts`, which removes the INV-4 violation. Then add the grant's `evidenceLedger`, the pure `piEvidenceTarget` grant-state decision with one test per grant state (AD-8), the Pi recorder registration, and `piChildEvidence`. Edits to hook-imported files are one atomic commit.
- **Files:** see File Structure, T4, T5 and T6.

### Phase 3: Pure judges (depends on Phase 2)

- **T7 — I6 core** (claims FR-005..FR-013, AS-005..AS-014, AS-018; depends on T4 and T5). Implement `judgeRedThenGreen` (AD-5) and the proof variants and derivation (AD-6). Add `redThenGreenEra` (INV-6 owner) and call it from population, revalidation and `state-file-wire`, in one atomic commit. Write the INV-6 matrix; its reconcile row is completed by T9. Add property tests over every permutation of red, implementation write and green, plus a collection-only red, untrusted-only runs, legacy facts and no test files: no false pass, and the expected gap each time (SC-001).
- **T8 — Planner and affected core** (claims FR-027, FR-028, AS-032, AS-033; depends on T5). Implement `planStopChecks` (AD-9), keeping the `planStopCheck` wrapper. Implement `changed-files.ts` (`changedFilesAtStop`, the INV-7 owner) with its unit tests. Add `judgeAffectedRun`, `stopCheckBlockDecision` (the counter transition rule, AD-10), `renderStopChecksBlock` and `renderStopChecksPlan` (AD-11). Add the planner, the plan view and `affected-stop-check.ts` to `DEFAULT_PURE_MODULES`.
- **Files:** see File Structure, T7 and T8.

### Phase 4: Shells (depends on Phase 3)

- **T9 — Settlement wiring** (claims FR-008, FR-011, FR-035 for I6, AS-005..AS-014, AS-018, AS-037, AS-038; depends on T5, T6 and T7). Add `LedgerObservation` to exact settlement on both harnesses, handle an unreadable ledger as infrastructure, add the reconcile carry-forward (`reconcile-implementation-proof.ts` calls `redThenGreenEra`, and T9 adds its row to the INV-6 matrix), and add the I6 brief section and retry remedy (AD-6, AD-7). Write the I6 settlement matrix test (Claude vs Pi from the same facts).
- **T10 — Stop shells and helper** (claims FR-018..FR-026, FR-029, FR-035 for I7, AS-020..AS-031, AS-034, AS-040; depends on T6 and T8). Implement `runStopChecks` (AD-10). Switch `dispatch.ts` and `pi/subagent-stop.ts`. `dispatch.ts` passes changed files from `changedFilesAtStop` over the evidence snapshot epoch with an `exists` predicate, plus `hookStartedAtMs` taken at dispatch start. Add the helper's `liveAttemptEvidence` port, which feeds `changedFilesAtStop`. Remove the `planStopCheck` wrapper. Write the INV-1 matrix, the INV-7 matrix and the INV-3 isolation test. All hook-imported edits go in one atomic commit.
- **Files:** see File Structure, T9 and T10.

### Phase 5: Docs and Loom's manifest (depends on Phase 4)

- **T11 — Docs** (claims FR-030, AS-035; depends on T9 and T10). Update every doc listed in File Structure, the vault G4 section, and the I6 and I7 notes through the obsidian skills. State I6's soundness limit where the obligation is defined: the proof covers logged facts only. Writes with no ledger event (interpreter-authored files, generators, unseen tools) are silent holes, and shell writes are logged but cannot be vetoed. Add Loom's `affectedRunner` (AD-13) after verifying the argv by running it once over a changed file. This Task waives new tests with reason `documentation-only`; the manifest edit is configuration, verified by `helper stop-check-plan`.
- **Files:** see File Structure, T11.

---

## Testing Strategy

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| Per-file report facts | JUnit (Vitest, Bun, Surefire, Node dialect) and Vitest JSON projections; collection-error detection; reconcile refusals; legacy read-back | `findReport` against fresh on-disk fixtures, explicit and directory sources | Reconcile holds for every generated report; merge of per-file results is associative and count-preserving |
| Classification and attribution | Default vs operator suffixes; fixtures, helpers and types files are implementation files | — | Classification partitions `file_list` (disjoint, covering); attribution is unique-or-null |
| Manifest | Every form check on `affectedRunner`; timeout cap; report-path distinctness; schema 1 and 2 without keys | Freeze → parse round trip; digest refusal on changed bytes | Frozen parse ∘ freeze is identity |
| Shared minting rule | Adapter normalization per tool; mv/cp destinations | Claude hook and Pi recorder against temp ledger dirs | Matrix: Claude ≡ Pi records for generated tool-call sequences |
| I6 judge and proof | Each gap; evidence shape; parsers round trip | `settleExactImplementation` on both harnesses | All permutations: no false pass, expected gap, determinism (SC-001, AS-014) |
| Planner and affected core | Off-reason precedence; cwd filter; rendering grammar | Helper over fixture TaskGraph and ledger | Planner is total over generated graphs and changed-file sets |
| Stop shells | Sequence order, combined message, per-check caps, budget exhaustion, lock held, timeouts at 120 s with a fake clock | `dispatch` end to end with injected ports; Pi report-only | — |

---

## Security & NFR Notes

- **Security:**
  - **Runners.** Runners execute only operator-declared argv, authorized through the existing project-command parser. `{files}` expands to repository-relative paths under the runner cwd, one argument each, with no shell interpolation.
  - **Changed files.** These are ledger facts, but an agent controls which files it writes. The cwd filter plus the runner authorization bound the blast radius to "run the operator's command over files in the repository".
  - **Pi ledger writes.** A Pi child appends to the parent ledger only under the epoch of a grant it consumed. The parent recomputes the epoch from the slot token it issued, so a child cannot write into another agent's epoch without that agent's token.
  - **Ledger integrity.** The ledger keeps today's guard (state-file Bash guard). Full integrity (HMAC) stays out of scope (OOS-007), and the docs state it.
- **Performance:** The two runners are bounded by 120 s and 240 s caps and a 300 s budget minus a 30 s settlement reserve. The ledger is read once per stop and once per settlement, and the existing snapshot is reused on Claude.

---

## Verification

1. `npm --prefix engine run typecheck`
2. `npm run verify` passes, the Wave Gates observe CT-1, CT-2 and CT-3 red in Wave 1, and green by Requirement in Waves 2–4.
3. `bun engine/src/cli.ts helper validate-lint-rules .claude/linter/rules` loads INV-2 and INV-4.
4. `bun engine/src/cli.ts helper stop-check-plan --task <id>` on a fixture Task shows the acceptance and affected plans. On Loom itself after T11, it shows the declared affected runner.
5. Manual check on Pi: spawn one implementation child that writes a test, runs it red, implements, and runs it green. The parent ledger holds the child's epoch, and settlement reports I6 satisfied.
