# PR #171 remediation — 2026-11-14

- **Branch:** `fix/owner-id-and-bun-console-fixtures` (PR #171)
- **Reviewed scope:** `all`, the whole branch against `main`: 16 files, one run.
- **Review run:** `run.pr171-review-20261114` (result digest `ae420894…`). Seven reviewers; code-reviewer and silent-failure-hunter reported nothing.
- **Policy publication:** `run.pr171-policy-20261114` (disposition digest `edc19da0…`).
- **Runs root:** `.claude/reviews/review-and-fix-runs/`

## Critical findings

None. The engine reports 0 emitted, 0 surviving and 0 refuted criticals, so the Refutation Panel did not run and no Declared Repair Group exists. Defect-family accounting: `not-required`.

## Advisory dispositions (DECLARED)

12 advisories: 10 accepted, 1 deferred, 1 dismissed.

| Finding | Decision | Reason |
|---|---|---|
| pr-test-analyzer-1 | accepted | `assign`'s refusal of a minted owner that is no agent id had no test. It is unreachable while every catalog name plus the largest attempt suffix fits the grammar, so a test over the Agent Catalog pins exactly that. |
| pr-test-analyzer-2 | accepted | `tsconfig.json` includes `tests/`, so the `@ts-expect-error` is checked; the runtime `.not.toThrow()` wrapper asserted nothing and goes. |
| pr-test-analyzer-3 | accepted | The `bunRunSummary` tests read the 1.4.2 JUnit report by literal; they now iterate `RECORDED_BUN_RELEASES`. |
| type-design-analyzer-1 | deferred | Typing the ledger's `agent_id` as `SecurityAgentId` means `parseLedger`/`validateLedger` must mint branded records rather than narrow a frozen copy, touching every ledger reader and the vendored-validator oracle. This branch brands only the value `assign` prints. |
| type-design-analyzer-2 | accepted | Fixture helpers and `bunConsoleFixtureName` took a release as `string`; recorded releases now parse to `BunVersion`. |
| type-design-analyzer-3 | dismissed | `recordings` maps one-to-one onto the files the recorder writes by iterating `BUN_CONSOLE_FIXTURE_KINDS`; the JUnit flag is not a file, and both readers name it. |
| comment-analyzer-1 | accepted | The `recordingsOf` comment narrated fixture history. |
| comment-analyzer-2 | accepted | The probe sets only `CLAUDECODE`; the comment and ADR-0064 named `AGENT` too, a claim nothing in the change checks. |
| architecture-tech-lead-1 | accepted | A missing `bun` failed the pinned-release file at import, as a collection error. |
| architecture-tech-lead-2 | accepted | Same defect as pr-test-analyzer-3. |
| code-simplifier-1 | accepted | `hasBunFixture` then `bunFixture`, and `?? ""` after `runIf`, was a has-then-read pair over a directory listed on every call. |
| code-simplifier-2 | accepted | Same move as pr-test-analyzer-2. |

## Accepted fixes

- `engine/scripts/bun-console-probe.ts`
  - `installedBunVersion()` returns `InstalledBun` (`ok`/`error`): a missing `bun`, a failed run and an unparseable line are values. `captureBunConsole` throws on one (it is the shell).
  - `bunConsoleFixtureName(release: BunVersion, …)`.
  - The kinds comment names only the variable the probe sets.
- `engine/tests/fixtures/bun-console-fixtures.ts`
  - The directory is listed once. `RECORDED_BUN_RELEASES: readonly BunVersion[]`; a recorded name that is no release throws.
  - `optionalBunFixture(release, kind): string | null` replaces `hasBunFixture`.
- `engine/tests/machine/bun-console-pinned-release.test.ts`
  - `.bun-version` is parsed; a test names a malformed pin.
  - "the bun on PATH prints its release" is a named test; the capture `beforeAll` and its tests run only when it does.
- `engine/tests/machine/bun-console-capture.test.ts`: the join test loops over every console the release recorded; the `runIf` plain test and its `?? ""` are gone; the comment states what the code does.
- `engine/tests/core/structured-test-report-files.test.ts`: the three `bunRunSummary` tests that read a JUnit report run per recorded release; the console test loops over the recorded consoles.
- `engine/tests/core/loom-cli-command.test.ts`: the brand test keeps the `@ts-expect-error` call and the `anOwner` refusal, without the empty runtime wrapper.
- `engine/tests/security/security-coverage.test.ts`: every catalog agent with suffix `--(attemptsPerUnit + 1)` is a `SecurityAgentId`.
- `docs/adr/ADR-0064-…md`: the two-console bullet names only `CLAUDECODE`.

## Validation

- `tsc --noEmit`, the five affected suites (185 tests), and the pinned-release file with no `bun` on PATH (one named failure, seven skips, no collection error).
- `bun engine/scripts/bun-console-probe.ts` re-records the 1.4.4 fixtures byte-identically.
- Full `npm run verify`.

## Distill (apply mode)

- Applied: the byte-comparison guard `PINNED !== null && …` was dead (when both are null the enclosing describe is skipped); removed, covering suites green.
- Skipped: none further in scope.
