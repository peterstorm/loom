# PR #87 remediation — helper contract-status (G1 live pilot)

- **Branch:** `feat/contract-status` (PR #87, base `main`)
- **Review run:** `run.pr87-review-1`, the full 15-file branch diff against `origin/main`. The comment-analyzer's first attempt was refused for unread pages; its retry was admitted.
- **Adjudication:** 0 critical emitted, 0 surviving, 0 refuted; 11 advisories. Remediation uses `defectFamily: {"kind":"not-required"}`.
- **Policy (published, DECLARED):** `run.pr87-policy-1`, initial revision, disposition digest `88da45e3…b712c`. 10 accepted, 1 dismissed.

| Finding | Decision | Fix / reason |
|---|---|---|
| type-design-analyzer-1, architecture-tech-lead-1, code-simplifier-3 | accepted | The `revised` freeze variant keeps only its paths; `ContractStatusView.revisions` is the one count and the renderer reads it. The orchestration is complete, so the pilot's frozen surface is ordinary code; the acceptance tests still pin the output |
| type-design-analyzer-2, comment-analyzer-2 | accepted | Plan Component Design updated to the shipped `TaskGraph` signatures (with the lint reason); `dueWaves` cited by name, not `tasks.ts:109` |
| comment-analyzer-1 | accepted | `contract-status` gets its own sentence in `commands/loom.md` (no arguments, reads only the State File, writes only stdout); the runs-root tail no longer claims to describe it |
| comment-analyzer-3 | accepted | Pilot plan gains an "As run" note: no stubs, a widened CT-1 statement, three Waves, no ADR wave |
| architecture-tech-lead-2 | accepted | The handler's try wraps only `manager.load()`; a renderer defect crashes instead of reading as a load refusal |
| architecture-tech-lead-3 | dismissed | The declarations-only types file is the deliberate G1 frozen contract surface (plan AD-1) that the pilot exercises |
| code-simplifier-1 | accepted | Shared `tests/fixtures/contract-status-fixtures.ts` (surface, frozenPaths, task, contract, gitProject, writeStateFile, stateFileJson) used by the acceptance and handler tests |
| code-simplifier-2 | accepted | `coveredStatus` builds `AnchorDue` inline from `Object.hasOwn` in one freeze |

- **Support paths outside the reviewed scope:** `engine/tests/fixtures/contract-status-fixtures.ts`, this plan.
- **Validation:** `npm --prefix engine run verify`
