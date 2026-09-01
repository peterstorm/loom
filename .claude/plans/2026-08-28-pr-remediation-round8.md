# PR Remediation Round 8 — deterministic Task completion authority

## Immutable review authority

- Source run: `review-20260828T070701Z-deterministic-task-completion-oracle-post-remediation-12`
- Reviewed revision: `4dedb4542a6d5441be3d59b9bd03128efc38d379`
- Result digest: `f9443780766cdb98782c66ca5b26dde2b152626f32c5355a42db33a3fde3aa58`
- Frozen scope: the 139 paths recorded in the source `result.json`; this remediation does not mutate that artifact.

## Mandatory critical remediation

1. **Stale modern attempt reclamation**
   - Compare the abandoned attempt's exact Task-scope and repository baselines with the replacement registration's freshly observed baselines.
   - Preserve evidence only when both canonical baseline digests match.
   - Otherwise reset the Task to revalidation-required, clear trusted test evidence, invalidate Task review authority, clear same-Wave spec-check authority, and reopen the Wave gate.
   - Add an integration regression where an abandoned agent modifies a declared artifact after an implemented/reviewed Task's baseline and a no-op replacement cannot inherit that authority.

2. **Thrown new-test observation failures**
   - Catch exceptions from the new-test collection port at the shared exact Claude/Pi settlement boundary.
   - Persist an infrastructure-blocked Oracle receipt with the thrown diagnostic instead of allowing the exception to escape.
   - Replace the former throw-through test with transport-parity receipt assertions.

## Advisory disposition

- Pi error payload rendering: accepted for this remediation when local and covered; include exact Oracle errors in operator diagnostics.
- Deterministic fake-Git ancestor-metadata regression: accepted; strengthen coverage if support-path registration permits it.
- Direct malformed-input regressions for capture and advance handlers: accepted; add focused tests where existing fixtures expose the direct boundary.
- Misleading cleanup/ledger/no-follow comments: accepted; correct comments without behavior changes.
- `ReservedSlot` discriminated union and branded TaskGraph pointer paths: deferred as interface migrations unrelated to the two authority defects.
- Core task/evidence type extraction and explicit locked settlement transaction: deferred as architectural migrations requiring an independently reviewed slice.
- `parseAuthorityBody` sequencing and `mark-tests-passed` projection simplifications: deferred; existing behavior is correct and this remediation minimizes unrelated functional-core churn.

## Validation and release

1. Focused stale-reclamation and exact-settlement tests.
2. Typecheck plus unused-symbol check.
3. Full bounded Vitest suite (`--maxWorkers=4 --minWorkers=1`).
4. Smoke suite.
5. Changed-production lint and `git diff --check`.
6. Register immutable support paths, install the exact verified index, commit, and push without force.
7. Run a fresh canonical standalone review plus three-lens refutation; do not open a PR while any critical survives.
