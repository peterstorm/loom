# PR #66 round-3 deferred advisories (2026-10-07)

- **Branch:** `fix/pr66-deferred-advisories`, cut from `main` at `eee48bf2` (the PR #66 merge).
- **Source review:** the round-3 registered read-coverage standalone review of `6d25b0a5..0bceb426`, nine slices
  `raf-pr66-r3-r01` … `raf-pr66-r3-r09`. 56 reviewers, every one credited with full read coverage, no retries.
- **Result:** 0 surviving criticals, 0 refuted criticals, 49 advisories. `defectFamily` is `{ "kind": "not-required" }`.

## Advisory dispositions (P5, DECLARED)

1. **Initial revision, at merge time:** all 49 deferred (policy runs `raf-pr66-r3-rNN-policy`), so the merged code stayed the
   reviewed code.
2. **Correction revision, after merge:** the operator asked for every one to be fixed. All 49 are now **accepted**, in policy
   runs `raf-pr66-r3-rNN-policy-correction`, each chained to its initial revision by digest. r06 had no advisories.

## Implementation (six isolated workstreams, merged without conflicts)

| WS | Commit | Area | Advisories |
|---|---|---|---|
| X1 | 8609d251 | Calibration pilot. `WindowInputs` is an opaque class with one builder; `CellBinding` is one union per producer kind; the corpus loader moves to a testable shell adapter. | 6 |
| X2 | 2f7beb91 | Panel program kernel. Canonical state JSON is supplied by each program instead of name-filtered `jsonEqual`; `parseAuthority` takes `unknown`; dispatch replay moves to `panel-program.ts` with typed errors; one `cli-flag-token` leaf; the artifact-baseline brand is type-only. | 11 |
| X3 | 3e4c3de9 | Handlers and records. `withBatchSubjects` returns a typed mismatch and blocks before install; `hasExactKeys` is set-based over all own keys; section-blob lookups return `DomainResult`; spec-check delivery unions are narrowed; read-coverage capture is one match. | 11 |
| X4 | dec3dce7 | Git execution policy. `hardenedGitInvocation` returns argv and env together, so fsmonitor is disabled by `-c` on every Git version as well as by env config; changed-path listings are classified content-hashing vs filter-free; one NUL split. | 5 |
| X5 | e1b86978 | Fixtures and launcher. `pi/emission-readiness-sequence.ts` holds the launcher step order once, with the shipped verifier and the test harness as its two adapters; `withEnvOverlay`; registry cells carry their schema; aliases removed. | 7 |
| X6 | 70237218 | Pi spawn claims. Durable vs process-local claim layers, so settlement wires only durable ports; single-slot claims refuse a second claim; one pruning rule in the review witness; one revoke-failure helper. | 9 |

## Not in scope, reported

- `engine/src/orchestration/remediation-candidate.ts` and `engine/src/utils/workspace-digest.ts` still add their own inline
  `-c core.fsmonitor=false` rather than using `hardenedGitInvocation`.
- About a dozen test files keep a local `valueOf` unwrap that duplicates `tests/fixtures/parse-result.ts`.
- `pi/session-shutdown.ts` keeps its own pointer-release and roster-removal logic beside the durable claim ledger.
- `predecessor-archive.ts` has a private `hasExactKeys` with stricter, different semantics from the shared predicate.

## Validation

- `npm run verify` from the repository root.
- Registered remediation from a round-3 slice whose frozen head is `0bceb426`, with every changed path outside that slice's
  frozen scope named as a `supportPath` and `defectFamily: {"kind":"not-required"}`.
