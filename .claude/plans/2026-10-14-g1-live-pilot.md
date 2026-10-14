# G1 live pilot — `helper contract-status`

**Goal:** run one small, real feature through `/loom` with a `## Contracts` section and watch G1 work end to end: RED observed and frozen at the contract Wave, the red window waived, GREEN required later, no frozen byte touched. n = 1, so this is a **mechanics pilot**: it can show G1 works and where it is awkward, not that it cuts defects (ADR-0021: no claim without its measurement).

**Timebox:** one sitting, about half a day. Two Waves, three Tasks, one PR review round.

> **As run (2026-10-14).** The final plan (`.claude/plans/2026-10-14-contract-status.md`) refined two things below. T1 wrote no implementation stubs, because the acceptance tests reach the code only through the route T3 adds, so they failed by assertion until then. The CT-1 statement also surfaces an unparseable TaskGraph's error rather than refusing only a missing one. The run used three Waves (T2 core, T3 helper), not two, and had no ADR wave. Results are in the vault G1 design note under "Live pilot results".

## The feature

Operators cannot see contract state today: freeze state, roster, which Requirement is due when, revisions. Add a read-only helper:

`helper contract-status` prints, per Acceptance Contract: id and title, contract Task, freeze state (`awaiting-red` / `frozen` at Wave N / `revised`), the roster (testcase → anchors), each covered anchor's due Wave, and the revision count. With no contracts it says so. With no TaskGraph it refuses.

Small, pure-core-plus-thin-shell, and it reads exactly the state the pilot creates, so it doubles as the pilot's inspection tool.

## Spec (written by hand; `/loom --skip-specify`)

`.claude/specs/2026-10-14-contract-status/spec.md`:

- **FR-001** Render each contract's id, title, contract Task, and freeze state with its Wave.
  - **AS-001** an `awaiting-red` contract renders as awaiting RED; a `frozen` one names its Wave.
- **FR-002** Render the roster and each covered anchor's due Wave.
  - **AS-002** the roster lists every testcase with its anchors; each anchor shows the Wave that completes it.
- **FR-003** Render revisions and the empty and refusal cases.
  - **AS-003** a revised contract shows its revision count.
  - **AS-004** a graph with no contracts says "no Acceptance Contracts"; a missing TaskGraph is refused.

## Contract (in the plan's `## Contracts`)

```
### CT-1: Contract status rendering

**Types file:** `engine/src/core/contract-status-types.ts`
**Acceptance tests:**
- `engine/tests/acceptance/contract-status.acceptance.test.ts` — AS-001, AS-002, AS-003, AS-004
**Statement:** `renderContractStatus(graph)` is total over every parsed TaskGraph and returns lines, never throws; the helper refuses only a missing TaskGraph.
```

## Expected decomposition

| Wave | Task | Role | Claims |
|---|---|---|---|
| 1 | T1 | contract Task: types file, acceptance tests (`AS-00n: …` names), stubs that throw "not implemented" | — (contributes only) |
| 2 | T2 | pure `core/contract-status.ts` | AS-001, AS-002, AS-003 |
| 2 | T3 | `helper contract-status` handler and route | AS-004 |

The red window is Waves 1–2, so all three Tasks carry `acceptance-red-window`.

## Run

1. Write the spec, then `/loom --skip-specify --skip-plan-alignment`. Answer the architecture interview briefly and paste the `## Contracts` block.
2. The verification manifest is unchanged: `project:verify`, JUnit at `.loom/completion-reports/verify.junit.xml`.
3. Inspect state between Waves with `jq '.acceptance_contracts' .claude/state/active_task_graph.json`. From Wave 2 on, also use the new helper.
4. After Wave 2, run one `/review-and-fix`, then open a PR.

## Measurements (preregistered)

Mechanics. Each is pass/fail, with evidence from the State File, receipts and the brief:

- **M1** Wave 1 gate: every roster testcase is observed failing, the suite is accepted with the non-zero exit excused, and `freeze.state = frozen` at Wave 1 with the digests of both paths.
- **M2** Population stamps `acceptance-red-window` on T1–T3. The T2/T3 briefs show the claimant block naming their testcases; T1 shows the contract-Task block.
- **M3** Wave 2 gate: all four testcases are due and passing, and the frozen hashes are intact.
- **M4** No Task writes a frozen path (the byte-scope proof holds). Contract Revisions: target 0, and record any with its reason.

Recorded, not claimed:

- **M5** Review findings per Wave Gate (critical/advisory counts), and remediation rounds before merge.
- **M6** Wall-clock per phase, and every manual operator intervention, with its cause.

## Known limit to watch

`project:verify` runs `typecheck && test:unit && test:smoke`. In Wave 1 the red unit tests stop the chain, so the smoke suites do not run at that gate, and excusal is report-derived (the documented G1 limit). Record whether it bites. The fix, if one is needed, is a separate project check for acceptance tests. That is out of scope here.

## Stop rules

- The Wave 1 gate refuses RED for a mechanical reason (attribution, report path, typecheck of the stubs): stop, fix the engine on a branch, and resume. Do not hand-edit state.
- Any frozen-path drift or a Contract Revision prompted by the engine rather than a real test bug: stop and record it as a G1 defect.

## Done

The feature is merged; M1–M4 have evidence; M5/M6 are written up in the vault G1 design note under "Live pilot". The next G-slice is then decided with those findings.
