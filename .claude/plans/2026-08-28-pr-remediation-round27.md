# PR Remediation Round 27

## Authority
- Branch: `fix/deterministic-task-completion-post-merge`
- Source review: `review-20260828T213913Z-deterministic-task-completion-oracle-post-remediation-31`
- Source result digest: `43a5b8372f82d8395ef1565a785e267062a3fd86931a8d63be67301f0fea69de`
- Exact frozen scope: the source result's 75-path `.scope` array.

## Mandatory fixes
1. Reject authority-free Pi reviewer mutation whenever a Task carries review-generation authority, even after its active Review Run retires; only never-generated legacy Tasks may accept Task-only authority.
2. Classify unreadable Claude reviewer evidence as ignored stale when modern review authority has retired, while active and explicitly legacy reviews retain evidence-failed behavior.
3. Correct Claude capture documentation: reservation lookup uses exact Run Directory authority plus `agent_id` as the native correlator, not session/type fields.

## Advisory dispositions
### Accepted
- Add stale malformed Pi and unavailable Claude review regressions against retired generation-aware Tasks.

### Deferred
- Remaining parser/StateManager/session-registry simplifications, partial call-start corruption, no-follow aggregation, Pi authority ADTs/batch extraction, and broad module deepenings: independent slices.

## Refuted-finding audit
- All three critical findings survived canonical adjudication and are mandatory.

## Validation
Focused retired-review tests, typecheck/unused, full bounded Vitest, smoke with inherited Pi variables unset, production lint, diff check, registered remediation/index installation, commit/push, then fresh canonical review/refutation.
