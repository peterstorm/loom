# PR Remediation Round 23

## Authority
- Branch: `fix/deterministic-task-completion-post-merge`
- Source review: `review-20260828T194302Z-deterministic-task-completion-oracle-post-remediation-27`
- Source result digest: `6b3f2b6d4011b9a647dfb5d9fd015eb7029e27b715cfa019c721fac4ad125eea`
- Exact frozen scope: the source result's 71-path `.scope` array.

## Mandatory fix
1. Parse every public `anchoredChildPath` child as one safe leaf before constructing `/proc/self/fd` authority, rejecting empty, dot, dot-dot, slash, and backslash forms.

## Advisory dispositions
### Accepted
- Recognize colocated Rust `#[test]` evidence in ordinary `.rs` files.
- Add traversal and externally-invalidated-close regressions for anchored capabilities.
- Preserve ordinary TS/JS/Python quote state across escaped physical-newline continuations and correct the associated lexer comment.
- Correct the reviewer-storage top-level logging comment to distinguish contextual error returns from the shared discard logger.

### Deferred
- Remaining no-follow/StateManager close aggregation and typed process-liveness diagnostics: broader descriptor-shell audit beyond the single surviving escape; existing paths remain fail-closed but can mask diagnostics.
- Task/review/settlement ADTs, scanner mode ADT, Wave Gate/StateManager/types module splits, parser deduplication, Pi review settlement deduplication, and test fixture extraction: independent interface/deepening work.

## Refuted-finding audit
- The sole critical was unanimously upheld and is mandatory.

## Validation
Focused no-follow traversal/capability tests, Rust evidence and line-continuation scanner tests/properties, typecheck/unused, full bounded Vitest, smoke with inherited Pi variables unset, production lint, diff check, registered remediation/index installation, commit/push, then fresh canonical review/refutation.
