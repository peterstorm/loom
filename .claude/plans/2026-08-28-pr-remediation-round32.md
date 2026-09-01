# PR Remediation Round 32

## Authority
- Branch: `fix/deterministic-task-completion-post-merge`
- Source review: `review-20260828T233957Z-deterministic-task-completion-oracle-post-remediation-36`
- Source result digest: `406e063325ea699c5ea201bea0baeec8f2d7a54366c065442e0a29072c3f7f70`
- Exact frozen scope: the source result's 80-path `.scope` array.

## Mandatory fix
1. Always classify and durably terminalize request-bound missing/malformed Run Directory results, including graphless standalone runs; suppress only TaskGraph review/spec reconciliation for graphless provenance.

## Advisory dispositions
- Accept removal of the now-unreachable ad-hoc missing-result branch and correct the PostEdit multi-edit banner.
- Other architecture/type/scanner/StateManager advisories remain deferred.

## Refuted-finding audit
- The sole critical was unanimously upheld and is mandatory.

## Validation
Focused graphless request-bound missing-result retry regression, typecheck/unused, full bounded Vitest, smoke, production lint, diff check, registered remediation/index installation, commit/push, then fresh canonical review/refutation.
