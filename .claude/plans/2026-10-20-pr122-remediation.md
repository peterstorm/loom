# PR #122 remediation (2026-10-20)

- **Branch:** `fix/g4-pilot-findings`
- **Scope:** `all`, which is the branch diff against `main` (57 files, #117–#121)
- **Review run:** `.claude/reviews/review-and-fix-runs/pr122-review-20261020`, result digest `4f5959f8e338803fea1e2e29068ff2d936081aeb01855a7076f31dda00595127`
- **Counts:** 0 critical and 15 advisory emitted and admitted. After refutation: 0 surviving critical, 0 refuted critical, 15 advisory.
- **Policy publication:** `.claude/reviews/review-and-fix-runs/pr122-policy-20261020`, revision `initial`, disposition digest `e5c63ef0558bc8886c07cb5e4256288c3cc181101797126d741875b9f5bbba47`. Provenance is DECLARED.

## Surviving criticals

None. `defectFamily` is `{"kind": "not-required"}`. There are no Declared Repair Groups and no selected checks.

## Refuted criticals

None.

## Advisory dispositions

| Finding | Decision | Reason / fix |
|---|---|---|
| silent-failure-hunter-1 | accepted | `runChild` now returns `ChildFailure` (error \| block) or `null`. The unreachable ternary arm in `dispatch.ts` is gone. |
| silent-failure-hunter-2 | dismissed | The SubagentStop `systemMessage` already showed the note to the operator. The sidecar is a second channel, and fail-open by design. |
| pr-test-analyzer-1 | deferred | `dispatchPiSubagentStop` runs the real `REPORT_ONLY_STOP_CHECK_PORTS` and has no injectable seam. A dispatch-level test first needs a new port; that is follow-up work. |
| pr-test-analyzer-2 | accepted | New dispatch test: when the sidecar path is unwritable, the result says "the note was not kept for the orchestrator". |
| pr-test-analyzer-3 | accepted | The namespace tests now assert the exact refusal, that the graph is unchanged, and the positive outcome, all unconditionally. |
| type-design-analyzer-1 | accepted | `parseOperatorNote` refuses `\r` and `\n` ("an operator note must be one line"), with a direct test. |
| architecture-tech-lead-1 | dismissed | A bash shim cannot import the TS constant. The shim test publishes its sidecar through `publishStopCheckNote`, so a suffix change would fail that test. `SESSION_SUFFIXES` grouping would key on `<session>.<agent>`. |
| architecture-tech-lead-2 / code-simplifier-2 | accepted | `renderStopCheckNotes(readonly StopCheckNote[]): string \| null`. Both harness callers drop the NonEmpty re-spread. |
| architecture-tech-lead-3 | accepted | `RenderTaskBrief` and `triageBriefMarker` (none \| malformed \| unrenderable \| expanded) now live in `core/implementation-brief.ts`. Both adapters map that result. |
| architecture-tech-lead-4 / code-simplifier-1 | accepted | One `writeStderrLine` is hoisted in `pi/extension.ts`. `docs/operations.md` now states the extension sink's no-UI `[loom]` prefix. |
| architecture-tech-lead-5 | accepted | `surfaceStopCheckNotes` skips calls that carry `agent_id`, which Claude Code stamps inside subagents. Tested. |
| code-simplifier-3 | accepted | The marker is matched once and the Task id kept from that match. The unreachable `?? ""` fallback is gone. |
| code-simplifier-4 | accepted | A shared `engine/tests/fixtures/operator-note.ts` `admittedNote` replaces the three copies. |

## Support paths (outside the frozen scope)

- `.claude/plans/2026-10-20-pr122-remediation.md`
- `engine/tests/fixtures/operator-note.ts`

## Validation

- `npx tsc --noEmit -p engine`
- `npm run verify` (typecheck, the whole Vitest suite, all smokes)
