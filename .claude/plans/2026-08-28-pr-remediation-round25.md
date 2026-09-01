# PR Remediation Round 25

## Authority
- Branch: `fix/deterministic-task-completion-post-merge`
- Source review: `review-20260828T204022Z-deterministic-task-completion-oracle-post-remediation-29`
- Source result digest: `457ce9207868d46a8d1bf9a877fef1c720965d751a6e6db81911f44d909767d2`
- Exact frozen scope: the source result's 73-path `.scope` array.

## Mandatory fixes
1. Enforce reserved Pi Review Run authority inside both malformed and parsed successful-review locked updates, matching failed and missing-result paths.
2. Recognize TSX root expressions after `return`/`yield` so JSX prose cannot become test/assertion evidence.
3. Add stale exact-authority regressions for successful Pi review results and omitted reserved reviewer results after Review Run replacement.

## Advisory dispositions
### Accepted
- Recognize defaulted TSX generic-arrow parameters such as `<T = string,>`.
- Add focused/property regressions for returned TSX and defaulted generics.
- Update failed-review authority documentation to name generation/packet/slot/attempt authority.
- Carry prevalidated per-slot review authorities rather than retaining a nullable graph for recomputation when practical without widening this fix.

### Deferred
- Partial call-start corruption parsing, no-follow cleanup aggregation, StateManager/Trusted Review/config architecture splits, parser/helper deduplication, and unrelated ADTs: independent remediation/deepening work.

## Refuted-finding audit
- All four critical findings survived canonical adjudication and are mandatory.

## Validation
Focused stale successful/missing reviewer integrations and TSX evidence properties, typecheck/unused, full bounded Vitest, smoke with inherited Pi variables unset, production lint, diff check, registered remediation/index installation, commit/push, then fresh canonical review/refutation.
