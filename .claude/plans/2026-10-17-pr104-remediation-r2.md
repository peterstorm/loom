# PR #104 remediation, round 2: the identity fixture reaches every non-parser suite

- **Branch:** `refactor/test-fixtures-part-2` (base `main`)
- **Scope:** the review's frozen diff was the PR's 13 files at `b8df90f1` (`kind: all`). This remediation
  edits two of them and the 16 support suites listed below, and adds this plan.
- **Review run:** `.claude/reviews/review-and-fix-runs/review-fix-20261017T152301Z-b8df90f1`
- **Counts (inspection renderer):** 0 critical and 3 advisory emitted and admitted. After refutation:
  0 critical surviving, 0 refuted, 3 advisory.
- **Advisory policy publication:** `.claude/reviews/review-and-fix-runs/disposition-20261017-pr104-r2`,
  revision `initial`, disposition digest `6905c2367ad0d6197f99e4bad2fc6966c398b79a2e57249502b35f20b1c7a345`
  (DECLARED).

## Surviving / refuted criticals

None. Defect-family accounting: `{"kind":"not-required"}`.

## Advisory dispositions (DECLARED)

| ID | Decision | Reason |
| --- | --- | --- |
| comment-analyzer-1 | accepted | The round-1 plan's scope line separates the frozen 8-file diff from the support suites, and its Validation line names the five suites it ran. |
| architecture-tech-lead-1 | accepted | Every non-parser suite that built a fixture identity with `parseX(...)!` or a hand-rolled parse-or-throw helper now uses `sessionIdOf` / `agentIdOf` / `agentTypeOf`. `ledger.test.ts` stays on the raw parsers: it is the parser-boundary suite that the fixture header exempts. |
| code-simplifier-1 | accepted | `evidence-recorder` binds the grant epoch once, so each expected ledger row shows only its event and callId. |

Parser calls that remain in the migrated suites assert the parsers' own contract: `parseSessionId(evil)` returning `null` in
`enforce-phase-tools-fail-closed`, and the branded-id port argument in `block-direct-edits`. `parseReportedAgentId(...)!`
in `implementation-binding-lazy` is a different parser (harness-reported ids), with no fixture builder of its own; it is
left as it is.

## Support paths (outside the frozen scope)

- `engine/tests/handlers/implementation-binding-lazy.test.ts`
- `engine/tests/handlers/post-tool-use/record-evidence-injection.test.ts`
- `engine/tests/handlers/post-tool-use/record-evidence.test.ts`
- `engine/tests/handlers/pre-tool-use/block-direct-edits.test.ts`
- `engine/tests/handlers/pre-tool-use/enforce-phase-tools-fail-closed.test.ts`
- `engine/tests/handlers/pre-tool-use/guard-state-file.test.ts`
- `engine/tests/machine/binding-liveness.test.ts`
- `engine/tests/machine/call-start.test.ts`
- `engine/tests/machine/handlers-e2e.test.ts`
- `engine/tests/machine/session-registry.property.test.ts`
- `engine/tests/pi/child-write-grant.test.ts`
- `engine/tests/pi/session-shutdown.test.ts`
- `engine/tests/pi/spawn-claims.test.ts`
- `engine/tests/pi/spawn-lifecycle.test.ts`
- `engine/tests/pi/spawn-reservation.test.ts`
- `engine/tests/pi/subagent-stop.test.ts`
- this plan

## Validation

- `npm run typecheck` (engine): clean, with no new unused imports
- the 16 migrated suites plus `evidence-recorder`
- `npm run verify` (root)
