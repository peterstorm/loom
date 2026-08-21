# PR Remediation Plan — 2026-08-12 (Round 40)

**Branch:** `feat/architecture-panel-mode-plan`
**Review Run:** `run.I82su845nF`
**Run Directory:** `.claude/reviews/review-and-fix-runs/run.I82su845nF`
**Result:** `.claude/reviews/review-and-fix-runs/run.I82su845nF/result.json` (tally-published)

## Adjudication summary

- **Surviving critical findings:** 2 (`silent-failure-hunter-1`, `silent-failure-hunter-3`) — both upheld 3/3 by the Refutation Panel (lenses: reproduction, intent, blast-radius).
- **Advisory findings:** 26 raw entries = 13 unique claims (each duplicated once as a location-less marker-line carry-over).
- **Refuted critical findings:** 0. Nothing to audit beyond: none refuted; all panel outcomes upheld.

## Surviving criticals and concrete fixes

### C1 — `silent-failure-hunter-1` — fail-open default task-graph probe
**File:** `engine/src/core/block-direct-edits.ts:26`
**Claim:** `shouldBlockDirectEdit`'s default `taskGraphExists` probe is bare `existsSync(TASK_GRAPH_PATH)`, which returns `false` on EACCES/ELOOP/ENOTDIR/EIO, so an unreadable task-graph path silently returns `allow` and disarms the direct-edit gate for every caller without an override (the pi extension fixed this with `pathExistsFailClosed`; the engine-core default retained the fail-open).
**Fix:**
- Add a shared fail-closed existence probe in `engine/src/config.ts` (exports `pathExistsFailClosed(path)`): `accessSync(path, F_OK)`; `ENOENT` is the only absent answer; every other error writes a diagnostic to stderr and returns `true` (assume present → gate stays armed).
- Use it as the default probe in `shouldBlockDirectEdit` (third parameter default becomes `() => pathExistsFailClosed(TASK_GRAPH_PATH)`).
- `pi/extension.ts` already passes its own fail-closed override — unchanged, but it now matches the core default semantically.

### C2 — `silent-failure-hunter-3` — bare probes in `findTaskGraphPath`
**File:** `engine/src/config.ts:596,604`
**Claim:** `findTaskGraphPath` uses bare `existsSync` probes at lines 596/604, silently treating an unreadable candidate (EACCES/ELOOP/ENOTDIR/EIO) as absent and falling back to the harness-native creation path — so `TASK_GRAPH_PATH` can name a path that does not exist while the real (unreadable) graph is skipped, compounding the C1 fail-open.
**Fix:**
- Replace both probes with `pathExistsFailClosed` (same fix as C1): a non-ENOENT-unreadable candidate is treated as present and returned, keeping `TASK_GRAPH_PATH` pointing at the real path so downstream fail-closed gates stay armed.
- Import `accessSync`/`constants` from `node:fs` in config.ts.

## Accepted advisories (7 unique — explicit disposition)

1. **silent-failure-hunter — `engine/src/utils/git.ts` silent fallbacks** (advisory, MEDIUM): surface diagnostics instead of silent collapse:
   - `resolveRepoRoot()`: log when `git rev-parse --show-toplevel` fails at module load (name the cause).
   - `exec()`: emit the warning even when stderr is empty (currently only warns when stderr is truthy → failures without stderr are fully silent).
   - `isGitRepo()`: log the failure cause instead of silently returning `false`.
   - `diffUntracked()`: distinguish the expected exit-1 "files differ" result (stdout) from other failures — non-exit-1 failures get a stderr diagnostic, not `""`.
   - Behavior otherwise unchanged (still returns benign values; this advisory is about diagnosability, matching the finding text).
2. **pr-test-analyzer — `pi/extension.ts:113` `pathExistsFailClosed` non-ENOENT branch never exercised**: add a direct unit test for the core `pathExistsFailClosed` probe (moved to `engine/src/config.ts`) covering ENOENT → false and non-ENOENT (unreadable path / ELOOP) → true with diagnostic. This pins the C1/C2 fix.
3. **type-design-analyzer — `engine/src/types.ts:436` `WaveGate` mutable fields**: add `readonly` to the four fields of the `WaveGate` interface (all writers already build fresh objects — zero-cost).
4. **type-design-analyzer — `engine/src/state-manager.ts:855-878` wave_gates record keys unvalidated**: reject non-canonical integer record keys (`String(wave)`) at the `parseTaskGraph` load boundary instead of installing the raw object.
5. **type-design-analyzer — `engine/src/core/standalone-review.ts:241` `docsOnly ⟹ commentsChanged` invariant unenforced**: reject `{docsOnly: true, commentsChanged: false}` at the `parseReviewMetadata` boundary (the shell producer satisfies the invariant by construction).
6. **comment-analyzer — `engine/src/orchestration/dags/run-context.ts:40` `lowerRunId` doc claim wrong**: rewrite the doc comment to state that a colon-containing run id is *rejected* by the `LOOM_RUN_ID` guard, not "kept".
7. **comment-analyzer — `engine/src/handlers/subagent-stop/advance-phase.ts:1` misleading linear phase chain**: qualify the header chain as the happy path and point at `PHASES`/`VALID_TRANSITIONS` as the source of truth.

## Deferred advisories (explicit disposition — not accepted this round)

- **pr-test-analyzer (5):** build-time `ByteSection` digest test, `rejectCapture`/`readCaptureRejection` unit tests, `runChild` catch-branch test, `wave_review_epoch` reset test, `LOOM_CONTEXT_PATH` marker test — coverage polish rated 3–5 by the reviewer itself ("optional polish, not a quality crisis"); integration coverage already exists. Defer to a dedicated test-hardening round.
- **architecture-tech-lead (4):** `orchestration-contract.ts` god-module split, resume-policy extraction into the pure core, `core/` raw-fs hook migration to `O_NOFOLLOW`, WeakMap identity-cache redesign — structural refactors with wide blast radius; require their own design round, not a remediation round. Each is explicitly fail-closed today, so no integrity risk in deferring.
- Observation (no finding): `engine/src/core/guard-state-file.ts:687` uses bare `existsSync(TASK_GRAPH_PATH)` for the Bash-tool gate — same fail-open pattern but outside the adjudicated findings' scope; noted for a future round, not fixed here. The scope also contains a stale 0-byte `engine/tests/handlers/store-reviewer-findings.test.ts` entry beside the real `engine/tests/handlers/subagent-stop/store-reviewer-findings.test.ts` (19,875 B, fully reviewed) — a scope artifact, not a code defect.

## Validation commands

```bash
cd /home/peterstorm/dev/claude-plugins/loom
bunx tsc --noEmit -p engine/tsconfig.json
bun test engine/tests/ (full suite; in scope: block-direct-edits / config / state-manager / standalone-review / git / run-context / advance-phase relevant tests)
```

## Refuted-finding audit

None. The panel convened 2 criticals, upheld both 3/3, refuted 0. No refuted evidence to retain or report.
