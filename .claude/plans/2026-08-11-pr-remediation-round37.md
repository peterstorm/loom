# PR Remediation — Round 37

## Review authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Standalone run:** `.claude/reviews/review-and-fix-runs/run.LBsrA94scf`
- **Exact scope:** the immutable 319-path `scope` array in `.claude/reviews/review-and-fix-runs/run.LBsrA94scf/result.json`
- **Adjudication:** 21 critical findings found; 20 survived; 1 refuted; 7 advisories accepted
- **Audited remediation set:** initialized from `result.json.scope`; regression/support files and this plan are added before staging

## Surviving critical remediation

### 1. Complete the engine-owned orchestration façade

- **Sources:** `code-reviewer-1` (`engine/src/handlers/helpers/orchestration.ts:87`) — façade cannot start Wave Gate, Standalone Review, or remediation.
- **Fix:** register typed start/resume adapters for all five program kinds, using existing machines, operation DAGs, durable journals, and external actions; reject incomplete registration input.
- **Validation:** helper acceptance tests reach architecture, refutation, Wave Gate, standalone review, and remediation; `cd engine && npm run typecheck`.

- **Sources:** `code-reviewer-2` (`:711`), `silent-failure-hunter-1` (`:705`), `type-design-analyzer-3` (`:711`), `architecture-tech-lead-1` (`:698`) — deterministic engine operations are self-attested as successful.
- **Fix:** dispatch each operation through its typed deterministic implementation, validate complete roster/result authority, publish canonical ranking/tally/result receipts, and append success only after publication. Preserve idempotent recovery from publication-before-event crashes.
- **Validation:** refutation tally cannot finish without canonical `result.json`; architecture aggregate cannot finish without ranking; partial-publication retry test.

- **Sources:** `code-reviewer-3` (`:500`), `silent-failure-hunter-2` (`:520`), `type-design-analyzer-2` (`:520`) — any architecture JSON object advances a semantic stage.
- **Fix:** parse interview, candidate, judge, and finalization bytes with stage-specific constructors and retain canonical accepted values; malformed output consumes one bounded attempt and then blocks.
- **Validation:** helper-level `{}` candidate/judge/finalizer cases fail closed and exercise retry exhaustion.

### 2. Bind harness evidence to exact requests

- **Source:** `code-reviewer-4` (`engine/src/handlers/subagent-stop/capture-orchestration-result.ts:135`) — Claude automatic capture has no production spawn-side correlator.
- **Fix:** persist the exact Claude native-id/request/role/attempt binding at spawn acceptance and require it during capture; eliminate dependence on a parent-authored manual correlate step.
- **Validation:** Claude spawn-to-stop integration captures the exact reserved request; missing/wrong-role correlation fails closed.

- **Sources:** `code-reviewer-5` and `architecture-tech-lead-3` (`pi/extension.ts:1198`) — run-bound Pi `no-reservation` can mutate protected task state.
- **Fix:** distinguish unrelated legacy agents from Loom-owned/run-bound results; require `captured` before task/review/spec/phase mutation and surface attribution failure.
- **Validation:** run-bound no-correlator Pi results leave protected state unchanged and return an error.

- **Sources:** `pr-test-analyzer-2` (`pi/extension.ts:186`), `type-design-analyzer-1` (`:210`), `architecture-tech-lead-2` (`:204`) — same-role Pi batches are reconstructed by role and lexical request ordering.
- **Fix:** carry exact issued request authority in each spawn item and bind roster index to that request; never infer identity from role sorting.
- **Validation:** duplicate-role, multi-task, lexically inverted request-id batch lands each transcript in its intended slot.

- **Source:** `comment-analyzer-1` (`pi/extension.ts:182`) — comment falsely says correlator recording never throws.
- **Fix:** document the actual fail-spawn exception contract.
- **Validation:** prose/source contract test and typecheck.

### 3. Close concurrency and file-authority races

- **Source:** `code-reviewer-6` (`engine/src/orchestration/no-follow-fs.ts:123`) — stale-lock recovery can rename a newly acquired live lock.
- **Fix:** replace observe-then-rename recovery with a recovery protocol that never displaces the canonical live owner; release remains token checked.
- **Validation:** stale owner recovery, tombstone-owner change, and high-contention no-overlap tests.

- **Source:** `silent-failure-hunter-3` (`engine/src/core/panel-program.ts:1019`) — positional roster validation accepts reordered semantic slots.
- **Fix:** derive and verify every ordered slot id/request id against the canonical lens/criterion ordinal before pairing results.
- **Validation:** reordered candidate, judge, and refutation rosters fail with exact slot diagnostics.

- **Source:** `type-design-analyzer-4` (`engine/src/handlers/helpers/standalone-review.ts:277`) — transcript path is validated and then reopened by name.
- **Fix:** read immutable plan/session/input/transcript bytes through retained no-follow file descriptors or `RunDirHandle`, and bind bytes to the inspected inode/metadata.
- **Validation:** concurrent path replacement between inspection and read cannot enter aggregation.

### 4. Add missing behavioral proof

- **Source:** `pr-test-analyzer-1` (`engine/src/handlers/helpers/orchestration.ts:419`) — no test proves durable automatic capture is reconciled by resume.
- **Fix:** add reserve → durable capture → resume test proving exactly one semantic outcome and no CLI-submit dependency.
- **Validation:** targeted orchestration helper suite.

### 5. Replace forbidden parent-executable runbooks

- **Source:** `code-reviewer-7` (`skills/review-and-fix/SKILL.md:91`) — shipped runbooks still assign deterministic orchestration to the parent.
- **Fix:** replace per-agent model/transcript/journal/verdict/staging recipes in review-and-fix and Wave Gate docs with engine-owned façade start/resume actions after the façade is complete.
- **Validation:** runbook contract tests reject manual orchestration recipes and smoke tests execute the façade path.

## Accepted advisories

1. **`code-reviewer-8`** — `pi/extension.ts:204`: role/lexical Pi correlation. Fixed with exact request binding above; validate duplicate-role batch.
2. **`code-reviewer-9`** — `engine/tests/orchestration/benchmark-fixtures.ts:8`: benchmark only measures status. Replace with executable legacy/new replay for all five approved scenarios; validate parity/automation assertions.
3. **`pr-test-analyzer-3`** — `engine/src/handlers/helpers/orchestration.ts:500`: add malformed architecture helper test; covered above.
4. **`pr-test-analyzer-4`** — `engine/src/handlers/helpers/orchestration.ts:678`: add operation publication-before-event retry test; covered above.
5. **`pr-test-analyzer-5`** — `engine/src/orchestration/no-follow-fs.ts:111`: add stale-owner and owner-change recovery tests; covered above.
6. **`pr-test-analyzer-6`** — `engine/src/orchestration/git-remediation.ts:480`: add concurrent real-index-writer test proving the witness is rechecked under `.git/index.lock` and unrelated staged work is preserved or installation refuses.
7. **`comment-analyzer-2`** — `README.md:288`: distinguish human defer/dismiss choices from the machine's single advisory-decision acceptance transition.

## Refuted Findings (not fixing)

- **`silent-failure-hunter-4`** — `engine/src/orchestration/fugue-program-runtime.ts:173`: “createFileProgramJournal treats an unreadable checkpoint lookup as an absent checkpoint.”
  - **intent:** `readCheckpoint` returns null only when `existsSync` reports absence; an existing unreadable checkpoint reaches `readFileSync` and throws, implementing the intended absent/unreadable distinction.
  - **security:** the legacy file journal has no production call sites; production `RunDirHandle.readCheckpoint` returns null only for `ENOENT` and rethrows unreadable/symlink failures.

## Validation commands

```bash
cd engine && npm run typecheck
cd engine && npm run test:unit
cd engine && npm run test:unit
cd engine && npm run test:smoke
git diff --check
```

Stage only the audited remediation set plus this plan, verify exact staged-path equality, commit, and push without force.
