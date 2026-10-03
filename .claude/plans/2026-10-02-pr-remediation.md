# PR remediation — #60 + #62 stack (2026-10-02)

- **Branch:** `fix/claude-review-capture` (stacked on `fix/claude-phase-artifact-writes`, PR #60 → PR #62)
- **Scope:** the frozen standalone review scope of the stack against `main`
- **Review run:** `.claude/reviews/review-and-fix-runs/run.raf-stack-20261002T215647`
  (result digest `06af9df056b511730bfc13ec80123b033e4af2cebf44932c17ef409f27fd466b`)
- **Counts (engine inspection):** emitted/admitted 0 critical, 7 advisory; after refutation 0 surviving, 0 refuted, 7 advisory
- **Advisory policy publication:** `.claude/reviews/review-and-fix-runs/run.raf-stack-policy-20261002T220337`
  (initial revision, disposition digest `ff2a56918283827b35856491f46ba43890f79d7a5da9409dcac9578385350bb6`)

## Surviving criticals

None. Defect-family accounting: `not-required`.

## Refuted criticals

None.

## Advisory dispositions (DECLARED)

| ID | Decision | Reason |
| --- | --- | --- |
| silent-failure-hunter-1 | accepted | A run binding proves a request-bound run may own the stop; a missing runtime strands its slot. `dispatch.sh` exits 1 (non-blocking, surfaced) in that case; graph/machine-only sessions keep exit 0. Claude-only shim — Pi captures in-process. |
| pr-test-analyzer-1 | accepted | Pin the legacy text ending past a trailing attachment, user-text and mixed endings, and last-line-only legacy text for a split assistant message. |
| comment-analyzer-1 | accepted | `artifact-write-scope` header predates the lint-rule roots; fix it and reflow the broken doc line. |
| architecture-tech-lead-1 | accepted | Derive the registry lock name from `ORCHESTRATION_RUNS_SUFFIX`; contract test ties the `dispatch.sh` glob and its shim test fixture to the constant. |
| architecture-tech-lead-2 | deferred | Seam move, not a behaviour fix; `fix/loom-consolidated` restructures the same reader for emission frames — extract once there. |
| architecture-tech-lead-3 | deferred | Pre-existing `runDispatch` structure beyond this stack; nothing observed wrong; covered by handler tests. |
| code-simplifier-1 | accepted | `parsePreToolUseInput` beside `isPreToolUseInput`; returns the parse error so block-direct-edits keeps its detail. |

## Fix found during the review run (not a review finding)

pr-test-analyzer's attempt 1 was rejected `no-final-payload` although it handed
back a valid payload: it called `SubagentHandback` in parallel with a Bash call,
so the handback's call line was not immediately before its tool_result, and an
`attachment` line followed. `claudeFinalPayloadCandidates` now reads the final
TURN (trailing tool_results + the one assistant message they answer, which may
span lines sharing a message id), skipping non-conversation lines, parsing only
as far back as that turn reaches. Attempt 2 was captured by the fixed reader.
Pi is unaffected: it captures from the tool result in-process.

## Pi parity

Every change is either harness-neutral core (`artifact-write-scope`,
`session-run-bindings`), Claude-only adapter code (`capture-orchestration-result`,
`dispatch.sh`, the PreToolUse handlers), or tests. `pi/rules-gate.ts` and
`pi/extension.ts` are untouched by this remediation; the shared registry keeps
its file format and Pi keeps reading it through `ORCHESTRATION_RUNS_SUFFIX`.

## Live-plugin safety

The checkout is the live plugin. Runtime changes to hook-imported files go
through a sibling `.next.ts`, a `bun -e` smoke import/call, then one `mv`.

## Validation

- `cd engine && bun run typecheck`
- `cd engine && npm run test:unit`
- Registered remediation run (schema v2, `defectFamily: not-required`)
