# PR Remediation Round 33

## Authority
- Branch: `fix/deterministic-task-completion-post-merge`
- Source review: `review-20260828T235944Z-deterministic-task-completion-oracle-post-remediation-37`
- Source result digest: `bfa8c7e6556d68968835199474d87821db6da3a83f8fbaaaf2560973809d4f92`
- Frozen scope: the source result's exact 81-path `scope` array.

## Mandatory fixes
1. Preserve exact Claude request authority after successful capture. Non-Wave request-bound programs clean up and terminate as passthrough without requiring a TaskGraph; Wave Gate requests continue through protected-state settlement.
2. Remove the divergent, test-only Wave review authority contract. Move the live deterministic derivation into one pure core module and make the Wave Gate façade a thin observation/publication adapter.

## Advisory dispositions
### Accepted
- Replace the remediation-round production comment in `engine/src/config.ts` with its durable allowlist invariant.
- Remove the fixture-restating comment in `engine/tests/handlers/store-spec-check-findings.test.ts`.
- Add the missing unreadable existing spec-check transcript regression if the platform permits a deterministic unreadable fixture.

### Deferred
- `projectedAdvisoryStatus` typed projection diagnostics and `StateManager.atomicWrite` aggregate close errors: valid but separate behavior/error-surface changes.
- Role-indexed `ReservedSlot` and disjoint missing-result ADTs: valid broader Pi contract redesign.
- TaskGraph codec extraction, bounded type modules, and explicit proof values: valid architectural follow-ups broader than this authority correction.
- Shared hook parser, pointed-graph capture helper, and shared Pi review application skeleton: valid cleanup, but unrelated to the mandatory authority seam.

## Refuted-finding audit
No critical finding was refuted; all two surviving criticals are mandatory.

## Validation
Run focused authority/dispatch/Wave Gate tests, typecheck and unused checks, full bounded Vitest, smoke with inherited Pi runtime variables unset, changed-production lint, and `git diff --check`. Register support paths, install the exact verified index, commit/push, then run a fresh canonical review and refutation panel.
