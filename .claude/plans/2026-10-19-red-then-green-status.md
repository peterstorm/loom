# Plan: helper red-then-green-status

**Spec:** .claude/specs/2026-10-19-red-then-green-status/spec.md
**Created:** 2026-10-19

## Summary

`helper red-then-green-status --task <id>` prints where one Task stands on I6, the red-then-green proof obligation:
- whether the Task owes I6, and if not, exactly one reason;
- how settlement splits its `file_list` into test and implementation files;
- the judgment over a live Claude Code attempt's epoch so far;
- the stored I6 result from the Task's frozen Proof.

The approach chosen at the gate is **a view ADT plus a renderer**, the two pure steps `helper contract-status` uses:
- `redThenGreenStatusView` projects the parsed inputs into a closed view. It calls only the engine's existing derivations: `redThenGreenDuty`, `classifyTaskFiles` and `judgeRedThenGreen`.
- `renderRedThenGreenStatus` turns that view into lines through exported text constants.

A thin read-only handler loads the TaskGraph and resolves the live attempt through `claudeLiveAttemptEvidence`, a port reused from `helper stop-check-plan`, then writes the lines.

This feature is the vehicle of the G4 slice 2 live pilot (`.claude/plans/2026-10-19-g4-slice-2-pilot.md`). The plan keeps the pilot's intended three-Task shape and declares no `## Contracts`, because an Acceptance Contract claimant is waived from I6.

---

## Architectural Decisions

As the pilot plan instructs, these decisions are recorded here as `plan_context` and not as ADR seeds. This is a read-only helper modelled on two existing ones, so none of the choices introduces a new pattern, dependency or data model that would warrant an ADR.

- **Approach: a view ADT plus a renderer (chosen at the gate, as recommended).** The core has two pure steps:
  - `redThenGreenStatusView(input)` builds a discriminated-union view;
  - `renderRedThenGreenStatus(input)` builds the view and maps it to lines.

  Tests assert facts against the view and spelling against the lines.

  Rejected alternatives:
  - *A single renderer from inputs straight to lines.* Every test would be a string test, and derivation would be mixed with formatting, which hides FR-005.
  - *The shell judges and the core formats.* This moves pure derivation into the imperative shell, against FC/IS and FR-006, and the agreement between derivation and settlement would then be testable only through the handler.

- **The duty is settlement's own answer.** Whether a Task owes I6 is `redThenGreenDuty(task, graph.verification_manifest)` from `engine/src/core/implementation-application.ts`. It is the one function that settlement, the stored-evidence reconcile and the brief all ask. It defers to the Task's frozen Proof and takes the classification from `frozenRedThenGreenEra`, the INV-6 owner. Calling `redThenGreenEra` alone was rejected because it ignores the frozen Proof and could disagree with settlement (SC-002).

  The not-owed *reason* only explains a `not-owed` duty and never decides it. The reasons are checked in this order, and the first that applies is the one reported:
  1. The era is `not-owed`, read through `redThenGreenEra(graph.verification_manifest)`: **predates I6**.
  2. `taskVerificationPolicy(task).newTests` is waived with `COVERED_BY_ACCEPTANCE_CONTRACT`: **claimant**.
  3. `newTests` is waived with any other reason: **new tests waived: <reason>**.
  4. Otherwise: **the frozen Proof carries no red-then-green obligation**. This arm exists so the view is total; INV-6's load check makes it unreachable for a parsed graph.

  The duty arms `classification-unfrozen` and `proof-unfrozen` render as **undeterminable**, with the reason the duty carries.

- **Classification and judgment are reused, never re-derived (FR-005).**
  - The test and implementation files come from `classifyTaskFiles(task.file_list ?? [], duty.testFiles)`, and only when the duty is `owed`.
  - The live judgment comes from `judgeRedThenGreen(events, classification, repositoryRoot, false)`. The fourth argument is `false` because a Claude Code attempt's evidence is never Pi-structured. This mirrors `judgeAttemptRedThenGreen` in `engine/src/handlers/helpers/exact-implementation-settlement.ts`.
  - Gap spelling uses `redThenGreenFailureKind(gap)` from `engine/src/core/red-then-green.ts`, so it is `proof:red-then-green-unproven:<gap>`, exactly as settlement names it.

- **The judge's output is shown as is (interview B2).** When the judgment is `shown`, the output lists the red run, the first implementation write and the green run, each with its ledger reference (`#<index> <command>`, where index is the run's position in the epoch). When the judgment is `unproven`, it shows the gap name, plus `(untrusted runs only)` when `untrustedOnly` is true. The judge returns no references for steps met before a gap, and the helper does not infer any: doing so would re-derive the judgment, and changing the judge is OOS-001.

- **The live-attempt port is imported, not moved (interview A1).** The handler imports `claudeLiveAttemptEvidence` and `LiveAttemptEvidence` directly from `engine/src/handlers/helpers/stop-check-plan.ts`, and resolves the repository root through `PRODUCTION_STOP_CHECK_PORTS.repositoryRoot` from `engine/src/handlers/subagent-stop/acceptance-stop-check.ts`. No existing file other than the route table and the purity list changes.

- **Pi reads as "not observable" (interview B4, NFR-002).** The handler passes `HARNESS` from `engine/src/config.ts` to the core. Under `pi`, the core input's live arm is `not-observable`, the port is never called, and the line reads `live attempt not observable on this harness`.

- **Degraded states render; only bad input refuses (interview B1, FR-007).** Every section renders independently:
  - an uninspectable sidecar set, an unreadable ledger epoch, several live attempts, an unresolvable repository root, or an undeterminable duty each become a named line in their own section, and the helper exits 0;
  - only an unknown Task id (`No task <id> in the TaskGraph`) and a missing TaskGraph (`No task graph at <path>`) exit non-zero, as does a corrupt TaskGraph, which surfaces the load boundary's error the way `contract-status` does.

- **Types are inline, and the text is exported as constants (interviews A2 and B3).**
  - The view types live in the core module. A separate types file would add a fourth file to T1's I6 classification for no consumer.
  - Every fixed phrase is an exported constant, so the core tests, the handler tests and `docs/operations.md` pin one spelling.
  - The unknown-id prefix is `UNKNOWN_TASK_PREFIX`, reused from `engine/src/core/stop-check-plan-types.ts`.

- **Purity enrolment belongs to T2 (interview A2).** The core module is added to `engine/src/linter/programmatic/no-io-in-pure-modules.ts`, and the test asserting the enrolment ships in T2's handler test file. If T1's test asserted it, T1 would be red until Wave 2. This follows the pilot plan, which places both hook-imported edits in T2, under the pinned runtime.

- **Primary NFR axis: simplicity (interview A4).** The design adds no abstraction beyond the view ADT. Output goes to stdout only, with no logs, metrics or audit events (interview C1). The scope is exactly the spec's: OOS-001 to OOS-004 stay out.

- **Lint invariants already in force constrain the implementation.**
  - **INV-6** (`.claude/linter/rules/inv-6-one-red-then-green-era-test.json`): never destructure `testFiles`, never test it with `===`, `!`, `?.`, `??` or `in`, and never read it by bracket. Read `duty.testFiles` from the narrowed `owed` arm only.
  - **INV-2** (`inv-2-one-test-file-classifier.json`): never match `.test.` or `.spec.` suffixes inline; classify only through `classifyTaskFiles`.

---

## File Structure

### Pure core (T1, Wave 1)

```
engine/src/core/red-then-green-status.ts              — NEW: view ADT, text constants, redThenGreenStatusView, renderRedThenGreenStatus (pure, total)
engine/tests/core/red-then-green-status.test.ts       — NEW: fixture-matrix tests over every view arm and the rendered lines (fixtures inline; no new fixture file)
```

### Helper shell and route (T2, Wave 2)

```
engine/src/handlers/helpers/red-then-green-status.ts  — NEW: read-only handler; parses --task, loads the TaskGraph, resolves the live input, renders, writes
engine/src/handler-routes.ts                          — MODIFY: add "red-then-green-status" to KNOWN_HANDLERS.helper only
engine/src/linter/programmatic/no-io-in-pure-modules.ts — MODIFY: enrol engine/src/core/red-then-green-status.ts in the pure-module list (with a comment, as for Contract Status)
engine/tests/handlers/helpers/red-then-green-status.test.ts — NEW: handler tests with injected ports, a real-CLI test, route and purity-enrolment assertions
```

### Operator docs (T3, Wave 2)

```
docs/operations.md                                    — MODIFY: new section "Where does a Task stand on I6?" after the Stop-Check Plan section
```

T3 touches no engine file, and T1 touches neither the handler, the route nor the purity list.

---

## Component Design

### Red-Then-Green Status core

**Responsibility:** project one Task of a parsed TaskGraph, plus the live-attempt input, into the I6 status view and its lines. It is pure and total, and it never throws or reads the filesystem (FR-006).
**Files:** `engine/src/core/red-then-green-status.ts`, `engine/tests/core/red-then-green-status.test.ts`
**Interface:**

```ts
import type { TaskGraph } from "../types";
import type { LedgerObservation, RedThenGreenObservation, TestFileClassification, RunRef } from "./red-then-green-types";
import type { NewTestWaiverReason } from "./verification-policy";
import type { NonEmpty } from "./orchestration-contract";

/** What the shell observed of the Task's live attempt. */
export type RedThenGreenLiveInput =
  | Readonly<{ kind: "not-observable" }>                         // Pi: never asked
  | Readonly<{ kind: "no-live-attempt" }>
  | Readonly<{ kind: "uninspectable"; reason: string }>          // from LiveAttemptEvidence
  | Readonly<{ kind: "live"; ledger: LedgerObservation; repositoryRoot: string }>;

export type RedThenGreenStatusInput = Readonly<{
  graph: TaskGraph;
  taskId: string;
  live: RedThenGreenLiveInput;
}>;

export type NotOwedReason =
  | Readonly<{ kind: "predates-i6" }>
  | Readonly<{ kind: "claimant" }>
  | Readonly<{ kind: "new-tests-waived"; reason: NewTestWaiverReason }>
  | Readonly<{ kind: "no-obligation-in-proof" }>;

export type DutyView =
  | Readonly<{ kind: "owed"; classification: TestFileClassification }>
  | Readonly<{ kind: "not-owed"; reason: NotOwedReason }>
  | Readonly<{ kind: "undeterminable"; reason: string }>;     // classification-unfrozen | proof-unfrozen

export type LiveView =
  | Readonly<{ kind: "not-observable" }>
  | Readonly<{ kind: "no-live-attempt" }>
  | Readonly<{ kind: "uninspectable"; reason: string }>
  | Readonly<{ kind: "unreadable"; reason: string }>
  | Readonly<{ kind: "not-judged" }>                           // live attempt, but the duty is not owed
  | Readonly<{ kind: "judged"; observation: RedThenGreenObservation }>;

export type StoredView =
  | Readonly<{ kind: "no-proof" }>                             // legacy_missing_proof
  | Readonly<{ kind: "no-obligation" }>                        // frozen Proof owes no red-then-green
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "satisfied"; red: RunRef; implementationWrite: string; green: RunRef }>
  | Readonly<{ kind: "failed"; failureKind: string }>;         // redThenGreenFailureKind(gap), or proof:<kind>

export type RedThenGreenStatusView =
  | Readonly<{ kind: "unknown-task"; taskId: string }>
  | Readonly<{ kind: "task"; taskId: string; wave: number; status: string; duty: DutyView; live: LiveView; stored: StoredView }>;

export type RedThenGreenStatusRendering =
  | Readonly<{ kind: "rendered"; lines: NonEmpty<string> }>
  | Readonly<{ kind: "unknown-task"; taskId: string; message: string }>;   // `${UNKNOWN_TASK_PREFIX} ${id} in the TaskGraph`

export function redThenGreenStatusView(input: RedThenGreenStatusInput): RedThenGreenStatusView;
export function renderRedThenGreenStatus(input: RedThenGreenStatusInput): RedThenGreenStatusRendering;

// Exported fixed text (exact spelling is the implementer's, but each phrase is one constant):
// RTG_OWES ("owes I6"), RTG_NOT_OWED ("I6 not owed"), NOT_OWED_REASON_TEXT: Record<NotOwedReason["kind"], string>
//   (predates-i6 -> "TaskGraph predates I6", claimant -> "claimant (acceptance contract)",
//    new-tests-waived -> "new tests waived: <reason>" prefix), RTG_UNDETERMINABLE,
// NO_TEST_FILES ("test files: none"), LIVE_NOT_OBSERVABLE ("live attempt not observable on this harness"),
// LIVE_NONE ("live attempt: none"), and the live/stored section prefixes.
```

The view's derivations, in order:
1. Find the Task by id. If no Task has that id, the view is `unknown-task`.
2. The duty is `redThenGreenDuty(task, graph.verification_manifest)`, mapped to a `DutyView`. Only the `owed` arm carries `classifyTaskFiles(task.file_list ?? [], duty.testFiles)`. The not-owed reason follows the order in the Architectural Decisions.
3. The live view:
   - `not-observable`, `no-live-attempt` and `uninspectable` pass through unchanged;
   - a `live` input whose ledger is `unreadable` becomes `unreadable` with its reason;
   - a `live` input whose ledger was read becomes `judged` with `judgeRedThenGreen(events, classification, repositoryRoot, false)` when the duty is `owed`, and `not-judged` otherwise.
4. The stored view:
   - the Task carries `legacy_missing_proof`: `no-proof`;
   - otherwise, the Task's `proof.results` has no entry whose obligation kind is `red-then-green`: `no-obligation`;
   - otherwise, that result's state decides: `pending` becomes `pending`; `satisfied` carries its `red-then-green` evidence; `failed` carries the failure kind, spelled `redThenGreenFailureKind(failure.gap)` for `red-then-green-unproven` and `proof:<kind>` for any other failure.

   The proof's `results` arm always holds that result's latest evaluation, so a retry-pending Task (`pending` with a `FailedTaskProof`) shows its latest failed gap (AS-006).

The rendered grammar, in order:
- **Header:** `<id> (Wave <n>, <status>): owes I6`, `… : I6 not owed — <reason text>` or `… : I6 undeterminable — <reason>`.
- **Files, only when the duty is owed:**
  - `test files:` followed by one indented path per line, or the `NO_TEST_FILES` line when there are none;
  - then `implementation files:` with the same layout.
- **Live:**
  - `live attempt: none`;
  - the `LIVE_NOT_OBSERVABLE` line;
  - `live attempt: uninspectable — <reason>` or `live attempt: unreadable — <reason>`;
  - `live attempt: not judged (I6 not owed)`;
  - `live attempt: shown`, followed by three indented lines: `red #<i> <command>`, `first implementation write <path>`, `green #<i> <command>`;
  - `live attempt: <failure kind>`, followed by ` (untrusted runs only)` when `untrustedOnly` is true.
- **Stored:** the same four shapes, prefixed `stored:` (`no proof (legacy)`, `no red-then-green obligation`, `pending`, `shown …`, or `<failure kind>`).

**Depends on:** none. It imports only the existing pure modules: `implementation-application.ts`, `proof-obligations.ts`, `test-file-classification.ts`, `red-then-green.ts`, `verification-policy.ts` and `stop-check-plan-types.ts`.

### Red-Then-Green Status helper

**Responsibility:** the read-only shell. It parses `--task <id>`, locates and loads the TaskGraph, builds the live input, renders through the core, and writes stdout or refuses.
**Files:** `engine/src/handlers/helpers/red-then-green-status.ts`, `engine/src/handler-routes.ts`, `engine/src/linter/programmatic/no-io-in-pure-modules.ts`, `engine/tests/handlers/helpers/red-then-green-status.test.ts`
**Interface:**

```ts
export type RedThenGreenStatusPorts = Pick<StopCheckShellPorts, "repositoryRoot">;

export function createRedThenGreenStatusHandler(
  write: (text: string) => void = toStdout,
  liveAttemptEvidence: LiveAttemptEvidenceFn = claudeLiveAttemptEvidence,   // from ./stop-check-plan
  ports: RedThenGreenStatusPorts = PRODUCTION_STOP_CHECK_PORTS,
  harness: "claude" | "pi" = HARNESS,
): HookHandler;
export default createRedThenGreenStatusHandler();
```

Handler flow, modelled on `createStopCheckPlanHandler`:
1. Parse the arguments with `unconsumedValueArguments` and `argumentValue` from `./cli-args`. A missing `--task` or any unconsumed argument returns `{ kind: "error" }`.
2. Locate the TaskGraph with `taskGraphPath()` and `StateManager.fromPath`. If there is none, refuse with `No task graph at <path>`. Load it inside a try block; a load error refuses with that error's message.
3. Build the live input. Under `pi`, it is `{ kind: "not-observable" }` and the port is never called. Otherwise call `liveAttemptEvidence(taskId, manager.getPath())`:
   - a `live` result resolves `ports.repositoryRoot(manager.getPath())`;
   - if the root cannot be resolved, the input becomes `live` with ledger `{ kind: "unreadable", reason }`, so the root failure renders and does not refuse.
4. Call `renderRedThenGreenStatus`. A `rendered` result writes the joined lines plus a newline and returns `passthrough`. An `unknown-task` result returns `{ kind: "error", message }`.

The handler never writes the State File, the ledger or the runtime directory, and never takes the TaskGraph lock. The route goes in `KNOWN_HANDLERS.helper` only: not in `WHITELISTED_HELPERS`, and not a Pi runtime-handshake route.

**Depends on:** the Red-Then-Green Status core.

### Operator documentation

**Responsibility:** document the helper in `docs/operations.md` beside `contract-status` and `stop-check-plan`.
**Files:** `docs/operations.md`
**Interface:** a new subsection, `### Where does a Task stand on I6?`, placed after `### What will the stop checks run at a Task's stop?`. It gives:
- the command, `bun "$LOOM_DIR/engine/src/cli.ts" helper red-then-green-status --task T1`;
- that the command takes exactly one argument;
- the header forms, with the three not-owed reasons and the undeterminable form;
- the test-file and implementation-file lists, in `file_list` order;
- each live-attempt line, including `live attempt not observable on this harness` for Pi;
- each stored-result line, and that gaps are spelled `proof:red-then-green-unproven:<gap>`;
- that only steps the judgment shows carry ledger references (`#<index> <command>`, where index is the run's position in the epoch);
- the refusals: `No task <id> in the TaskGraph` and `No task graph at <path>`, each exiting 1;
- that the helper is read-only and takes no lock, so it is safe during a live Wave;
- that `LOOM_STATE_PATH` selects another graph.

Its wording follows the constants named in the core's interface.
**Depends on:** none for files. Its content follows the grammar in this plan, so it can run in parallel with T2.

---

## Data Flow

```
argv --task ─┐
TaskGraph (StateManager.load) ──┐
HARNESS ── claude ─> claudeLiveAttemptEvidence(taskId, statePath) ─> (+ repositoryRoot port) ─┐
           pi ────> not-observable ──────────────────────────────────────────────────────────┤
                                                                                             v
            RedThenGreenStatusInput ─> redThenGreenStatusView ─> renderRedThenGreenStatus ─> stdout | error
                                         │ redThenGreenDuty / classifyTaskFiles / judgeRedThenGreen / task.proof
```

All reads happen in the handler. The core's only transformation is projection: settlement's own functions decide the duty, the classification and the judgment, and the stored result is read off the frozen Proof unchanged.

---

## Implementation Phases

### Phase 1: Pure core (no dependencies)

- Build `engine/src/core/red-then-green-status.ts`: the inline view ADT, the exported text constants, `redThenGreenStatusView` and `renderRedThenGreenStatus`, exactly as Component Design specifies.
- Write `engine/tests/core/red-then-green-status.test.ts` over an inline fixture matrix of TaskGraphs. It covers every arm:
  - an unknown id;
  - each duty arm and each not-owed reason, including the waiver reason;
  - the classification with and without test files;
  - every live arm;
  - every stored arm, including a retry-pending Task with a failed gap.
- Do **not** assert the purity enrolment here; T2 owns it.
- **Files:** `engine/src/core/red-then-green-status.ts`, `engine/tests/core/red-then-green-status.test.ts`

### Phase 2: Helper shell and route (depends on Phase 1)

- Build `engine/src/handlers/helpers/red-then-green-status.ts` as Component Design specifies.
- Add `"red-then-green-status"` to `KNOWN_HANDLERS.helper` in `engine/src/handler-routes.ts`.
- Enrol `engine/src/core/red-then-green-status.ts` in `engine/src/linter/programmatic/no-io-in-pure-modules.ts`, with a comment line as for Contract Status.
- Write `engine/tests/handlers/helpers/red-then-green-status.test.ts`, covering:
  - injected live ports for each live arm;
  - Pi, asserting the port is never called;
  - an unresolvable repository root, which renders as unreadable;
  - the AS-007 refusals and their exit codes;
  - read-only behaviour (the State File's bytes and mtime are unchanged, and no lock file appears);
  - the route assertions, as `stop-check-plan.test.ts` makes them: in `KNOWN_HANDLERS.helper`, not in `WHITELISTED_HELPERS`, no Pi handshake;
  - the purity enrolment, as `contract-status.test.ts` asserts its own;
  - at least one real-CLI run through `bun engine/src/cli.ts helper red-then-green-status`, using a `spawnSync` helper inline in the test file.
- **Files:** `engine/src/handlers/helpers/red-then-green-status.ts`, `engine/src/handler-routes.ts`, `engine/src/linter/programmatic/no-io-in-pure-modules.ts`, `engine/tests/handlers/helpers/red-then-green-status.test.ts`

### Phase 2 (parallel): Operator docs (depends on Phase 1 for the grammar only)

- Add the `### Where does a Task stand on I6?` subsection to `docs/operations.md`, as Component Design specifies.
- **Files:** `docs/operations.md`

---

## Testing Strategy

Every Task writes its own behaviour tests; there is no Acceptance Contract. The core and the handler both require new tests, and the docs Task waives them with `documentation-only`.

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| Red-Then-Green Status core | The fixture matrix: each `DutyView` arm and not-owed reason (AS-001, AS-002), the classification in `file_list` order and the no-test-files line (AS-003), each `LiveView` arm with `judged` producing both `shown` refs and a gap with and without `untrustedOnly` (AS-004, AS-005, NFR-002), each `StoredView` arm including retry-pending (AS-006), and `unknown-task` (AS-007). The judged view must equal `judgeRedThenGreen` called directly on the same events and `classifyTaskFiles` output (FR-005 parity) | none (pure) | none, by the interview A3 decision |
| Red-Then-Green Status helper | none | Handler with injected `write`, live port, root port and harness: each live arm, Pi never calling the port, root failure rendering as unreadable, the unknown id and missing graph refusing non-zero (AS-007), a corrupt graph surfacing the load error, the State File left unchanged with no lock taken (FR-007). Route table and purity-list assertions (NFR-001). A real-CLI run proving the route dispatches (SC-001) | none |
| Operator docs | none (waived: `documentation-only`) | none | none |

**Regression:** the existing suite has to stay green, especially `stop-check-plan.test.ts`, `contract-status.test.ts`, `no-io-in-pure-modules.test.ts` and the hooks-sync route tests. No existing behaviour changes.

---

## Security & NFR Notes

- **Security:** the helper only reads. It reads the State File, implementation sidecars and session ledgers through the existing `claudeLiveAttemptEvidence` path. It executes nothing and parses no new wire format, so it crosses no trust boundary that `stop-check-plan` does not already cross.
- **Performance:** it makes one TaskGraph load, one sidecar directory listing and one ledger read, which is negligible.
- **Pilot runtime:** T2 edits two hook-imported files, `handler-routes.ts` and `no-io-in-pure-modules.ts`. The pilot pins a detached runtime, so a half-applied edit cannot break live hooks.

---

## Verification

1. `npm --prefix engine run typecheck` (or the project's `tsc --noEmit`): clean.
2. `npm --prefix engine test -- red-then-green-status stop-check-plan contract-status no-io-in-pure-modules`: green. Then run the full `npm --prefix engine test`: green.
3. Full-tier lint (`helper lint-wave-gate`): no INV-2 or INV-6 hit in the new files.
4. Live, during the pilot, run `bun engine/src/cli.ts helper red-then-green-status --task <id>` for T1, T2 and T3:
   - T1 and T2 read `owes I6`, and T3 reads `I6 not owed — new tests waived: documentation-only`;
   - each stored result agrees with settlement's (SC-002, pilot M9).
