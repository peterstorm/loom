# Plan: Ledger Epoch View

**Spec:** .claude/specs/2026-10-20-ledger-epoch-view/spec.md
**Created:** 2026-10-20

## Summary

`bun scripts/ledger-epoch.ts` prints one epoch of a session's evidence ledger, numbered exactly as I6 settlement cites positions. Without an agent, it lists the session's epochs. A pure core in `engine/src/core/ledger-epoch-view.ts` turns the parsed records and a parsed query into output lines. It reaches the facts only through the engine's own `eventsForEpoch`, so its positions are settlement's positions by construction. The script is a thin shell. It reads the command line through the helper shell's flag reader, finds the ledger with the engine's `ledgerPath` (which follows `LOOM_SUBAGENT_DIR` or its default) and reads it with the engine's `readEvidence`. It prints the lines to stdout. Refusals go to stderr with a non-zero exit.

This feature is also the vehicle for the G4 slice 2 re-pilot (`.claude/plans/2026-10-20-g4-slice-2-repilot.md`). The plan deliberately produces that run plan's expected decomposition: 2 Waves and 3 Tasks.

---

## Interview Decisions (operator-settled)

The operator delegated the interview and the approach gate and recorded these answers in the phase prompt:

- **Codebase constraints:** a brownfield extension of the engine. The core goes in `engine/src/core/`, the script in `scripts/` beside the other operator scripts, and the script is typechecked through `engine/tsconfig.json`.
- **Testability bar:** a pure functional core, at least 90% unit testable with no mocks. Either/Result at the script boundary.
- **Primary NFR axis:** simplicity.
- **Concurrency and state:** stateless and read-only, with no persistence and no locks. The script never writes, truncates or creates a file, including the subagent directory (FR-006).
- **Data model:** none of its own. It reuses `EvidenceRecord`, `Evidence`, `Epoch`, `TestReportSummary` and `TestFileResult` unchanged.
- **Sensitive boundaries:** only a local JSONL file is read. Session, agent and agent-type ids go through the engine's smart constructors (`parseSessionId`, `parseAgentId`, `parseAgentType`), which refuse separators and `..`, so no command-line value can address a file outside the subagent directory.
- **Tech preferences:** no new dependencies. Reuse the engine's ledger parser (`readEvidence` / `parseEvidenceLine`), `eventsForEpoch`, `epochOf` and the subagent-directory resolution (`ledgerPath` → `subagentDir()`). Never reimplement them.
- **Observability:** none beyond the output. Refusals name their cause, for example the path looked for or the corrupt line.
- **Error handling:** results are values (`DomainResult`) in the core and the shell. Only the shell's I/O step catches a throw (`readEvidence`'s corrupt-ledger error) and turns it into a refusal. A throw from the pure renderer is a defect and crashes.
- **Backwards compatibility and migration:** none. This is a new read-only tool and the ledger wire format is unchanged.
- **Deployment:** run in place with `bun scripts/ledger-epoch.ts` from the repository. Nothing is registered with the helper router or the hooks.
- **Out of scope:** judging I6 (OOS-001), Pi grant epochs (OOS-002) and JSON output (OOS-003).

Approach (operator-delegated): a pure renderer in the core, with a thin script shell that reuses the engine's ledger I/O. The alternatives are recorded under Architectural Decisions.

---

## Architectural Decisions

Recorded as prose on purpose. The operator asked for no ADR Tasks, so this section has no AD blocks.

- **The core folds through `eventsForEpoch` itself, and the shell never pre-filters.** The core takes the whole `readonly EvidenceRecord[]` and the parsed query, and it calls `eventsForEpoch(records, epoch)` from `engine/src/machine/evidence.ts`, which is pure and enrolled. A fact's position is its index in that array. This is the same array settlement hands `judgeRedThenGreen` (`claudeEpochLedger` in `update-task-status.ts`, and `claudeLiveAttemptEvidence` in `stop-check-plan.ts`). The epoch index uses the same fold: each distinct epoch in first-appearance order, counted as `eventsForEpoch(records, epoch).length`. That way the index count and the rendered epoch can never disagree. *Rejected:* having the shell pass pre-folded `Evidence[]`. That would split "which facts and in what order" across two layers, and the index view still needs the raw records.
- **The core imports only enrolled pure modules.** Those are `machine/evidence.ts`, `machine/types.ts`, `core/structured-test-report.ts` (types), `core/orchestration-contract/identity.ts` (`DomainResult`) and `ts-pattern`. The executable purity-closure audit (`tests/linter/programmatic/machine-purity.test.ts`) requires every transitive dependency of an enrolled module to be enrolled. It must never import `machine/index.ts`, which re-exports the fs shell `ledger.ts`.
- **Argument grammar: flag reading stays in the shell and the decision is pure.** The script reads `--session`, `--agent` and `--type` with `argumentValue` and `unconsumedValueArguments` from `engine/src/handlers/helpers/cli-args.ts`. That module is the engine's one flag reader, and its header records why copies drifted. The core's `parseLedgerEpochQuery` takes the raw values plus the unconsumed tokens. It applies the smart constructors and the rule that `--agent` and `--type` are given together or not at all, and it returns `DomainResult<LedgerEpochQuery, string>`. *Rejected:* a third hand-rolled flag reader in core, like `parseContextSectionArguments`, because it repeats the drift cli-args exists to stop. Also rejected: importing cli-args from core. No core module imports from `handlers/`, and doing so would invert the layering.
- **A missing ledger is a refusal, not an empty session.** `readEvidence` reads an absent ledger as `[]`, which is correct for gates but would read as "the agent recorded nothing", the exact confusion US3 forbids. So the shell checks that `ledgerPath(session)` exists (`existsSync`) before it calls `readEvidence`, and refuses naming that path. A ledger deleted between the check and the read (the SessionStart stale sweep) would render as empty. That is accepted as a benign race for a read-only operator tool. **Amended in the PR #125 review (advisory `architecture-tech-lead-1`):** the absent-versus-empty rule now lives in the engine. `readEvidenceLedger` in `machine/ledger.ts` returns `absent | refused | records`, and `readEvidence` is expressed through it with unchanged behavior and messages. The shell matches on that result, so there is no `existsSync` probe, no try/catch, and no check-then-read window.
- **The corrupt-line refusal relays the engine's own message.** `readEvidence` throws `evidence ledger <path> is corrupt; refusing partial evidence: line N: <error>`, and the shell writes that message unchanged. "Line N" counts non-blank lines, because `readEvidence` drops blank lines before numbering them. The appender never writes a blank line before the tail, so in practice it is the physical line. *Rejected:* re-splitting and re-parsing the file in the script to number physical lines, which would reimplement the reader.
- **Exit codes.** 0 for a rendered view, including an empty epoch and a ledger with no epochs. 1 for a ledger refusal: no ledger file, or an unreadable or corrupt one. 2 for a usage refusal, which prints the usage text. Usage and refusals go to stderr, and stdout stays empty on every refusal.
- **Output format: plain lines and positions written `#N`.** The format matches how I6 evidence and the run plan cite positions (`red #3`). Exact layout is under Component Design. A record's `callId` is not printed: settlement cites positions only, and FR-001 asks for the facts.
- **Deviation from the executable-models policy, recorded.** The spec has test-decidable behavior (AS-001..AS-005), which the policy would normally turn into a `## Contracts` Task. The operator has excluded Contracts so that the re-pilot's 3-Task shape holds. The same acceptance scenarios are instead decided by T2's subprocess tests through the real entry point (SC-001) and by T1's unit tests.

---

## File Structure

### Ledger Epoch View core (Wave 1, T1)

```
engine/src/core/ledger-epoch-view.ts                      — NEW pure core: query parsing decision, epoch rendering, epoch index rendering, usage text
engine/tests/core/ledger-epoch-view.test.ts               — NEW unit + property tests of the core (no I/O, no mocks)
engine/src/linter/programmatic/no-io-in-pure-modules.ts   — MODIFY: enroll engine/src/core/ledger-epoch-view.ts in DEFAULT_PURE_MODULES
```

### Ledger Epoch script (Wave 2, T2)

```
scripts/ledger-epoch.ts                                   — NEW imperative shell: argv → query → ledger read → render → stdout / stderr + exit code
engine/tests/scripts/ledger-epoch.test.ts                 — NEW subprocess tests driving `bun scripts/ledger-epoch.ts` against a temp LOOM_SUBAGENT_DIR
engine/tsconfig.json                                      — MODIFY: add "../scripts/ledger-epoch.ts" to "include"
```

### Operator documentation (Wave 2, T3)

```
docs/operations.md                                        — MODIFY: new section "Reading an attempt's ledger epoch"
```

---

## Component Design

### Ledger Epoch View (pure core)

**Responsibility:** decide the query from raw argument values, and render one epoch's facts or the session's epoch index as lines, totally and purely.
**Files:** `engine/src/core/ledger-epoch-view.ts`
**Interface:**

```ts
import type { DomainResult } from "./orchestration-contract/identity";
import type { Epoch, EvidenceRecord } from "../machine/types";
import type { SessionId } from "../machine/evidence";

/** What the operator asked for, parsed (never raw strings). */
export type LedgerEpochQuery =
  | Readonly<{ kind: "epoch"; session: SessionId; epoch: Epoch }>   // --session S --agent A --type T
  | Readonly<{ kind: "index"; session: SessionId }>;                // --session S

/** Raw command-line facts the shell read with cli-args (null = absent/flag-valued). */
export type LedgerEpochArguments = Readonly<{
  session: string | null;
  agent: string | null;
  type: string | null;
  unconsumed: readonly string[];
}>;

/** Usage text the shell prints on a usage refusal. */
export const LEDGER_EPOCH_USAGE: string;
// "usage: bun scripts/ledger-epoch.ts --session <session-id> [--agent <agent-id> --type <agent-type>]"

/**
 * Pure decision. Refuses (error = one-line reason; the shell adds usage):
 *  - unconsumed/unknown tokens (names them)
 *  - missing --session
 *  - exactly one of --agent / --type
 *  - a value its smart constructor rejects (parseSessionId / parseAgentId / parseAgentType), naming the flag
 * Builds the epoch with epochOf(agentId, agentType).
 */
export function parseLedgerEpochQuery(args: LedgerEpochArguments): DomainResult<LedgerEpochQuery, string>;

/** Total over every record parseEvidenceLine admits; dispatches with ts-pattern .exhaustive(). */
export function renderLedgerEpochView(records: readonly EvidenceRecord[], query: LedgerEpochQuery): readonly string[];

// Exported for direct unit tests; renderLedgerEpochView composes them.
export function renderEpoch(records: readonly EvidenceRecord[], epoch: Epoch): readonly string[];
export function renderEpochIndex(records: readonly EvidenceRecord[]): readonly string[];
```

**Rendering contract.** Implementation agents keep this layout. The wording may be tightened, but every element must be present.

- Epoch header: `epoch <agentId>:<agentType> — <n> fact(s)`. An empty epoch renders `epoch <epoch> holds no facts` as its only line, and that is not a refusal (AS-005).
- One line per fact, `#<position> <Kind> …`, where position is the 0-based index in `eventsForEpoch(records, epoch)`:
  - `#N FileWrite <path> (via tool|shell)`
  - `#N FileRead <path>`
  - `#N TestRun <command>`, followed by indented detail lines:
    - `exit <code>` or `exit none recorded`
    - report `null` → `no structured report`
    - report present → `report <source>: total <t>, failed <f>`, then:
      - `files.kind === "unrecorded"` → `per-file results not recorded`
      - `files.kind === "recorded"` → one line per result in report order: `<file>: executed <e>, failed <f>, skipped <s>`, with `, collection error` appended when `collectionError`. An empty `results` list renders `no per-file results`.
- Epoch index: the header `<n> epoch(s)`, then one line per distinct epoch in first-appearance order, `<epoch> — <count> fact(s)`, where count is `eventsForEpoch(records, epoch).length`. A ledger that exists and holds no records renders `ledger holds no epochs`.
- The renderer is a pure function of `(records, query)`. It takes no path or clock and prints no `callId`. Values are rendered as recorded, not escaped or truncated: it is a faithful view, and OOS-003 excludes machine output.

**Depends on:** `machine/evidence.ts` (`eventsForEpoch`, `epochOf`, `parseSessionId`, `parseAgentId`, `parseAgentType`), `machine/types.ts`, `core/structured-test-report.ts` (types only), `core/orchestration-contract/identity.ts`, `ts-pattern`. All of these are already in the pure closure.

### Ledger Epoch script (imperative shell)

**Responsibility:** perform the I/O around the core: argv, ledger location and read, stdout, stderr and the exit code. It is read-only.
**Files:** `scripts/ledger-epoch.ts`
**Interface:**

```
bun scripts/ledger-epoch.ts --session <session-id> [--agent <agent-id> --type <agent-type>]

Flow (each step yields DomainResult; first failure short-circuits):
  1. argv = process.argv.slice(2)
     raw  = { session: argumentValue(argv,"--session"), agent: argumentValue(argv,"--agent"),
              type: argumentValue(argv,"--type"),
              unconsumed: unconsumedValueArguments(argv, {"--session","--agent","--type"}) }
     query = parseLedgerEpochQuery(raw)          — error → stderr "<reason>\n<LEDGER_EPOCH_USAGE>", exit 2
  2. path = ledgerPath(query.session)            — engine/src/machine/ledger.ts (subagentDir(): LOOM_SUBAGENT_DIR ?? default)
     !existsSync(path)                           — stderr "ledger-epoch: no evidence ledger at <path>", exit 1
  3. records = readEvidence(query.session)       — throw (corrupt line / unreadable) → stderr "ledger-epoch: <message>", exit 1
  4. lines = renderLedgerEpochView(records, query)
     stdout lines.join("\n") + "\n"; exit 0
```

It imports `ledgerPath` and `readEvidence` from `../engine/src/machine/ledger` directly, plus `argumentValue` and `unconsumedValueArguments` from `../engine/src/handlers/helpers/cli-args`, plus the core. It sets the outcome with `process.exitCode`, never `process.exit`, so stdout and stderr flush. The only try/catch wraps step 3. The core is never inside it, so a renderer defect crashes loudly instead of reading as a refusal. Follow the shape of `scripts/read-context-section.ts`: a `#!/usr/bin/env bun` header and a doc comment naming usage, read-only status and refusals.

*As amended in the PR #125 review:* steps 2 and 3 are now one call, `readEvidenceLedger(query.session)`. Its `absent` result maps to the step-2 refusal, `refused` to the step-3 refusal, and `records` to step 4, with the same messages and exit codes.

**Depends on:** Ledger Epoch View core (T1), `engine/src/machine/ledger.ts`, `engine/src/handlers/helpers/cli-args.ts`.

### Operator documentation

**Responsibility:** tell operators when and how to read an attempt's epoch.
**Files:** `docs/operations.md`
**Interface:** a new `### Reading an attempt's ledger epoch` section under `## Common operating states`, placed right after `### Task fails I6 (red-then-green)` and linked from it. Content:

- the invocation, with and without `--agent/--type`;
- where the agent id and type come from: the epoch is `<agentId>:<agentType>`, as in the settlement line and the implementation-attempt sidecar;
- that a position `#N` is the one I6 evidence cites (`red #3`, write `#4`, green `#5`), with duplicate deliveries already dropped;
- how a TestRun reads, including `exit none recorded` and `no structured report` and why those runs are not qualifying (cross-reference the I6 section);
- the ledger location (`$LOOM_SUBAGENT_DIR/<session>.evidence.jsonl`, default `/tmp/claude-subagents`);
- the refusals and exit codes (0 / 1 / 2), and that an empty epoch is stated rather than refused;
- that it never judges I6: point to `helper red-then-green-status`. Pi child epochs are not covered.

**Depends on:** the CLI surface fixed by this plan. It reads no T2 code.

---

## Data Flow

```
argv ──cli-args──▶ LedgerEpochArguments ──parseLedgerEpochQuery (pure)──▶ LedgerEpochQuery
                                                                              │
             ledgerPath(session) ◀── subagentDir() (LOOM_SUBAGENT_DIR | default)
                    │ existsSync? ── no ──▶ refusal (stderr, exit 1)
                    ▼
             readEvidence(session) ── throws ──▶ refusal naming the corrupt line (stderr, exit 1)
                    │ readonly EvidenceRecord[]
                    ▼
renderLedgerEpochView(records, query) (pure) ── eventsForEpoch ──▶ lines ──▶ stdout (exit 0)
```

Positions come from `eventsForEpoch`, the same fold settlement passes to `judgeRedThenGreen`. Nothing between the parser and the renderer reorders, filters or deduplicates.

---

## Implementation Phases

### Phase 1: Pure Ledger Epoch View core (no dependencies)

This phase is one Task (T1). It owes I6: write the tests first and observe red.

- Write `engine/tests/core/ledger-epoch-view.test.ts` first, then implement `engine/src/core/ledger-epoch-view.ts` to the interface and rendering contract above.
- Enroll `engine/src/core/ledger-epoch-view.ts` in `DEFAULT_PURE_MODULES` in `engine/src/linter/programmatic/no-io-in-pure-modules.ts`, with a short comment ("Ledger Epoch View: the read-only rendering of one epoch's facts as I6 numbers them"). The existing `machine-purity.test.ts` closure audit must stay green.
- **Files:** `engine/src/core/ledger-epoch-view.ts`, `engine/tests/core/ledger-epoch-view.test.ts`, `engine/src/linter/programmatic/no-io-in-pure-modules.ts`

### Phase 2: Script shell and operator docs (depends on Phase 1)

Two independent Tasks that run in parallel in the same Wave.

**Task T2: Ledger Epoch script.** This Task owes I6: the test file comes first.
- Write `engine/tests/scripts/ledger-epoch.test.ts` first. It drives the real entry point with `spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, LOOM_SUBAGENT_DIR: tmp } })` against a `canonicalTempDir` fixture that holds hand-written `<session>.evidence.jsonl` files. Then implement `scripts/ledger-epoch.ts` as specified.
- Add `"../scripts/ledger-epoch.ts"` to `include` in `engine/tsconfig.json`, next to the other `../scripts/*.ts` entries.
- **Files:** `scripts/ledger-epoch.ts`, `engine/tests/scripts/ledger-epoch.test.ts`, `engine/tsconfig.json`

**Task T3: Operator documentation.** Documentation only, so the I6 waiver is `documentation-only`.
- Add the section `### Reading an attempt's ledger epoch` to `docs/operations.md` as described under Component Design, and link it from `### Task fails I6 (red-then-green)`.
- **Files:** `docs/operations.md`

---

## Testing Strategy

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| Ledger Epoch View core (T1) | `parseLedgerEpochQuery`: each refusal (missing session, agent without type, type without agent, unsafe id per flag, unconsumed token named), and both success kinds with `epochOf`. `renderEpoch`: a multi-epoch fixture with one duplicate delivery (same `callId` + event) renders only the epoch's facts in ledger order with the duplicate dropped (AS-001). Every kind and sub-arm renders per the contract: write via tool and via shell, read, TestRun with exit or `none recorded`, `no structured report`, `unrecorded` files, recorded files with skipped and collection error, empty `results` (AS-002). Empty epoch is stated (AS-005). `renderEpochIndex` lists first-appearance order and post-dedup counts, with records without a `callId` never deduplicated (AS-003). **Settlement agreement (AS-001, SC-002):** build an epoch that proves I6, run the real `judgeRedThenGreen` over `eventsForEpoch(records, epoch)` and take its `shown` result. Assert that the rendered `#<red.index>` and `#<green.index>` lines name those runs' commands, and that the first `FileWrite` line naming `implementationWrite` has a position strictly between them. | none (pure) | With fast-check over arbitrary admitted records (generated, then round-tripped through `parseEvidenceLine` so only admitted shapes are used): the renderer never throws (FR-005 totality); the epoch view has exactly `eventsForEpoch(records, epoch).length` fact lines, and line `k` begins `#k `; the index's counts sum to the total of the per-epoch fold lengths, and its order equals first appearance. |
| Ledger Epoch script (T2) | none: its decisions are the core's | Subprocess through `bun scripts/ledger-epoch.ts` with `LOOM_SUBAGENT_DIR` pointed at a temp dir. **AS-001/002:** a multi-epoch ledger with a duplicate delivery and every evidence kind, `--session --agent --type`: exit 0, stdout positions and lines as expected, stderr empty. **AS-003:** `--session` only lists the epochs and counts. **AS-004:** no ledger file gives exit 1, stderr naming `<tmp>/<session>.evidence.jsonl`, empty stdout. An unparseable line gives exit 1, stderr naming `line N`, empty stdout. **AS-005:** an agent with no facts gives exit 0 and "holds no facts". No arguments, `--agent` without `--type`, an unknown flag, or `--session ../x` each give exit 2 with the usage on stderr. **FR-006:** the ledger's bytes and mtime and the directory listing are unchanged after every run, and a run with no ledger creates nothing. **NFR-002:** the path in the refusal is under the overridden `LOOM_SUBAGENT_DIR`. | none |
| Operator docs (T3) | waived: documentation only | none | none |

All tests run on the engine's pinned Vitest: `(cd engine && npx vitest run tests/core/ledger-epoch-view.test.ts tests/scripts/ledger-epoch.test.ts)`.

---

## Security & NFR Notes

- **Security:** the one trust boundary is the command line. Every id goes through the engine's smart constructors before it touches a path, so `--session ../etc` is a usage refusal, not a read. The script only reads, and it never writes, truncates or creates a file or directory. In particular it never calls `appendEvidence` and never runs `mkdir` on the subagent directory. Output is the operator's own local ledger on their own terminal.
- **Performance:** a single read of one session ledger. The epoch index is O(epochs × records), which is negligible at ledger sizes.

---

## Verification

1. `npm --prefix engine run typecheck` passes, with `scripts/ledger-epoch.ts` now in the program.
2. `(cd engine && npx vitest run tests/core/ledger-epoch-view.test.ts tests/scripts/ledger-epoch.test.ts tests/linter/programmatic/machine-purity.test.ts)` passes, and `npm --prefix engine run verify` passes at the final Wave Gate.
3. `bun scripts/lint-project.ts` (or the project lint) reports no purity violation for the new core.
4. Manual: `bun scripts/ledger-epoch.ts --session <id>` lists the epochs, and `--agent <id> --type <type>` for a settled Task shows positions equal to its stored red-then-green evidence (re-pilot R10 / SC-002).
