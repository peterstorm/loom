# PR Remediation Round 30

## Authority
- Branch: `fix/deterministic-task-completion-post-merge`
- Source review: `review-20260828T225442Z-deterministic-task-completion-oracle-post-remediation-34`
- Source result digest: `8ed4202dbbceaa8ef851af2d4662df1cddb6bc1a1c1a790208e41e7c3bda8ebb`
- Exact frozen scope: the source result's 78-path `.scope` array.

## Mandatory fix
1. Treat `graphActiveAtSpawn: false` as permanent ad-hoc provenance during Pi result dispatch: never resolve or mutate a TaskGraph that appeared after spawn.

## Advisory dispositions
Unrelated architecture/type/scanner/test-comment advisories remain deferred to dedicated slices.

## Refuted-finding audit
- The sole critical was unanimously upheld and is mandatory.

## Validation
Focused graph-created-after-spawn integration regression, typecheck/unused, full bounded Vitest, smoke, production lint, diff check, registered remediation/index installation, commit/push, then fresh canonical review/refutation.
