# PR Remediation Round 21

## Authority
- Branch: `fix/deterministic-task-completion-post-merge`
- Source review: `review-20260828T185558Z-deterministic-task-completion-oracle-post-remediation-25`
- Source result digest: `5d31c80cbab028230b8acb072323c4bbb32cdb20514c6dfd0cb333070f2de84c`
- Exact frozen scope: the 67-path `.scope` array in the source `result.json`.

## Mandatory fixes
1. Preserve ordinary double-quoted Rust and byte-string lexical state across physical lines so inert `#[test]` and assertion text cannot become evidence.
2. Recognize JavaScript/TypeScript regex literals used as `if`, `while`, and `for` statement bodies, including nested condition parentheses, without treating regex contents as assertions.
3. Make `AnchoredDirectory` a privately branded capability produced only by no-follow constructors; runtime-check the brand at exported descriptor operations so untyped callers also fail closed.

## Advisory dispositions
### Accepted
- Aggregate descriptor-close failures with primary anchored run-file operation failures instead of masking the original cause.
- Add the missing stale-block regression for `applyCurrentSpecCheckCaptureRejection`.
- Consolidate repeated Pi and Claude spec-check state commits behind one local immutable commit helper in each module.

### Deferred
- Convert `ReservedSlot` to a role-discriminated authority ADT: broad cross-harness persisted/runtime API change, independent of these defects.
- Move review evidence biconditional fields out of `TaskCommonMetadata`: Task lifecycle schema migration requiring coordinated parser/writer changes.
- Couple `ExactImplementationSettlement.infrastructureReason` to its application variant: separate exact-settlement interface refactor.
- Lazy/injected Pi environment path resolution: module-factory architecture change requiring shared-process test migration.
- Extract TaskGraph codec from `StateManager`: dedicated storage seam refactor.
- Extract repeated orchestration environment and executable-plan test fixtures: test-only cleanup outside this correctness round.

## Refuted-finding audit
- No critical finding was refuted; all three are mandatory.

## Security review
- Apply the loaded `security-expert` rules to the descriptor capability. A private unique-symbol brand prevents structural construction in TypeScript; runtime brand checks defend JavaScript/untyped call sites. Descriptor provenance remains rooted only in `openDirectoryNoFollow` and internal child-open operations.

## Validation
Focused example/property scanner regressions, no-follow capability tests, Wave capture-rejection regression, typecheck/unused, full bounded Vitest, smoke with inherited Pi variables unset, changed-production lint, diff check, registered remediation/index installation, commit/push, then fresh canonical review/refutation.
