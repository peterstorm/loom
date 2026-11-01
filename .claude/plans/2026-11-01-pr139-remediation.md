# PR 139 remediation: shared session-graph resolver, scoped-grant confinement in core

Branch `refactor/pi-placement-resolver`, reviewed head `4c215a5a`. The frozen diff is 68 KB, within one reviewer's budget, so it was reviewed as one registered standalone run with 7 reviewers.

| Review run | Emitted/admitted | After refutation | Policy run | Disposition digest |
|---|---|---|---|---|
| `pr139-4c215a5a` | 0 critical, 6 advisory | 0 surviving, 0 refuted | `pr139-policy-4c215a5a` | `20dc603a` |

There are no surviving or refuted criticals, so no Declared Repair Group, no Historical RED and no selected check. The remediation start declares `defectFamily: not-required`. The advisory dispositions are `DECLARED` and published as the initial P5 revision; the exact reasons are in the policy run's `artifacts/disposition.json`.

## Advisory dispositions (6: 6 accepted)

- **pr-test-analyzer-1**: no test crossed the extension's tool_call wiring of `grantScope`.
  - Added a case to the existing Pi scoped-grant integration test: an in-scope target written from a tool cwd that is not the grant's authorizing cwd is refused.
- **comment-analyzer-1**: the docs said the cwd refusal was unconditional, but `grantWriteScope` skipped the check when no `grantCwd` was recorded.
  - Fixed in code rather than in the docs. A scoped grant with no recorded authorizing cwd now answers `unresolved` and fails closed.
  - The docs (ADR-0046, `docs/pi-usage.md`, the `WriteGrantScope` comment) now name both cases.
- **architecture-tech-lead-1**: the grant scope was canonicalised eagerly.
  - `DirectEditPorts.grantScope` is now a lazy port, `() => WriteGrantScope | undefined`. Core calls it only once an admission allows a write placed inside, matching `locateEdit`.
- **architecture-tech-lead-2**: the unreadable-pointer announcement bypassed the ported seam and lost Pi's `loom(pi):` prefix.
  - `SessionGraphHarness.announce` is now part of the session-graph ports, and each harness supplies its own sink and prefix.
  - Tests capture the announcement through the port.
- **code-simplifier-1**: `grantWriteScope` had an unreachable `undefined` arm.
  - The scope dirs are parsed once into a non-empty tuple up front, which removes the impossible arm.
- **code-simplifier-2**: both harnesses copied the same session-graph port wiring.
  - `liveSessionRepository(sessionId, harness)` fills the live TaskGraph path and protected dirs, so each harness names only its `SessionGraphHarness` (`CLAUDE_SESSION_GRAPHS`, `PI_SESSION_GRAPHS`).

## Validation

- `bun engine/scripts/typecheck.ts`
- Targeted vitest:
  - `engine/tests/handlers/pre-tool-use/block-direct-edits.test.ts`
  - `engine/tests/pi-write-grant.test.ts`
  - `engine/tests/pi-extension-review-events.test.ts`
- Full-tier lint (`bun scripts/lint-project.ts`): baseline 77 violations, the same as on `main`.
- Root `npm run verify`.
- Registered remediation: one schema-v2 run against `pr139-4c215a5a` with `defectFamily: not-required`. Its `supportPaths` name every touched path outside the frozen scope:
  - this plan;
  - `engine/tests/pi-extension-review-events.test.ts`.
