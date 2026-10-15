# Plan: Stop-Check Plan — read-only `helper stop-check-plan --task <id>`

**Spec:** .claude/specs/2026-10-14-stop-check-plan/spec.md
**Created:** 2026-10-15

## Summary

`helper stop-check-plan --task <id>` prints what the Acceptance Stop Check would do at that Task's stop, without running anything. It shows the owed testcases by contract, the acceptance files, the runner cwd, the exact argv after `{files}` expansion and the report path. When the check is off, it prints one reason instead.

It mirrors `helper contract-status` (the G1 pilot): a declarations-only types file, a pure core that projects a view ADT and renders it, and a thin read-only shell. The core gets every fact from the two functions the live check uses, `stopCheckExpectation` and `acceptanceRunnerCheck`. It never re-derives what is owed or how the command is formed.

This feature is the vehicle for the G4 live pilot (`.claude/plans/2026-10-14-g4-stop-check-pilot.md`). The operator has already installed the verification manifest: `.loom/verification-manifest.json` is schema 2, with `project:verify` writing a JUnit report at `.loom/completion-reports/verify.junit.xml`, and an `acceptanceRunner` (`npm run test:acceptance -- {files}`, cwd `engine`, report `.loom/completion-reports/acceptance.junit.xml`). No manifest work is needed.

---

## Architectural Decisions

### AD-1: View ADT plus renderer, mirroring contract-status (approach gate: A)

**Choice:** There are two pure steps. `stopCheckPlanView(graph, taskId)` projects a closed union: `unknown-task | off{reason} | on{owed, files, command}`. `renderStopCheckPlan(graph, taskId)` formats that view into `rendered{lines} | unknown-task{taskId, message}`. The shell maps `unknown-task` to `{kind:"error"}`, which gives a non-zero exit, and writes `rendered` lines to stdout.
**Why:** The user picked this at the approach gate, and it was the recommendation. It is the proven `contract-status` shape. Illegal states cannot be represented (an `on` view always has a runner, owed testcases and a formed command). The off-reason is a value that unit tests assert directly, and CT-1's totality holds without a "cannot happen" branch.
**Rejected:**
- A single renderer returning lines, with the shell looking up the Task. This splits the unknown-task logic between shell and core, and puts an unreachable branch in a function CT-1 declares total.
- A shared `planStopCheck` derivation extracted from `acceptance-stop-check.ts`. That would change #90's hook, the very subject the pilot measures, which contaminates M2–M6. The hook's ordering (block counter and repository root sit between the expectation and the command) also does not factor out cleanly.

### AD-2: The live hook is not touched; fidelity comes from calling the same functions

**Choice:** `engine/src/handlers/subagent-stop/acceptance-stop-check.ts` is off-limits. The core follows `decideStop`'s derivation step for step:
- the runner is `graph.verification_manifest?.acceptanceRunner`;
- the Task is `graph.tasks.find(({ id }) => id === taskId)`;
- what is owed comes from `stopCheckExpectation(graph.acceptance_contracts ?? [], graph.tasks, task)`;
- the command comes from `acceptanceRunnerCheck(runner, check.files)`.

**Why:** FR-002 and the user's Q1 answer. The pilot must observe the shipped check unchanged. Calling the same four expressions means the helper can only drift if the hook itself changes.
**Rejected:** Re-implementing owed-ness (claims and due Waves) or `{files}` expansion. FR-002 forbids it.

### AD-3: Exactly one off-reason, in the live check's precedence

**Choice:** The reasons are checked in this order:
1. `unknown-task`, which is not an off-reason but a refusal;
2. `no-runner`;
3. `nothing-owed`;
4. `command-refused{errors}`.

`nothing-owed` is the single reason for every `stopCheckExpectation` → `none`. The three causes AS-003 names (claims nothing, contract not yet frozen, anchors not yet due) are acceptance fixtures that all produce this one reason.
**Why:** FR-003 requires exactly one reason. The order is the order in which `decideStop` returns `skip` or a note. `stopCheckExpectation` returns a bare `none`, so finer causes would need a re-derivation (user answers Q6 and Q7).
**Rejected:** Sub-causes for "nothing owed". They re-derive claims and freeze state, which FR-002 forbids.

### AD-4: Only AS-004 drives the CLI; AS-001..AS-003 drive the pure renderer; no `**Entry point:**`

**Choice:** The CT-1 acceptance file tests AS-001, AS-002 and AS-003 by calling `renderStopCheckPlan` from `engine/src/core/acceptance-contract/stop-check-plan.ts` on graphs the production State File parser admits. It tests AS-004 by spawning `bun engine/src/cli.ts helper stop-check-plan`. CT-1 declares no `**Entry point:**`.
**Why:** The pilot requires T2 (AS-001..003) and T3 (AS-004) to be concurrent claimants in Wave 2. An `**Entry point:**` naming T3's handler makes plan validation refuse T2 (`contractBindingErrors`, `engine/src/core/acceptance-contract/binding.ts:64-87`), because T2 neither writes the handler nor depends on T3. Driving AS-001..003 through the CLI would also make T2's owed testcases depend on T3's file. T2's stop checks would then block on a sibling's unfinished work, which the pilot plan treats as a defect class. With this split, each claimant's owed testcases depend only on its own files plus the Wave 1 stub.
**Rejected:**
- Every AS through the CLI with an `**Entry point:**`. That forces T2 to depend on T3, so they sit in separate Waves, which breaks the pilot shape (the G1 run ended up the same way: T3 in Wave 3).
- Every AS through the CLI without the label. Validation passes, but T2 gets blocked on T3's handler.
**Deviation:** SC-001 says all four scenarios pass "through the real helper entry point". Here AS-004 does, and AS-001..003 pass through the public pure renderer that CT-1's Statement names. T3's handler test pins that the helper prints exactly `renderStopCheckPlan`'s lines, so the CLI adds nothing the renderer has not decided.

### AD-5: The contract Task ships a compiling stub of the core, and the stub resolves the unknown-task arm

**Choice:** T1 writes a stub `engine/src/core/acceptance-contract/stop-check-plan.ts` that exports both signatures. For an id absent from `graph.tasks`, the stub returns `unknown-task` (view and rendering, using the final message). For a known id, it returns `rendered{lines: ["stop-check-plan: not implemented"]}`, and the view is `off{no-runner}`. T1 also enrolls the stub's path and the types file in `DEFAULT_PURE_MODULES`.
**Why:**
- The acceptance file imports the module, so RED needs it to exist. A file that fails to load is not a behavioral RED.
- T3 imports `renderStopCheckPlan` without depending on T2. Same-Wave tasks must declare disjoint paths, and cross-Wave overlap is allowed (`validate-task-execution.ts:295-311`). That is how T2 and T3 share Wave 2.
- AS-004's unknown-id case then depends only on T3's handler and route. So T3's natural stops (M3) measure only T3's own work.

At Wave 1, every testcase still fails: AS-001..003 assert lines the stub does not produce, and AS-004 hits a route that does not yet exist.
**Rejected:**
- A stub that throws. T3's unknown-id AS-004 would then wait on T2.
- The shell resolving unknown ids. The user chose the core ADT arm (Q4).

### AD-6: Read-only shell with strict arguments

**Choice:**
- The handler copies `contract-status`. It resolves `taskGraphPath()` and calls `StateManager.fromPath`. A null result is refused as `No task graph at <path>`. Only `load()` sits inside the try, so a corrupt graph shows the parser's error and is never reported as missing. It writes nothing to the State File and takes no lock.
- Arguments go through `unconsumedValueArguments(args, {"--task"})` and `argumentValue(args, "--task")`. A missing `--task` or any unconsumed argument is refused with a non-zero exit (Q5).
- The route is added to `KNOWN_HANDLERS.helper` only. It is not in `WHITELISTED_HELPERS`, and it is not a Pi runtime-handshake route.

**Why:** NFR-001 and FR-005 ask for the existing helper pattern. A typo must never read as "nothing owed" (US3).

---

## File Structure

### Contract (Wave 1, T1; the types and acceptance files freeze at the Wave 1 gate)

```
engine/src/core/stop-check-plan-types.ts                          — NEW, declarations only: view ADT, off-reason union, rendering ADT, signature types, constant reason/header text (CT-1 types file, frozen)
engine/tests/acceptance/stop-check-plan.acceptance.test.ts        — NEW, CT-1 acceptance tests, testcases named `AS-00n: …` (frozen)
engine/tests/fixtures/stop-check-plan-fixtures.ts                 — NEW, parser-proven TaskGraphs with a frozen verification_manifest/acceptanceRunner (not frozen)
engine/src/core/acceptance-contract/stop-check-plan.ts            — NEW, compiling stub per AD-5 (not frozen; T2 replaces the body)
engine/src/linter/programmatic/no-io-in-pure-modules.ts           — MODIFY, enroll the types file and the core module in DEFAULT_PURE_MODULES
```

### Pure core (Wave 2, T2)

```
engine/src/core/acceptance-contract/stop-check-plan.ts            — MODIFY (from the stub), stopCheckPlanView + renderStopCheckPlan, pure and total
engine/tests/core/stop-check-plan.test.ts                         — NEW, unit + fast-check property tests of the pure core
```

### Helper shell (Wave 2, T3)

```
engine/src/handlers/helpers/stop-check-plan.ts                    — NEW, read-only handler (argument parsing, load boundary, exit mapping)
engine/src/handler-routes.ts                                      — MODIFY, add "stop-check-plan" to KNOWN_HANDLERS.helper only
engine/tests/handlers/helpers/stop-check-plan.test.ts             — NEW, handler tests + route-membership pins + CLI fidelity test
commands/loom.md                                                  — MODIFY, list the read-only helper beside contract-status (not whitelisted)
docs/operations.md                                                — MODIFY, operator usage section after "Where does each Acceptance Contract stand?"
CONTEXT.md                                                        — MODIFY, glossary entry "Stop-Check Plan"
```

---

## Component Design

### Stop-check plan types (CT-1 types file)

**Responsibility:** The frozen surface: the view the core projects, the rendering the shell consumes, the two signatures, and the fixed text the acceptance tests assert. It holds no logic.
**Files:** `engine/src/core/stop-check-plan-types.ts`
**Interface:**

```ts
import type { NonEmpty } from "./orchestration-contract";
import type { OwedAcceptance } from "./acceptance-contract";
import type { TaskGraph } from "../types";

/** Why the check would do nothing at this Task's stop. Exactly one, in this precedence. */
export type StopCheckOffReason =
  | Readonly<{ kind: "no-runner" }>
  | Readonly<{ kind: "nothing-owed" }>
  /** acceptanceRunnerCheck refused the owed files; `errors` is its refusal text. */
  | Readonly<{ kind: "command-refused"; errors: NonEmpty<string> }>;

/** The exact command the check would launch, read off acceptanceRunnerCheck's value. */
export type StopCheckRunnerCommand = Readonly<{
  /** executable followed by args after {files} expansion; each owed file (relative to cwd) is one element. */
  argv: NonEmpty<string>;
  cwd: string;
  reportPath: string;
}>;

export type StopCheckPlanView =
  | Readonly<{ kind: "unknown-task"; taskId: string }>
  | Readonly<{ kind: "off"; taskId: string; wave: number; reason: StopCheckOffReason }>
  | Readonly<{
      kind: "on";
      taskId: string;
      wave: number;
      /** stopCheckExpectation's `owed`, in its order. */
      owed: NonEmpty<OwedAcceptance>;
      /** stopCheckExpectation's `files`, repository-relative, in its order. */
      files: NonEmpty<string>;
      command: StopCheckRunnerCommand;
    }>;

export type StopCheckPlanRendering =
  | Readonly<{ kind: "rendered"; lines: NonEmpty<string> }>
  | Readonly<{ kind: "unknown-task"; taskId: string; message: string }>;

/** Project a TaskGraph and Task id into the plan view. Pure and total. */
export type StopCheckPlanViewFn = (graph: TaskGraph, taskId: string) => StopCheckPlanView;

/** Render the plan for one Task. Pure and total; never runs the runner. */
export type RenderStopCheckPlanFn = (graph: TaskGraph, taskId: string) => StopCheckPlanRendering;

export const STOP_CHECK_ON = "acceptance stop check on";
export const STOP_CHECK_OFF = "acceptance stop check off";
export const STOP_CHECK_OFF_REASON_TEXT: Readonly<Record<StopCheckOffReason["kind"], string>> = {
  "no-runner": "no acceptance runner is frozen in this TaskGraph",
  "nothing-owed": "this Task owes no frozen acceptance testcase due by its Wave",
  "command-refused": "the runner command could not be formed for the owed files",
};
export const UNKNOWN_TASK_PREFIX = "No task";
```

**Exact output grammar** (T1 asserts it and T2 produces it):
- The `on` view renders these lines, in order:
  - `${taskId} (Wave ${wave}): ${STOP_CHECK_ON}`;
  - for each `owed` entry in order, `${contractId}`, then each testcase as `  ${file} › ${name}`;
  - `files:`, then each file as `  ${file}`;
  - `cwd: ${cwd}`;
  - `argv: ${JSON.stringify(argv)}`, because a JSON array shows argument boundaries, so each file is visibly one argument;
  - `report: ${reportPath}`.
- The `off` view renders `${taskId} (Wave ${wave}): ${STOP_CHECK_OFF} — ${STOP_CHECK_OFF_REASON_TEXT[reason.kind]}`. For `command-refused`, each error follows as `  ${error}`.
- `unknown-task` gets the message `${UNKNOWN_TASK_PREFIX} ${taskId} in the TaskGraph`.

**Depends on:** none

### Stop-check plan core

**Responsibility:** Derive the view from the same four expressions `decideStop` uses (AD-2), then format it. Both steps are pure and total.
**Files:** `engine/src/core/acceptance-contract/stop-check-plan.ts`
**Interface:**

```ts
export const stopCheckPlanView: StopCheckPlanViewFn;
export const renderStopCheckPlan: RenderStopCheckPlanFn;
```

`stopCheckPlanView` works in this order:
1. Find the Task, or return `unknown-task`.
2. If there is no runner, return `off{no-runner}`.
3. Call `stopCheckExpectation(...)`. If it returns `none`, return `off{nothing-owed}`.
4. Call `acceptanceRunnerCheck(runner, check.files)`. If it returns `!ok`, return `off{command-refused, errors: command.error.errors}`.
5. Otherwise return `on`, with:
   - `argv = [command.value.executable, ...command.value.args]`;
   - `cwd = command.value.cwd`;
   - `reportPath = runner.report.path`, which is required-file by the `AcceptanceRunner` type.

The core imports its siblings directly (`./stop-check`, `../verification-manifest`, `../stop-check-plan-types`). It uses `ts-pattern` `.exhaustive()` over every union and `Object.freeze` on its outputs, as `contract-status.ts` does. It does no I/O, reads no clock and never throws.
**Depends on:** Stop-check plan types; `stopCheckExpectation` (`stop-check.ts`); `acceptanceRunnerCheck` (`verification-manifest.ts`)

### Stop-check plan helper (shell)

**Responsibility:** Parse `--task`, locate and load the TaskGraph read-only, call the renderer, and map the result to stdout or an exit code.
**Files:** `engine/src/handlers/helpers/stop-check-plan.ts`, `engine/src/handler-routes.ts`
**Interface:**

```ts
export function createStopCheckPlanHandler(
  write?: (text: string) => void,          // default: process.stdout.write
  render?: RenderStopCheckPlanFn,          // default: renderStopCheckPlan
): HookHandler;
export default createStopCheckPlanHandler();
```

The handler runs in this order:
1. Argument errors become `{kind:"error", message}`.
2. A missing graph becomes `{kind:"error", message:"No task graph at <path>"}`.
3. A load failure becomes `{kind:"error", message:<parser error>}`.
4. A `rendered` result is written as `lines.join("\n") + "\n"` and returns `{kind:"passthrough"}`.
5. An `unknown-task` result becomes `{kind:"error", message}`.

Only the load sits in a try. A throw from the renderer is a defect and crashes.
**Depends on:** Stop-check plan types; the core module's export (the Wave 1 stub, so there is no dependency on T2); `taskGraphPath`, `StateManager`, `cli-args`

---

## Data Flow

```
argv --task ─► shell: parse args ─► taskGraphPath() ─► StateManager.load() (read-only, no lock)
                                                          │ TaskGraph
                                                          ▼
         core: find Task ─► runner? ─► stopCheckExpectation ─► acceptanceRunnerCheck ─► StopCheckPlanView
                                                          ▼
                                    renderStopCheckPlan ─► rendered{lines} | unknown-task
                                                          ▼
                                     shell: stdout + exit 0  |  error + non-zero exit
```

Every owed fact and the command come from the live check's own functions. The core only selects and formats.

---

## Contracts

### CT-1: Stop-check plan rendering

**Types file:** `engine/src/core/stop-check-plan-types.ts`
**Acceptance tests:**
- `engine/tests/acceptance/stop-check-plan.acceptance.test.ts` — AS-001, AS-002, AS-003, AS-004
**Statement:** `renderStopCheckPlan(graph, taskId)` is total over every parsed TaskGraph and reuses `stopCheckExpectation` and `acceptanceRunnerCheck`. It never re-derives what is owed, and it never runs the runner.

No `**Entry point:**` is declared, by design: see AD-4. Declaring T3's handler would make plan validation refuse T2's same-Wave claim.

Acceptance test shape (T1). Every fixture graph is first proven loadable by the production parser (`protectedGraphFixture`) and carries a manifest built with `freezeVerificationManifest`.
- **AS-001, AS-002 and AS-003** call `renderStopCheckPlan(graph, taskId)` imported from `engine/src/core/acceptance-contract/stop-check-plan.ts`. They assert the exact lines from the grammar above.
  - AS-001: one Task claims anchors of a frozen contract due by its Wave, and its roster spans two files under the runner cwd `engine`. The test checks the header, each owed testcase under its contract id, the distinct files, `cwd: engine`, an argv whose JSON holds each file with the `engine/` prefix removed as its own element in place of `{files}`, and the report path.
  - AS-002: a roster testcase that also carries an anchor claimed by a later-Wave Task is absent from the lines.
  - AS-003: one testcase per cause, each asserting the single off line:
    - no runner (the graph has a frozen contract the Task claims, but no `acceptanceRunner`; this proves the precedence);
    - the Task claims nothing;
    - the contract is `awaiting-red`;
    - the anchors are not yet due;
    - the owed file is outside the runner cwd, which gives `command-refused` with `acceptanceRunnerCheck`'s refusal text.
- **AS-004** spawns `bun engine/src/cli.ts helper stop-check-plan --task <id>` from the repository root, with `LOOM_STATE_PATH` naming a fixture State File in a canonical temp dir.
  - An unknown id gives a non-zero exit and stderr containing the id.
  - A missing State File gives a non-zero exit and stderr containing the path it looked for.

At the Wave 1 gate, every testcase is collected and fails on its assertions, so the RED is behavioral. AS-001..003 fail against the stub's lines, and AS-004 fails because the route does not exist yet.

---

## Implementation Phases

### Phase 1: Contract (no dependencies)

- T1, the contract Task for CT-1. It claims nothing; it lists AS-001..AS-004 in `spec_contributions`.
  - Write the types file exactly as specified in Component Design.
  - Write the fixture module. It reuses `task`, `contract`, `surface`, `gitProject`, `writeStateFile` and `statePathIn` from `contract-status-fixtures.ts`, and adds:
    - `frozenRunnerManifest(runner?)`, built with `freezeVerificationManifest`, as in `tests/handlers/subagent-stop/acceptance-stop-check.test.ts`;
    - a parser-proven graph builder that takes `{tasks, contracts, manifest}` and returns both the parsed `TaskGraph` and its JSON text.
  - Write the acceptance file described under Contracts, with testcase names prefixed `AS-00n: …`.
  - Write the AD-5 compiling stub.
  - Enroll both core paths in `DEFAULT_PURE_MODULES`.
  - The types file and stub must typecheck, and `npm run verify` must be red only in the acceptance file.
- **Files:** `engine/src/core/stop-check-plan-types.ts`, `engine/tests/acceptance/stop-check-plan.acceptance.test.ts`, `engine/tests/fixtures/stop-check-plan-fixtures.ts`, `engine/src/core/acceptance-contract/stop-check-plan.ts`, `engine/src/linter/programmatic/no-io-in-pure-modules.ts`

### Phase 2: Core and helper (depends on Phase 1; T2 and T3 run concurrently)

- T2, the pure core. It claims AS-001, AS-002 and AS-003 (FR-001..FR-004) and depends on T1.
  - Replace the stub body with `stopCheckPlanView` and `renderStopCheckPlan` per AD-2, AD-3 and the output grammar.
  - Keep the unknown-task arm byte-for-byte identical in behavior to the stub.
  - Write unit and property tests.
  - Never edit the frozen types or acceptance files.
  - **Files:** `engine/src/core/acceptance-contract/stop-check-plan.ts`, `engine/tests/core/stop-check-plan.test.ts`
- T3, the helper, route and docs. It claims AS-004 (FR-005) and depends on T1 only. It imports `renderStopCheckPlan` from the module path T1 created, never T2's work.
  - Implement the handler per AD-6.
  - Add `"stop-check-plan"` to `KNOWN_HANDLERS.helper` only.
  - Write the handler tests.
  - Document the helper in `commands/loom.md` beside `contract-status`, in a usage section in `docs/operations.md` after "Where does each Acceptance Contract stand?", and in a `CONTEXT.md` glossary entry "Stop-Check Plan".
  - **Files:** `engine/src/handlers/helpers/stop-check-plan.ts`, `engine/src/handler-routes.ts`, `engine/tests/handlers/helpers/stop-check-plan.test.ts`, `commands/loom.md`, `docs/operations.md`, `CONTEXT.md`

Note for decompose:
- T2 and T3 declare disjoint paths and both depend only on T1, so they share Wave 2. This is required by the pilot, which wants concurrent claimants for runner-lock contention (M4).
- Wave 1 through Wave 2 is the red window, so all three Tasks carry `acceptance-red-window`.
- There are no ADR tasks. If decompose adds one for AD-1 or AD-4, it goes in a final Wave 3.

---

## Testing Strategy

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| Stop-check plan types | n/a (declarations; `typecheck` covers them) | — | — |
| Stop-check plan core | Each view arm and each off-reason. The precedence order (no runner wins over nothing owed; nothing owed wins over command refused). `on.owed` and `on.files` equal `stopCheckExpectation`'s output, and `argv` equals `[executable, ...acceptanceRunnerCheck(...).value.args]`, both asserted by calling those functions on the same graph. cwd `"."` passes files unchanged. The exact line grammar. An unknown id gives `unknown-task` with the id in its message. | — | fast-check over Task rosters, contracts in each freeze state, and runner-or-none: never throws; the rendering is always `rendered` with at least one line, or `unknown-task` exactly when the id is absent from `graph.tasks`; the view is `on` exactly when the runner exists, `stopCheckExpectation` is `owed` and `acceptanceRunnerCheck` is `ok`; every owed testcase name appears exactly once in `on` lines |
| Stop-check plan helper | With injected `write` and `render`: a missing `--task`, a valueless `--task` and an extra argument are each refused. A missing graph gives an error naming the path. A corrupt graph gives the parser's message, never "missing". `unknown-task` maps to an error. The State File bytes and mtime are unchanged and no lock file appears (FR-005). Route pins: in `KNOWN_HANDLERS.helper`, absent from `WHITELISTED_HELPERS`, and `piRuntimeHandshakeRequired("helper","stop-check-plan")` is false. | A CLI fidelity test: spawn the real `cli.ts` on an `on` fixture and assert that stdout equals `renderStopCheckPlan(graph, id)`'s lines joined. This holds whether T2 has landed or not, so T3 stays independent. The CT-1 acceptance file is owned by T1 and frozen. | — |

Regression: `npm run verify`. `tests/machine/hooks-sync.test.ts`, the `tests/e2e/cli-*` route tests and the purity linter test must stay green.

---

## Security & NFR Notes

- **Security:** No new trust boundary. The State File is read through the existing `StateManager` no-follow anchored read. The `--task` value is only compared with Task ids and echoed as plain text. Nothing is executed: the runner command is formatted, never spawned (OOS-001).
- **Performance:** One file read, then a linear projection over contracts and Tasks.

---

## Verification

1. `cd engine && npm run typecheck`
2. `npm run verify` from the repository root (`project:verify`). At the Wave 1 gate, every CT-1 testcase is observed RED and CT-1 freezes. At the Wave 2 gate, AS-001..AS-004 are due and passing, and the frozen digests are intact.
3. During the pilot, run `bun engine/src/cli.ts helper stop-check-plan --task T2` (and `--task T3`) against the live State File after Wave 1. T2 should list CT-1's AS-001..AS-003 testcases, `cwd: engine`, an argv ending in `"tests/acceptance/stop-check-plan.acceptance.test.ts"`, and `report: .loom/completion-reports/acceptance.junit.xml`. T1 should render off with "nothing owed". `--task T9` should be refused with a non-zero exit.
