# PR #172 remediation: brand every owner id the coverage ledger records

- **Branch:** `feat/branded-ledger-owner-ids`
- **Scope:** `all`. The frozen diff covers six files:
  - `engine/src/core/security-coverage.ts`
  - `engine/tests/core/loom-cli-command.test.ts`
  - `engine/tests/security/fixtures.ts`
  - `engine/tests/security/security-adjudication.test.ts`
  - `engine/tests/security/security-coverage.test.ts`
  - `engine/tests/security/security-invariants.test.ts`
- **Review run:** `.claude/reviews/review-and-fix-runs/run.pr172-review-20261114`, result digest `031e64ad…3f02`.
- **Policy run:** `.claude/reviews/review-and-fix-runs/run.pr172-policy-20261114`, disposition digest `7fcf4ef8…0b71`, receipt `artifact-set-published`.

## Engine counts (inspection)

- Emitted and admitted: 0 critical, 4 advisory.
- After refutation: 0 surviving critical, 0 refuted critical, 4 advisory.

## Surviving criticals

None, so there are no Declared Repair Groups or Historical RED declarations. Remediation starts with `defectFamily: {"kind":"not-required"}`.

## Refuted findings

None.

## Advisory dispositions (DECLARED; published in the policy run)

| Finding | Decision | Reason |
| --- | --- | --- |
| architecture-tech-lead-1 | accepted | `parseLedger` narrows by assignment, and nothing makes the owner-id test track the type. The test checks three hand-listed sites and misses the fourth, an archived attempt's check owner (`attempts[].local_checks[].agent_id`). Fix: the test derives every `SecurityAgentId` path of `CoverageLedger` at the type level and keys its cases by that union. A new owner field then fails to compile until a test proves it is refused. Making the whole ledger parse constructive predates this PR and is a separate deepening. |
| architecture-tech-lead-2 | accepted | The `assigned` helper's `string` agentId is deliberate: it is `Assignment`'s unparsed catalog-agent input. Type it as `Assignment["agentId"]` to say so. The alias half is handled by code-simplifier-1. |
| code-simplifier-1 | accepted | `const HUNTER = HUNTER_AGENT` is a pure alias. Import `HUNTER_AGENT as HUNTER` instead. |
| code-simplifier-2 | accepted | Define one `HUNTER_2 = anAgentId(\`${HUNTER}--2\`)` and reuse it at every site for that id. |

## Accepted fixes (all in `engine/tests/security/security-coverage.test.ts`, plus a comment in `security-coverage.ts`)

1. Add a test-local type, `OwnerPaths<T, At>`, that yields every path of `T` whose type is `SecurityAgentId` (nullable included). Spell each path as `validateLedger` names it.
2. Type the owner-id test's case table as `Record<LedgerOwnerPath, site>`. Each case breaks the owner at one site and expects `parseLedger` to refuse that exact path. Add a compile-time guard that the union is not `never`.
3. Update the `parseLedger` comment to name the test that keeps the narrowing honest.
4. Import `HUNTER_AGENT as HUNTER`, add a `HUNTER_2` constant, and type `assigned` with `Assignment["agentId"]`.

## Validation

- `cd engine && npx tsc --noEmit -p .`
- `cd engine && npx vitest run tests/security`
- `npm run verify` at the repo root

## Remediation

- Fresh run `run.pr172-remediation-20261114`.
- `supportPaths`: this plan only. Every code change is inside the reviewed scope.
