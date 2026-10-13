# PR #83 remediation — recorded Pi capture contract

- **Branch:** `test/pi-recorded-capture-contract`
- **Scope:** `engine/tests/fixtures/pi-recorded/subagent-code-reviewer-result.json`, `engine/tests/pi/recorded-subagent-result.contract.test.ts`
- **Review run:** `.claude/reviews/review-and-fix-runs/run.pr83-review-1` (result `685370ca…`)
- **Policy publication:** `run.pr83-policy-1`, initial revision, disposition `9bb59bf3…`

## Adjudication

Emitted/admitted: 0 critical, 4 advisory. After refutation: 0 surviving, 0 refuted critical.
No Declared Repair Groups; `defectFamily: not-required`.

## Advisory dispositions (DECLARED)

| Finding | Decision | Reason |
|---|---|---|
| type-design-analyzer-1 | accepted | Unchecked casts → one shared parser into a typed `RecordedSubagentEvent` with named fixture-shape errors. |
| architecture-tech-lead-1 | accepted | Hand-assembled glue → new case replaying the recorded event through the real extension `tool_result` handler. |
| architecture-tech-lead-2 | dismissed | The full 91-message recording is the drift detector; it already caught string-content `custom` messages a trim would drop. Paths already appear across the repo. |
| code-simplifier-1 | accepted | Four repeated envelope guards → `recordedEntry()` / `recordedCandidates()`; ad-hoc casts → shared `RecordedMessage`. |

## Accepted fixes

- New `engine/tests/fixtures/pi-recorded/recorded-subagent-result.ts`: `parseRecordedSubagentEvent`, `recordedSubagentEvent`, and `replayRecordedEvent`, which rebinds only the `LOOM_REQUEST_ID` / `LOOM_CONTEXT_DIGEST` markers to a staged run.
- `recorded-subagent-result.contract.test.ts` uses the parser and two helpers; the seam cases are unchanged in substance.
- `pi-extension-review-events.test.ts`: new case "captures a REAL recorded Pi tool_result through the extension handler, byte-exactly".

## Observed while fixing

Before the markers were rebound, the handler refused the replay with
`no Pi session run binding contains issued request/context authority <id>@<digest>`.
That is correct behaviour, and also a concrete live failure signature: a Pi result whose task markers name a request no session binding holds is never captured.

## Validation

- `npx vitest run tests/pi/recorded-subagent-result.contract.test.ts tests/pi-extension-review-events.test.ts -t recorded` passes.
- `npm --prefix engine run verify` exits 0: 488 files, 12,326 passed, 1 skipped.
