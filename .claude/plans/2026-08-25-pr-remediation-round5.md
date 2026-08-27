# Slice 3 Completion Oracle — PR Remediation Round 5

## Authority
- Reviewed HEAD: `94e9801afb725b7b107ab912aaa933a6f92980b0`
- Review: `review-20260825T041631Z-deterministic-task-completion-oracle-post-remediation`
- Result digest: `db7802dce427043ceea74b1a70ff125581bb0ec84e3e49e2fc4fd5d0c508fed6`
- Critical: typed Claude image support, unanimously upheld

## Work
1. Add typed `image` content arm with exact source object (`type`, `media_type`, `data`) and realistic nested regression.
2. Unnameable active-graph SubagentStop returns error; known unrelated custom role remains passthrough.
3. Replace stale-session `existsSync` with ENOENT-only typed directory probe and actionable diagnostics.
4. Pi review task disappearance returns processing error.
5. TaskCompletionSuiteResult carries exactly one task-scoped engine byte-scope result in its type after parsing/evaluation; raw parser may use an internal unchecked shape only.
6. Correct historical review-output test comment.
7. Move implementation/standalone Agent classification to a pure Agent Catalog projection consumed by validate-task-execution; no core-to-config dependency.
8. Introduce `core/task-id.ts` as the single canonical TaskId grammar/brand/parser and route completion, StateManager task IDs, and prompt extraction validation through it without weakening legacy extraction behavior.
9. Share trusted-evidence preservation and Wave-complete predicates.

## Remediation outcome
Implemented the upheld image critical and all nine advisories. No Slice 4 retry/escalation dispatch and no deferred Wave advisory-status projection were added. The remediation changes exactly 26 artifacts: 15 production TypeScript files, 9 test TypeScript files, 1 JSONL fixture, and this plan. The working tree remains unstaged and uncommitted.

## Final validation — 2026-08-25
1. Focused image/integrity/settlement, Task suite/TaskId, Agent Catalog, dispatch, stale cleanup, Pi review, evidence-predicate, and review-comment set: **10 files passed; 366 tests passed; 0 failed**.
2. Bounded full unit suite (`env -u PI_CODING_AGENT npm run test:unit`): **223 files passed; 5,525 tests passed; 1 skipped; 0 failed**.
3. Smoke suite (`env -u PI_CODING_AGENT npm run test:smoke`): **all gates passed** — panel mode 22/22, review panel 19/19, standalone review PASS, orchestration façades PASS, Pi resources PASS, validate-task-graph 23/23.
4. TypeScript (`npm run typecheck`): **PASS**, including the unused-local/parameter check.
5. Full-tier lint over every changed production TypeScript file: **15 scanned; 0 violations; 0 errors**.
6. Real nested Claude image fixture: strict exact source parsing and exact Oracle settlement both **PASS**; malformed, URL, unsupported-media, empty-data, and surplus-source forms remain rejected.
7. Active-graph unnameable SubagentStop fails while a known unrelated custom role remains passthrough; stale-session directory probing treats only ENOENT as absent; disappearing Pi review Tasks return processing errors: **PASS**.
8. Parsed/accepted TaskCompletionSuiteResult carries exactly one task-scoped `loom:task-byte-scope` check while evaluator diagnostics retain missing/surplus/duplicate/wrong-scope distinctions: **PASS**.
9. The central TaskId parser accepts every canonical `T\\d+`, retains historical malformed-ID rejection, and is consumed by completion, StateManager, reopening, and prompt extraction boundaries: **PASS**.
10. Implementation and standalone Agent classification derive from the pure Agent Catalog; `validate-task-execution` no longer imports shell config: **PASS**.
11. Trusted-evidence preservation and Wave-complete predicates are single-sourced; the historical review-output comment now describes the current structured contract: **PASS**.
12. Deepen lens: the TaskId value object and catalog projections concentrate invariants and pass the deletion test; the stale-directory I/O seam has production and in-memory test adapters; no hypothetical seam was added.
13. Distill apply-mode: duplicate evidence/Wave predicates were collapsed and unchecked Task-suite shape remains private only where precise evaluator diagnostics require it; no behavior-changing or interface-bound cleanup was attempted.
14. `git diff --check`: **PASS**.
