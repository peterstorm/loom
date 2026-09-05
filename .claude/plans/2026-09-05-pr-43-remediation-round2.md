# PR #43 Remediation — round 2

**Branch:** `feat/structural-spec-check` (worktree `/home/peterstorm/dev/claude-plugins/loom-structural-spec-check`, head `215eb5f`)
**PR:** <https://github.com/peterstorm/loom/pull/43>
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/review-20260905T154613Z-16343`

## The review was PARTIAL — say this first

Of the seven registered reviewers, **two completed, two were cut off mid-run by an API session rate limit, and three were never spawned** for the same reason. **No refutation panel ran.** This round therefore has:

- no `result.json`,
- no adjudicated `surviving_critical_findings`,
- no refuted-findings audit.

What it has instead: seven findings from the two reviewers that finished (`silent-failure-hunter`, `type-design-analyzer`), **every one of which I verified myself before acting on it** — by reading the code and by running probes that reproduce the failure. Six were confirmed and fixed. The verification evidence is recorded per defect below, because the panel that normally supplies that confidence did not run.

**This is not a clean round. The scope that was never reviewed is:** `code-reviewer` (partial), `pr-test-analyzer` (partial — and it was the reviewer that found ten surviving mutations in round 1), `comment-analyzer`, `architecture-tech-lead`, `code-simplifier`. Another full round is owed.

## Exact frozen scope (26 paths)

`.claude/plans/2026-09-05-pr-43-remediation.md`, `CONTEXT.md`, `commands/spec-check.md`, `engine/src/core/parse-spec.ts`, `engine/src/core/requirement-coverage.ts`, `engine/src/core/wave-review-authority.ts`, `engine/src/handlers/helpers/populate-task-graph.ts`, `engine/src/handlers/helpers/programs/wave-gate.ts`, `engine/src/handlers/subagent-stop/store-spec-check-findings.ts`, `engine/src/linter/programmatic/no-cross-boundary-imports.ts`, `engine/src/orchestration/spec-index-observation.ts`, `engine/src/orchestration/wave-spec-check-documents.ts`, `engine/src/parsers/index.ts`, `engine/src/types.ts`, and the eleven test files plus `pi/subagent-result.ts`.

**One path outside it was touched**: `engine/src/core/spec-check.ts`, registered as a support path. The fix for the round's central defect *is* moving the floor into that file — see D1.

---

## D1 — The floor existed on one of three settlement paths, and erased itself on a second

*silent-failure-hunter C1+C2, type-design-analyzer C2+C3. Verified by reading all four call sites and the resume loop.*

Round 1 put `settledFloorProblem` beside one caller. `grep` found **exactly one call site in the tree**:

| Path | Round 1 |
|---|---|
| `store-spec-check-findings.ts` (Claude SubagentStop) | floored |
| `pi/subagent-result.ts:1770` (`reducePiSpecCheckResult`) | **unfloored** — `.authority` discarded the index |
| `wave-gate.ts:1409` (`applyWaveFacadeSubmission`) | **unfloored** — same discard |

Worse than a gap. `wave-gate.ts:1703`:

```ts
if (request.role === "spec-check-invoker" && now.spec_check?.wave === registration.input.wave &&
    now.spec_check.verdict !== "EVIDENCE_CAPTURE_FAILED") continue;
```

The resume loop re-applies a capture **exactly when** `spec_check.verdict` is `EVIDENCE_CAPTURE_FAILED` — which is precisely what a floor violation writes. So the hook recorded the refusal and the façade then re-applied the same transcript bytes through its unfloored path and overwrote it with the Agent's under-reported `PASSED`. **The round-1 enforcement was self-defeating.**

**Fix:** the floor moves into `reconcileSpecCheck`, whose own docstring already promised *"Every harness calls this function, so a transcript cannot be clean on one harness and evidence-failed on another."* That promise is the invariant round 1 violated. `settledSpecCheckFloor` is the single derivation; all three settlement paths now pass it, and the façade resolves **inside** its lock against the locked graph.

## D2 — `cell()` escaped pipes but not backslashes

*silent-failure-hunter C4. Reproduced.*

`value.replace(/\|/gu, "\\|")` turns an input that already contains `\|` into `\\|` — an escaped **backslash** followed by a **live** delimiter. Probe, with `spec_anchors: ["FR-001\|forged\|engine\|NONE\|fine"]`:

```
| T1 | FR-001\\|forged\\|engine\\|NONE\\|fine | engine | CRITICAL | … |
```

Under GFM that row splits at every one of those pipes, so an agent-authored claim owns its own `Decided by` and `Severity` columns and pushes the engine's off the row. `spec_anchors` come from the decompose payload, validated only as non-empty strings.

**Fix:** backslashes first, then pipes.

## D3 — The synthetic no-claims row rendered CRITICAL against a stated floor of 0

*silent-failure-hunter C3. Reproduced.*

`renderRows` fabricates one `engine | CRITICAL` row for an empty roster; `settledCriticalCount` counted only `coverage.rows`, which is empty in exactly that case:

```
| — | — | engine | CRITICAL | — | this Wave's Tasks make no Requirement Completion Claims… |
Settled CRITICAL findings: 0. Your report may not fall below this count.
```

The one defect that row exists to catch — a whole Wave of work tracing to no Requirement — was the one settled CRITICAL an Agent could drop for free.

**Fix:** the floor counts it.

## D4 — A non-string recorded hash crashed the Wave Gate

*type-design-analyzer C1. Reproduced.*

`RecordedHash.unreadable.stored` is typed `string`, but nothing on the load path parses `spec_anchor_hashes` — `migrateParsedTask` spreads the record through verbatim. `parseTaskGraph` accepts `{"FR-001": 42}`, and `claimVerdictMessage`'s `stored.slice(0, 16)` then threw:

```
TypeError: stored.slice is not a function
```

out of `prepareWaveReviewBatch`, whose contract is a stated `DomainResult` refusal.

**Fix:** parse at the boundary and describe what was actually there (`<non-string number>`).

---

## Dispositions

**Accepted and fixed:** D1–D4 above, plus the advisory that the mandated floor line has no source on the Unprojected path (folded into D1's `null` semantics), and the pre-existing `parseSpecCheckOutput` 50-line lint violation that surfaced once `spec-check.ts` entered the changed set — `footerFindings` extracted.

**Deferred, with reason:**
- *The enforced floor is re-derived from live `state.tasks`* (silent-failure-hunter A1). Real: `files_modified` can grow between packet build and capture, weakening the floor by one. Always weakening, never a false block. The honest fix is carrying the packet's own settled count in request authority so a disagreement is loud — that is a request-authority schema change and wants its own pass.
- *The bytes-pairing proof is skipped for an unavailable index* (both reviewers). The `unavailable` arm carries no digest, so the guard short-circuits. Production has one producer and it cannot construct a mismatched pair; this is a type-admits-it gap, and closing it means giving `SpecIndexUnavailable` a digest.
- *`SpecIndexAvailability.contentDigest` is an unbranded `string`* compared against an `ArtifactDigest`. Runtime-correct today (both are lowercase sha256 hex); the brand simply is not doing work at that seam.
- *`renderUnclaimed` widens both branded id lists to `readonly string[]`*, so the two calls' arguments are mutually swappable.
- *`resolvedSpecFile`'s two parameters are both `string | undefined`*, so they transpose cleanly.
- *`NONE` is a poor name* for "structure raised nothing".

All six are type-shape improvements with no reproduced failure. Grouping them into one typed pass beats scattering them through a remediation whose central fix is an enforcement seam.

**Not adjudicated:** anything the five missing reviewers would have found.

## Validation

- Authoritative unit suite: **240 files, 6,241 passed**, 1 platform skip, 0 failures.
- TypeScript + unused-code gates pass by exit code.
- Full-tier lint: **0 violations** across all changed TypeScript files.
- All six smoke suites pass.
- `git diff --check` clean.
- **Round-2 mutation ledger — all seven killed:** façade drops the floor; SubagentStop drops the floor; Pi drops the floor; `reconcileSpecCheck` ignores the floor; `cell` escapes pipes only; the empty roster is not counted; the non-string `stored` goes unparsed.
- The new call-site scan (`tests/core/spec-check-floor.test.ts`) found a **fourth** `reconcileSpecCheck` call site I had missed. It reconciles the empty transcript to synthesize a capture rejection and fails on the missing marker before any floor applies; the scan states that exemption explicitly rather than silently allowing it.
