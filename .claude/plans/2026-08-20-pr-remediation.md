# PR Remediation — 2026-08-20

## Authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Reviewed head:** `7cc3ca12401e43ba118e7f25003eb9cde98499db`
- **Standalone Review Run Directory:** `.claude/reviews/review-and-fix-runs/standalone-review-20260820T165217Z-01a02016`
- **Canonical result:** `.claude/reviews/review-and-fix-runs/standalone-review-20260820T165217Z-01a02016/result.json`
- **Result digest:** `e6dd1131880c63f2868089520ff1ab8ac4596ea47d46b61b80f8aebfb3ab9256`
- **Exact frozen scope:** the canonical 484-path array at `result.json#/scope`; remediation does not reconstruct or broaden it.
- **Support paths outside frozen scope:** `engine/tests/handlers/helpers/programs/remediation-post-install.test.ts` (new full-driver regression).

## Surviving critical Findings — mandatory

1. **`silent-failure-hunter-1` — unreadable lock PID is treated as stale**
   - Remove the `existsSync` preflight from `isStaleLock`.
   - Read the PID directly; classify only `ENOENT`, a malformed PID, or `ESRCH` as stale. Treat access/path/I/O failures as a live lock so mutual exclusion fails closed.
   - Add a root-independent `ELOOP` regression proving an inaccessible PID is never reaped as stale.

2. **`silent-failure-hunter-2` — owned lock-release failures are swallowed**
   - Separate ownership inspection from owned removal.
   - Preserve missing/foreign lock no-op behavior, but throw a path-qualified error when ownership cannot be inspected or removal of a proven-owned lock fails.
   - Add a POSIX permission regression proving a stranded owned lock is diagnosed.

3. **`pr-test-analyzer-1` — no full-driver regression for install then checkpoint failure**
   - Drive `driveRemediationFacade` through a completed standalone review, real temporary-index verification, and real verified-index installation.
   - Supply a fake `RunDirHandle.writeCheckpoint` that fails only after installation.
   - Assert the returned failure explicitly says the index was installed, retains the installation receipt, is not a `blocked` action, and the authorized path is present in the real staged index.

4. **`code-simplifier-1` — impossible optional `contextDigest` branch**
   - Read the required `AgentRequestAuthority.contextDigest` directly.
   - Keep only the real context-read success/absence distinction and retain corrupt-context blocking.

## Advisory dispositions

### Accepted

1. **`silent-failure-hunter-3` — unreadable `.task_graph` pointer is silently treated as absent.** Read directly, classify `ENOENT` as absence, and emit the path-qualified access error before attempting repair for every other failure. Add an `ELOOP` regression.
2. **`silent-failure-hunter-4` — unreadable Pi Agent definition is reported as missing.** Replace `existsSync` with a discriminated lookup (`found | absent | unreadable`); preserve the sync instruction only for true absence and report the concrete path/error otherwise. Add an `ELOOP` handler regression.
3. **`pr-test-analyzer-2` — valid non-null Wave proof/test evidence lacks coverage.** Add a parser-boundary test proving valid `TaskProof` and `ProofTestResult` values are accepted and preserved.
4. **`type-design-analyzer-1` — in-process `ByteSection` construction accepts non-byte numbers.** Make `buildContextPacket` enforce integer byte range before digest/length comparison and add a coercion-shaped regression (`256` with the digest of coerced `0`).
5. **`type-design-analyzer-2` — top-level `TaskGraph` lifecycle fields are mutable in the type.** Mark every top-level field `readonly`, matching the parser's recursive freeze and the existing fresh-object `StateManager.update` contract; resolve any compiler-revealed mutation sites with immutable updates.
6. **`code-simplifier-2` — Wave request profiles are selected by a role ternary.** Resolve each Wave role through `resolveAgentPolicy`, then lower its catalog-owned profile and Skill.
7. **`code-simplifier-3` — Wave review model bindings duplicate Agent Catalog/profile policy.** Delete the duplicate authority table in the Lifecycle Machine; derive profile, exact harness bindings, and required Skill from the Agent Catalog and model profile policy. Strengthen the Wave preparation test to compare emitted authority against catalog resolution.

### Deferred

1. **`architecture-tech-lead-1` — split runtime discovery out of all `core -> config` imports.** The claim is sound, but a complete correction is a cross-cutting interface migration across seven core modules and their shell call sites, including runtime task-graph discovery and guarded command analysis. A partial extraction leaves the Finding true. It is deferred as a dedicated architecture change rather than mixed into this lock/authority correctness remediation; no new `core -> config` dependency is introduced here.

### Dismissed

- None.

## Refuted critical Finding audit

- `result.json.refuted_critical_findings` is empty. No critical Finding is omitted or remediated as refuted.
- All four critical Findings survived the registered Refutation Panel.
- The two lock Findings were upheld by reproduction, intent, and security.
- The full remediation-driver regression was upheld by intent; reproduction and security were uncertain only because those lenses could not establish test inventory from the production file alone.
- The impossible `contextDigest` branch was upheld by reproduction and intent; security was uncertain because removing it is semantic simplification rather than a trust-boundary change.

## Planned changed files

- `.claude/plans/2026-08-20-pr-remediation.md`
- `engine/src/utils/lock.ts`
- `engine/tests/utils/lock.test.ts`
- `engine/tests/handlers/helpers/programs/remediation-post-install.test.ts` (support path)
- `engine/src/handlers/helpers/programs/wave-gate.ts`
- `engine/src/handlers/subagent-start/mark-subagent-active.ts`
- `engine/tests/handlers/subagent-start/mark-subagent-active-roster.test.ts`
- `engine/src/handlers/pre-tool-use/validate-agent-model.ts`
- `engine/tests/handlers/pre-tool-use/spawn-gates-fail-closed.test.ts`
- `engine/tests/handlers/helpers/programs/wave-gate-decision-authority.test.ts`
- `engine/src/orchestration/context-packets.ts`
- `engine/tests/orchestration/uncovered-branches.test.ts`
- `engine/src/types.ts`
- `engine/src/core/wave-gate-machine.ts`
- `engine/src/handlers/helpers/populate-task-graph.ts`
- `engine/src/handlers/subagent-stop/advance-phase.ts`
- `engine/tests/handlers/complete-wave-gate.test.ts`
- `engine/tests/handlers/pi-stop-toctou.test.ts`

## Validation

Focused gates after each coherent move:

```bash
cd engine
npm run test:unit -- --run tests/utils/lock.test.ts
npm run test:unit -- --run tests/handlers/helpers/orchestration.test.ts
npm run test:unit -- --run tests/handlers/subagent-start/mark-subagent-active-roster.test.ts tests/handlers/pre-tool-use/spawn-gates-fail-closed.test.ts
npm run test:unit -- --run tests/handlers/helpers/programs/wave-gate-decision-authority.test.ts tests/orchestration/uncovered-branches.test.ts
npm run test:unit -- --run tests/handlers/complete-wave-gate.test.ts tests/core/model-profiles.test.ts
npm run typecheck
```

Final gates:

```bash
cd engine
npm run test:unit
npm test
```

After the implementation is green, run `distill` in apply mode one behavior-preserving move at a time. Then start registered remediation with `supportPaths: ["engine/tests/handlers/helpers/programs/remediation-post-install.test.ts"]`, resume to `done`, use only the engine-installed verified index, commit, and push without force.
