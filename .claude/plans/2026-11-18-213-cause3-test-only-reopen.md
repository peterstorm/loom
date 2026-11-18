# #213 Cause 3: a test-only reopen owes no red-then-green

- Issue: peterstorm/loom#213, Cause 3. Worktree `../loom-test-only-reopen`, branch `fix/test-only-reopen` from origin/main 98a9852c.
- ADR: ADR-0093 (`docs/adr/ADR-0093-a-reopen-names-what-the-finding-needs.md`).

## Today
- `reopen-task` (core/task-reopening.ts) returns the named Tasks to revalidation through `returnWaveTasksToRevalidation` and keeps each Task's stored Proof. A Task with `new_tests: required` in an I6-era graph keeps its `red-then-green` obligation.
- I6 (core/red-then-green.ts) needs a write to an implementation file after a failing run. A fix that only adds test rows has none, so it fails `implementation-write-missing`, or the Agent makes a cosmetic production edit to manufacture the order.
- #213's INV-4 mutant fix took 5 dispatches (attest, a brief bug, escalation, remediate, re-attest) for one test row.

## Design
- `reopen-task --needs tests|implementation` (default `implementation`). The request carries `needs`; the audit records `needs: "tests"` only for a tests-only reopening, so default audits are byte-identical.
- A tests-only reopening sets protected `reopen_scope` on each named Task: `{kind: "tests-only", test_files, implementation_files, baseline}` where the files are the frozen Test-File Classification of `file_list` and `baseline` is `{kind: "awaiting-attempt"}` until the first attempt after the reopen registers, then `{kind: "captured", entries}` (the registration's declared-artifact snapshot). Absent means a full re-implementation.
- `deriveProofObligations` is the one derivation. Given a tests-only scope it derives: `task-completed`, `regression-test-pass` (the policy must require regression, else the reopen is refused), `test-files-changed` (at least one declared test file changed since the reopen) and `implementation-files-unchanged` (no declared implementation file changed since the reopen). No `new-tests`, no `red-then-green`, no `declared-artifact-changed`.
- Settlement judges a tests-only Proof against the declared paths changed since the reopen baseline (`reopenScopeChangedPaths`, the shell's capture of current bytes over the baseline's artifacts). Retries keep measuring from the same baseline, so a production write in attempt 1 cannot be laundered by attempt 2.
- The scope ends when the lineage settles terminally: `implemented` (the satisfied tests-only Proof stays as the record) or `escalation-required` (the Task gets a fresh default pending Proof, so `remediate` dispatches a full re-implementation). Retry and infrastructure-blocked settlements keep it.
- Refusals: Distill Task; no frozen classification; no test file in `file_list`; regression waived; attestation-armed; a conflicting repeat (same Wave and Tasks, still awaiting, different `--needs`).
- Interactions: Distill sweep unchanged; `attest` refuses a tests-only Task; `rescope-task` re-derives the scope before the baseline is captured and refuses after; reconcile leaves a tests-only Task to its attempt (`settledOnlyByAttempt`); a later default reopen re-derives the default Proof; Wave Gate test readiness unchanged (regression is always owed); Task mutation check unchanged and useful (it mutates the Task's production lines since `start_sha`).
- Shown by: the dispatch appendix (status `nextActionPayload` and the brief's retry context), the brief's Verification Policy and engine-run sections, retro facts (`testsOnlyReopenings`).

## Tests (red first)
- Parser and decision table for `--needs`; replay idempotent; conflicting repeat refused; refusals.
- State File round-trip of `reopen_scope` and audit `needs`; malformed scopes refused; obligation lockstep.
- Proof: tests-only passes with test-only changes; fails on a production write; fails with no test change; no I6 owed.
- Registration captures the baseline once; settlement clears the scope; escalation re-derives the default Proof.
- End to end: reopen → brief → settle through the pure settlement path; default reopen unchanged.
