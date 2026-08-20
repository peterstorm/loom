# PR Remediation — 2026-08-20

## Authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Reviewed head:** `c9a8f5aa10982ac89b19728e3425a7d725c53ec7`
- **Merge base (`main`):** `eda64237336193dac66843323b4c69dd4bafcd32`
- **Standalone Review Run Directory:** `.claude/reviews/review-and-fix-runs/review-20260820T144357Z-`
- **Canonical result:** `.claude/reviews/review-and-fix-runs/review-20260820T144357Z-/result.json`
- **Result digest:** `ffcbd784f2f855a7064def9b8d7f0512fa334829f5ad87897f0006c17f6c5d1b`
- **Exact frozen scope:** the 480-entry canonical path array at `result.json#/scope`; that array is the immutable scope authority and is not reconstructed here.
- **Remediation support paths outside frozen scope:** none. This Plan and every planned source/test path are already present in the frozen scope.

## Green baseline

The focused pre-remediation baseline passed: 8 test files, 275 tests.

```bash
cd engine
npm run test:unit -- --run \
  tests/machine/ledger.test.ts \
  tests/handlers/helpers/programs/wave-gate-decision-authority.test.ts \
  tests/linter/loader.test.ts \
  tests/orchestration/orchestration-acceptance.test.ts \
  tests/pi-extension-review-events.test.ts \
  tests/core/review-packet.test.ts \
  tests/core/artifact-baseline.test.ts \
  tests/types.test.ts
```

## Surviving critical Findings — mandatory

1. **`code-reviewer-1` — strict active-roster rollback treats unreadability as absence**
   - Remove the `existsSync` preflight from `removeActiveAgentStrict`.
   - Perform removal under the existing session lock; treat only an `ENOENT` raised by the locked operation as proven absence and propagate every other filesystem failure.
   - Add an `ELOOP` regression that is reliable even when tests run as root and proves strict rollback cannot report success while the roster is unreadable.

2. **`silent-failure-hunter-1` — inaccessible Guarded Skill Machine definition disables gating**
   - Read the definition directly. Map only `ENOENT` to `LoadedMachine.kind === "none"`; map all other read failures to a path-qualified `invalid` result so callers block loudly.
   - Add missing-versus-inaccessible machine-definition regressions.

3. **`silent-failure-hunter-2` — inaccessible active roster is interpreted as empty**
   - Centralize optional text-file reads in the ledger shell with an exact `ENOENT`/failure split.
   - Use it for active-roster reads so a missing roster remains `[]`, while inaccessible or path-broken rosters throw and the surrounding gates fail closed.
   - Add direct roster and sole-attribution regressions using a symlink loop.

4. **`silent-failure-hunter-3` — inaccessible evidence ledger is interpreted as empty evidence**
   - Use the same optional-read seam for evidence. Preserve `[]` only for a genuinely absent ledger and propagate non-`ENOENT` failures to existing `snapshot-read-failed` handling.
   - Add a ledger regression that distinguishes absence from `ELOOP`.

5. **`type-design-analyzer-1` — Wave Task-review authority carries an arbitrary object**
   - Introduce an immutable `WaveReviewTaskAuthority` projection matching the exact published Task payload.
   - Parse the complete object shape at the Context Packet boundary, including string arrays and stored Findings; require `task.id === subject.taskId === taskRun.taskId` and `task.reviewGeneration === taskRun.generation` before minting loaded authority.
   - Reject malformed, foreign-task, and stale-generation payloads as corrupt; add focused packet-boundary regressions.

## Advisory dispositions

### Accepted

1. **`silent-failure-hunter-4` — accepted.** Parser diagnostics are already typed evidence from `piResultFinalPayloadCandidates`; converting them to an empty candidate list destroys the cause. Return an audited `transcript-shape` capture rejection containing the parser errors before entering shared capture, and pin the exact diagnostic with a focused Pi regression.
2. **`silent-failure-hunter-5` — accepted.** Project lint rules are policy. Attempt directory loading directly, skip only `ENOENT`, and surface `EACCES`/`ELOOP`/other failures. Add missing-versus-inaccessible project-directory coverage.
3. **`comment-analyzer-1` — accepted.** Correct the `tool-vocabulary.ts` header so it states the actual pure-import invariant rather than the obsolete single-import claim.
4. **`architecture-tech-lead-1` — accepted.** Break the `types.ts → artifact-baseline → review-packet → types.ts` cycle by moving `IssuedReviewPacketRegistration` ownership into the leaf review-packet module and re-exporting/importing it from the outer schema aggregate. Preserve caller interfaces and add a dependency regression proving `review-packet.ts` no longer imports `types.ts`.
5. **`code-simplifier-1` — accepted.** Combine the identical `allow` and `passthrough` `ts-pattern` success arms in `resultToExit`; preserve stdout, optional message, and exit-code behavior exactly.

### Deferred

- None.

### Dismissed

- None.

## Refuted critical Finding audit

- `result.json.refuted_critical_findings` is empty. No critical Finding was refuted or omitted.
- The registered Refutation Panel upheld all five critical Findings under all three assigned lenses: `reproduction`, `intent`, and `security`.
- Panel evidence retained in the canonical result proves the `existsSync` access-error collapses using inaccessible/symlinked paths and proves the Wave authority parser accepts an internally mismatched Task payload despite packet byte integrity.

## Planned changed files

- `.claude/plans/2026-08-20-pr-remediation.md`
- `engine/src/cli.ts`
- `engine/src/core/review-packet.ts`
- `engine/src/core/tool-vocabulary.ts`
- `engine/src/handlers/helpers/programs/wave-gate.ts`
- `engine/src/linter/loader.ts`
- `engine/src/machine/ledger.ts`
- `engine/src/types.ts`
- `engine/tests/core/review-packet.test.ts`
- `engine/tests/handlers/helpers/programs/wave-gate-decision-authority.test.ts`
- `engine/tests/linter/loader.test.ts`
- `engine/tests/machine/ledger.test.ts`
- `engine/tests/pi-extension-review-events.test.ts`
- `pi/extension.ts`

## Validation

Run focused tests after each coherent move:

```bash
cd engine
npm run test:unit -- --run tests/machine/ledger.test.ts tests/handlers/subagent-stop/dispatch-resilience.test.ts tests/handlers/pre-tool-use/enforce-phase-tools-fail-closed.test.ts
npm run test:unit -- --run tests/handlers/helpers/programs/wave-gate-decision-authority.test.ts
npm run test:unit -- --run tests/linter/loader.test.ts
npm run test:unit -- --run tests/pi-extension-review-events.test.ts
npm run test:unit -- --run tests/core/review-packet.test.ts tests/core/artifact-baseline.test.ts tests/types.test.ts
```

Final gates:

```bash
cd engine
npm run typecheck
npm run test:unit
npm test
```

After a green implementation, run `distill` in apply mode one move at a time with covering tests after each move. Then start registered remediation with `supportPaths: []`, resume to `done`, use only the engine-installed verified index, commit, and push without force.
