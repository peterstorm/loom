# PR Remediation Round 2 — Canonical Pointer Bytes and Platform Contract

## Authority

- Branch: `feat/deterministic-task-completion-oracle`
- Reviewed HEAD: `5b5dadab37f8cd5c89855419340b2952057c8f39`
- Source review: `review-20260827T164038Z-deterministic-task-completion-oracle-post-remediation-5`
- Source digest: `a20e71afcfb19518fa89e35561fec27f28a1a970cb9b9f05fc62adb3f06a7944`
- Frozen scope: the exact 119 paths in the source result

## Mandatory critical remediation

1. **Declared macOS support contradicts safe mutation capability** — make the orchestration filesystem contract explicitly Linux-only, expose one startup platform assertion, and invoke it before CLI or Pi extension registration. Remove unreachable Darwin mutation behavior and keep descriptor-relative Linux operations as the sole implementation. Add exact platform-contract tests.
2. **StateManager accepts malformed session pointer bytes** — introduce one pure canonical TaskGraph pointer parser and require it before existence probing in both session resolution paths. Add empty, relative, padded, and non-normalized regressions.
3. **Lease lifecycle accepts malformed pointer bytes** — reuse the same parser in pointer acquisition/release so exact ownership cannot be proved by trimmed or non-canonical content. Add acquisition and release regressions.

## Advisory dispositions

All 12 advisories are deferred because they are independent from this remediation: Pi infrastructure settlement, Pi pending pointer cleanup, two parser-diagnostic enrichments, atomic-write test expansion, one transcript comment, four FC/IS deepening candidates, and two simplifications. The two Pi authority advisories should be prioritized in the next dedicated cleanup-authority change; the architecture findings require independently reviewable seam changes.

## Refuted audit

No critical was refuted; all three were unanimously upheld by reproduction, intent, and security.

## Validation

Typecheck/unused; focused platform, StateManager, pointer lease, and Pi extension load tests; full bounded Vitest; smoke suite; changed-production lint; diff check; distill apply-mode pass; registered remediation; verified-index installation; commit/push; fresh canonical review/refutation.

## Support paths outside frozen review scope

- `.claude/plans/2026-08-28-pr-remediation-round2.md`
- `README.md`
- `docs/operations.md`
- `engine/src/cli.ts`
- `engine/tests/orchestration/no-follow-fs.test.ts`
- `scripts/smoke-panel-mode.sh`
