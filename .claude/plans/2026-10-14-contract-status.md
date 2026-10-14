# Plan: Contract Status — read-only `helper contract-status`

**Spec:** .claude/specs/2026-10-14-contract-status/spec.md
**Created:** 2026-10-14

## Summary

`helper contract-status` prints every Acceptance Contract's freeze state, its roster, the due Wave of each covered anchor, and its revisions. It reads the State File once, never locks it and never writes it. The design is a pure view projection plus a renderer (`contractStatusView` gives the view ADT, `renderContractStatus` gives the lines) in `engine/src/core/contract-status.ts`, behind a thin read-only helper. This feature is the G1 live pilot (`.claude/plans/2026-10-14-g1-live-pilot.md`). It has two Waves and three Tasks, and contract CT-1 is frozen at Wave 1.

---

## Architectural Decisions

### AD-1: View ADT plus renderer, chosen over a single string builder

**Choice:** A two-step pure core. `contractStatusView(graph)` projects the parsed TaskGraph into `readonly ContractStatusView[]`. A freeze display union (`awaiting-red | frozen{wave, roster} | revised{revisions, paths}`) and a per-anchor `AnchorDue = {kind:"wave", wave} | {kind:"unclaimed"}` make every case explicit. `renderContractStatus(graph)` projects and then formats lines with an exhaustive `ts-pattern` match. The view types and both function signature types live in the frozen `engine/src/core/contract-status-types.ts`.
**Why:** "Unclaimed" and the three freeze states are real sum types. Naming them in the frozen surface means the renderer cannot drop a case. It also lets unit tests check derivation (due Waves) separately from formatting. The user picked this at the approach gate (it was also the recommendation).
**Rejected:**
- Single `renderContractStatus` string builder — mixes the due/unclaimed derivation into string building, so tests can only assert on text.
- Exporting the view as a public reuse point for JSON output — designs for OOS-003 (machine-readable output is out of scope).

**Minor decisions (not ADR-worthy; recorded here for implementers, no ADR task):**
- **Route placement.** `contract-status` goes only in `KNOWN_HANDLERS.helper` (`engine/src/handler-routes.ts`). It is NOT added to `WHITELISTED_HELPERS` (`config.ts`; that list is for the guard and covers state writers) and NOT added to `PI_RUNTIME_HANDSHAKE_ROUTES` (routes that mutate protected state). The helper is read-only, so it needs neither. A test pins all three memberships.
- **Corrupt graph.** A present but unparseable or unreadable State File gives an error exit carrying the `StateManager.load()` message, the same way `revise-contract` does. It is not treated as missing. A missing graph (`StateManager.fromPath` returns `null`) is refused with the path it looked for. On a parsed graph the core never throws.
- **Output channel.** Lines go to stdout, joined with `\n` and ending in a newline, with exit 0 (`passthrough`). Refusals use `{ kind: "error" }`.
- **Revised contracts.** A `revised` freeze carries no roster (`AcceptanceFreeze.revised` drops it until the next Wave Gate re-records it). It renders as `revised (N revisions); roster cleared until the next Wave Gate re-records it`, followed by its frozen paths.
- **Due-Wave rule has one owner.** `dueWaves` (`engine/src/core/acceptance-contract/tasks.ts:109`, the latest Wave of a claiming Task, absent when nobody claims it) is exported from the curated `engine/src/core/acceptance-contract/index.ts` and reused. It is not re-derived. An absent anchor maps to `{kind:"unclaimed"}`.
- **Defaults confirmed in the interview.** Pure functional core with errors at the boundary. Simplicity is the primary axis. Stateless, synchronous, one read. No persistence or migration. Greenfield helper. No new dependencies (`ts-pattern` and `fast-check` are already present). Ships inside the engine. Spec OOS-001..003 are excluded. No lifecycle, pipeline or invariant models.

---

## File Structure

### Contract (Wave 1, frozen at the Wave 1 gate)

```
engine/src/core/contract-status-types.ts                     — NEW, declarations only: view ADT + signature types
engine/tests/acceptance/contract-status.acceptance.test.ts   — NEW, acceptance tests through the real CLI entry point
```

### Pure core (Wave 2)

```
engine/src/core/contract-status.ts                           — NEW, contractStatusView + renderContractStatus (pure)
engine/src/core/acceptance-contract/index.ts                 — MODIFY, re-export dueWaves
engine/src/linter/programmatic/no-io-in-pure-modules.ts      — MODIFY, enroll core/contract-status.ts (and the types file) in DEFAULT_PURE_MODULES
engine/tests/core/contract-status.test.ts                    — NEW, unit + property tests of the pure core
```

### Helper shell (Wave 2)

```
engine/src/handlers/helpers/contract-status.ts               — NEW, read-only handler
engine/src/handler-routes.ts                                 — MODIFY, add "contract-status" to KNOWN_HANDLERS.helper only
engine/tests/handlers/helpers/contract-status.test.ts        — NEW, handler + route-membership tests
commands/loom.md                                             — MODIFY, list the read-only helper (not under "Whitelisted in the guard")
docs/operations.md                                           — MODIFY, operator usage beside revise-contract
CONTEXT.md                                                   — MODIFY, glossary entry "Contract Status"
```

---

## Component Design

### Contract status types (CT-1 types file)

**Responsibility:** The frozen, declarations-only surface that the core, the shell and the acceptance tests share.
**Files:** `engine/src/core/contract-status-types.ts`
**Interface:**

```
import type { AcceptanceTestcase, FrozenPathDigest } from "./acceptance-contract";
import type { ParsedTaskGraph } from "../state-file-wire";   // type-only

export type AnchorDue =
  | Readonly<{ kind: "wave"; wave: number }>
  | Readonly<{ kind: "unclaimed" }>;

export type CoveredAnchorStatus = Readonly<{ anchor: string; due: AnchorDue }>;

export type ContractFreezeStatus =
  | Readonly<{ state: "awaiting-red" }>
  | Readonly<{ state: "frozen"; wave: number; roster: readonly AcceptanceTestcase[] }>
  | Readonly<{ state: "revised"; revisions: number; paths: readonly FrozenPathDigest[] }>;

export type ContractStatusView = Readonly<{
  id: string;
  title: string;
  contractTask: string;
  freeze: ContractFreezeStatus;
  covered: readonly CoveredAnchorStatus[];   // in coveredAnchors() order
  revisions: number;
}>;

export type ContractStatusViewFn = (graph: ParsedTaskGraph) => readonly ContractStatusView[];
export type RenderContractStatusFn = (graph: ParsedTaskGraph) => readonly string[];

export const NO_ACCEPTANCE_CONTRACTS = "no Acceptance Contracts";   // the single FR-006 line
```

(A `const` string literal is the only value allowed. Everything else is a type.)

**Depends on:** none (type imports only)

### Contract status core

**Responsibility:** Project a parsed TaskGraph into contract status views and render them as lines. Pure and total.
**Files:** `engine/src/core/contract-status.ts`, `engine/src/core/acceptance-contract/index.ts`
**Interface:**

```
export const contractStatusView: ContractStatusViewFn;
export const renderContractStatus: RenderContractStatusFn;
```

- Contracts render in TaskGraph order (`graph.acceptance_contracts ?? []`). An empty list renders `[NO_ACCEPTANCE_CONTRACTS]`.
- `covered`: `coveredAnchors(contract)` mapped through `dueWaves(contract, graph.tasks)`. An absent anchor becomes `unclaimed`.
- Per contract, the lines are: a header (`CT-1  <title>  (contract Task T1)`); the freeze line (`awaiting RED` / `frozen at Wave N` / `revised (N revisions); roster cleared until the next Wave Gate re-records it`); then for `frozen`, one line per roster testcase (`<file> › <name> — AS-001, AS-002`); for `revised`, one line per frozen path; then one line per covered anchor (`AS-001 due Wave 2` / `AS-003 unclaimed`); and when there is at least one revision, `revisions: N`.
- Matching over `freeze.state` and `due.kind` is exhaustive (`match(...).exhaustive()`). No filesystem access, no clock, no throw.

**Depends on:** Contract status types; `acceptance-contract` (`coveredAnchors`, `dueWaves`).

### Contract status helper (shell)

**Responsibility:** Read the State File once, without the lock, and print the rendered lines. Refuse a missing graph and surface an unparseable one.
**Files:** `engine/src/handlers/helpers/contract-status.ts`, `engine/src/handler-routes.ts`
**Interface:**

```
export function createContractStatusHandler(write?: (text: string) => void): HookHandler;
export default createContractStatusHandler();   // writes to process.stdout
```

Flow: `taskGraphPath()` → `StateManager.fromPath(path)`. A `null` result gives `{kind:"error", message:"No task graph at <path>"}`. Otherwise `manager.load()` runs inside a try block, and a throw gives `{kind:"error", message}`. Then `write(renderContractStatus(graph).join("\n") + "\n")` and `{kind:"passthrough"}`. The handler never calls `update*` and never takes the lock. It takes no arguments.

**Depends on:** Contract status core.

---

## Data Flow

```
LOOM_STATE_PATH / taskGraphPath() → StateManager.fromPath → load() (parse; no lock)
  → contractStatusView (pure) → renderContractStatus (pure) → stdout, exit 0
```

The only I/O is the single read and the write to stdout. Everything between them is a function of `ParsedTaskGraph`.

---

## Contracts

### CT-1: Contract status rendering

**Types file:** `engine/src/core/contract-status-types.ts`
**Acceptance tests:**
- `engine/tests/acceptance/contract-status.acceptance.test.ts` — AS-001, AS-002, AS-003, AS-004
**Statement:** `renderContractStatus(graph)` is total over every parsed TaskGraph and returns lines, never throws on a parsed graph; the helper refuses a missing TaskGraph with its path and surfaces an unparseable one's error.

Acceptance test shape (T1): every testcase spawns the real entry point, `bun engine/src/cli.ts helper contract-status`, with `LOOM_STATE_PATH` pointed at a fixture State File in a canonical temp dir, and asserts on stdout, stderr and the exit code. Testcase names start with their anchor (`AS-001: …`, `AS-004: …`). AS-004 has two testcases: no contracts, which prints `no Acceptance Contracts` and exits 0; and a missing graph, which is refused and names the path. Before T3 the route does not exist, so every testcase loads and fails on its assertions. That is a behavioral RED, not a load failure. The project's verification manifest already exists (`.loom/verification-manifest.json`, `project:verify`, JUnit at `.loom/completion-reports/verify.junit.xml`), so no manifest work is needed.

---

## Implementation Phases

### Phase 1: Contract (no dependencies)

- T1, the contract Task for CT-1. Write the declarations-only types file and the acceptance test file described above. Use fixtures from `engine/tests/fixtures/` (`acceptance-fixtures`, `task-lifecycle`, `canonical-temp-dir`) to build State Files with: an `awaiting-red` contract and a contract `frozen` at Wave N (AS-001); a frozen roster whose anchors include one claimed anchor and one unclaimed anchor (AS-002); a `revised` contract with recorded revisions (AS-003); a graph with no contracts, and no graph at all (AS-004). No implementation stub is needed, because the tests reach the code only through the CLI route that T3 adds. The types file compiles alone.
- **Files:** `engine/src/core/contract-status-types.ts`, `engine/tests/acceptance/contract-status.acceptance.test.ts`

### Phase 2: Core and helper (depends on Phase 1)

- T2, the pure core (claims AS-001, AS-002, AS-003; depends on T1). Implement `contractStatusView` and `renderContractStatus`. Re-export `dueWaves` from the curated `acceptance-contract/index.ts`. Enroll `engine/src/core/contract-status.ts` and `engine/src/core/contract-status-types.ts` in `DEFAULT_PURE_MODULES`. Write unit and property tests.
  - **Files:** `engine/src/core/contract-status.ts`, `engine/src/core/acceptance-contract/index.ts`, `engine/src/linter/programmatic/no-io-in-pure-modules.ts`, `engine/tests/core/contract-status.test.ts`
- T3, the helper, route and docs (claims AS-004; depends on T1 and T2, because the handler imports `renderContractStatus`). Implement the handler and add the route to `KNOWN_HANDLERS.helper` only. Write handler tests that pin the route memberships. Update `commands/loom.md`, `docs/operations.md` and `CONTEXT.md`.
  - **Files:** `engine/src/handlers/helpers/contract-status.ts`, `engine/src/handler-routes.ts`, `engine/tests/handlers/helpers/contract-status.test.ts`, `commands/loom.md`, `docs/operations.md`, `CONTEXT.md`

Note for decompose: T3 imports T2's export, so T3 depends on T2 inside Wave 2. If parallelism within the Wave matters more, T3 can code against `RenderContractStatusFn` from the frozen types file, but its tests need T2. Keep the dependency. Wave 1 through Wave 2 is the red window, so all three Tasks carry `acceptance-red-window`.

---

## Testing Strategy

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| Contract status types | n/a (declarations; `typecheck` covers them) | — | — |
| Contract status core | Each freeze state renders its line. Roster lines carry anchors. Claimed anchors get the latest claiming Wave and unclaimed anchors read "unclaimed". The revision count shows. Contracts keep TaskGraph order. An empty graph gives exactly `["no Acceptance Contracts"]`. | — | fast-check over arbitrary `AcceptanceContract[]` and task rosters: never throws; the output is non-empty; the header count equals the contract count; every covered anchor appears exactly once per contract |
| Contract status helper | Injected `write` captures stdout. A missing graph gives an error naming the path. A corrupt graph gives an error carrying the parser message. The State File bytes are unchanged after a run and no lock file is left behind (FR-005). Route memberships: in `KNOWN_HANDLERS.helper`, absent from `WHITELISTED_HELPERS`, `piRuntimeHandshakeRequired("helper","contract-status")` is false. | CT-1 acceptance file through the real `cli.ts` (owned by T1, frozen) | — |

Regression: `npm run verify` (typecheck, unit, smoke). The existing `tests/machine/hooks-sync.test.ts` and `tests/e2e/cli-*` route tests must stay green with the new route.

---

## Security & NFR Notes

- **Security:** No new trust boundary. The helper reads the TaskGraph through the existing `StateManager` no-follow anchored read, takes no arguments and writes only to stdout. Testcase names and titles come from engine-written state and are printed as plain text.
- **Performance:** One file read and a linear render.

---

## Verification

1. `cd engine && npm run typecheck`
2. `npm run verify` from the repo root (the `project:verify` check). At the Wave 1 gate the CT-1 testcases are observed RED and the contract is frozen. At the Wave 2 gate all four anchors are due and passing, and the frozen digests are intact.
3. Manually, during the pilot: `bun engine/src/cli.ts helper contract-status` against the live `.claude/state/active_task_graph.json` after Wave 1. It should show CT-1 frozen at Wave 1, with AS-001..003 due at Wave 2 (T2) and AS-004 due at Wave 2 (T3).
