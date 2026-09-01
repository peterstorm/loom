# PR Remediation Round 31

## Authority
- Branch: `fix/deterministic-task-completion-post-merge`
- Source review: `review-20260828T231627Z-deterministic-task-completion-oracle-post-remediation-35`
- Source result digest: `e9d695e97162a54e831c70b74938db0199946ce59109ec344cc3fbc29d175aed`
- Exact frozen scope: the source result's 79-path `.scope` array.

## Mandatory fixes
1. Skip TaskGraph registration entirely when the spawn-time observation proves no graph was active.
2. Skip reserved implementation finalization and missing review/spec reconciliation for permanently ad-hoc reservations before any result-time StateManager resolution.
3. Add graph-created-after-spawn regressions for missing reviewer results and implementation finalization.

## Advisory dispositions
Unrelated provenance-ADT, module-deepening, parser/comment, and fixture advisories remain deferred.

## Refuted-finding audit
- No critical finding was refuted; all five aggregated findings map to the three mandatory fixes above.

## Validation
Focused TOCTOU/ad-hoc integration regressions, typecheck/unused, full bounded Vitest, smoke, production lint, diff check, registered remediation/index installation, commit/push, then fresh canonical review/refutation.
