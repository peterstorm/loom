# PR Remediation Round 26

## Authority
- Branch: `fix/deterministic-task-completion-post-merge`
- Source review: `review-20260828T210406Z-deterministic-task-completion-oracle-post-remediation-30`
- Source result digest: `95e60e8f01a52d9fd1bb82416b4d54a85c8ce9148368a07cc525fdec04410469`
- Exact frozen scope: the source result's 74-path `.scope` array.

## Mandatory fixes
1. Permit authority-free Claude spec-check settlement only for explicitly legacy graphs; modern spec-trace/history/manifest evidence remains modern after active authority retirement and rejects late or direct results.
2. Replace Pi phase mismatch's silent boolean with a typed stale/future decision: past duplicates log a no-op, future/out-of-order completions return a processing error.

## Advisory dispositions
### Accepted
- Treat failed Pi phase-agent results as processing errors naming that the phase did not advance.
- Add stale malformed-review authority regression.
- Model Pi review authority as legacy vs exact union if achievable without widening persisted formats; otherwise retain the current exact fields for this focused round.

### Deferred
- Partial call-start corruption, no-follow aggregation, role-discriminated ReservedSlot, Pi batch extraction, TaskGraph/Trusted Review/config deepening, and parser/StateManager/session-registry simplifications: independent slices.

## Refuted-finding audit
- Both critical findings were unanimously upheld and are mandatory.

## Validation
Focused completed-modern spec-check and stale/future/failed phase regressions, stale malformed review test, typecheck/unused, full bounded Vitest, smoke with inherited Pi variables unset, production lint, diff check, registered remediation/index installation, commit/push, then fresh canonical review/refutation.
