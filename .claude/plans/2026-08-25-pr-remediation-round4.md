# Slice 3 Completion Oracle — PR Remediation Round 4

## Authority

- Reviewed HEAD: `43a2d539a7c3c8e7adf1021b97c9bf72d729f412`
- Review: `review-20260825T033809Z-deterministic-task-completion-oracle-release`
- Result digest: `b5cf7f7739268b13a07a102bfbb2ebc27365d39e3f5a165124dc81b456af72cd`
- Criticals: 3, unanimously upheld; refuted: 0

## Criticals

1. Add typed Claude `tool_reference` content arm requiring non-empty `tool_name`; real nested fixture must pass integrity and settlement.
2. Move Pi phase artifact routing/advancement and spec-check Wave selection into pure reducers applied to the locked graph. Transcript parsing remains outside lock; current phase, spec_dir, transition eligibility, and default current_wave derive inside `store.updateAndReturn`. Add stale-load/concurrent-update regressions proving no phase regression and locked Wave selection.
3. `reopenCompletedWave` must return/report the exact proof computed and committed under lock via `updateAndReturn`; remove pre-lock duplicate authority derivation from success reporting.

## Accepted advisories

- TaskGraph pointer write failure blocks every Loom-owned Agent while a graph is active, not only modern implementation Agents.
- Dispatch combines capture and cleanup failures; neither is dropped.
- Add/strengthen store-test revalidation-required untouched regression.
- Correct three comments in Pi result, Pi extension, and Wave Gate helper count.
- Simplify untrusted transcript verdict construction.
- Derive internal sidecar leaves directly from parsed identities and remove impossible null branches.

## Deferred

- Wave advisory-status projection redesign remains in its atomic status slice.

## Remediation outcome

Implemented all 3 upheld criticals and every accepted advisory. Deferred Wave advisory-status projection remained untouched, and no Slice 4 retry/escalation dispatch was added. The remediation changes exactly 19 artifacts: 9 production TypeScript files, 8 test TypeScript files, 1 JSONL fixture, and this plan. The working tree remains unstaged and uncommitted.

## Final validation — 2026-08-25

1. Focused tool-reference/integrity, Pi locked lifecycle, reopening proof, pointer/capture cleanup, store-test, sidecar, and evidence set: **9 files passed; 230 tests passed; 0 failed**.
2. Bounded full unit suite (`env -u PI_CODING_AGENT npm run test:unit`): **223 files passed; 5,507 tests passed; 1 skipped; 0 failed**.
3. Smoke suite (`env -u PI_CODING_AGENT npm run test:smoke`): **all gates passed** — panel mode 22/22, review panel 19/19, standalone review PASS, orchestration façades PASS, Pi resources PASS, validate-task-graph 23/23.
4. TypeScript (`npm run typecheck`): **PASS**, including the unused-local/parameter check.
5. Full-tier lint over every changed production TypeScript file: **9 scanned; 0 violations; 0 errors**.
6. Real nested Claude `tool_reference` fixture: strict integrity parsing and exact Oracle settlement both **PASS**; empty `tool_name` remains malformed.
7. Pi fake-store stale-load regressions: a locked advanced Phase cannot regress or accept stale artifact routing; an omitted spec-check Wave selects locked `current_wave`: **PASS**.
8. Completed-Wave reopening returns the exact locked proof it committed and replays the immutable audit proof without recomputation: **PASS**.
9. Every Loom-owned Agent blocks on TaskGraph pointer publication failure; simultaneous request capture and cleanup failures are both returned: **PASS**.
10. Store-test revalidation refusal is byte-preserving; sidecar internal identity paths contain no impossible null branch: **PASS**.
11. Deepen lens: the two new store seams each have production and in-memory adapters, concentrate atomic authority decisions, and pass the deletion test; no hypothetical seam added.
12. Distill apply-mode: duplicated untrusted verdict construction, reparsed sidecar identities, impossible branches, and speculative reducer exports were removed; covering tests remained green after the final move.
13. `git diff --check`: **PASS**.
