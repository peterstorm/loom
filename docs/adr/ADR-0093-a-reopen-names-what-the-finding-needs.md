# ADR-0093: A reopen names what the Finding needs

## Status
Accepted (2026-11-18). Implements loom#213, Cause 3. Builds on ADR-0045.

## Context
`reopen-task` (ADR-0045) returns an implemented Task to revalidation and keeps its Proof. A Task with `new_tests: required` in an I6-era graph keeps its `red-then-green` obligation, which needs a write to an implementation file after a failing run. INV-4's surviving mutants in #213 needed only new matrix-test rows. That fix has no implementation write, so it fails `implementation-write-missing`, or it invites a cosmetic production edit to manufacture the order. The recovery took five dispatches for one test row: attest, a brief bug, escalation, remediate, re-attest.

## Options Considered

1. **Typed tests-only scope on the Task, derived in the one Proof derivation (chosen).**
   - Pros: one place decides (`deriveProofObligations`). The State File proves the stored obligations against the scope. The production write is a named failure, not an instruction.
   - Cons: a new protected Task field, and a byte baseline the settlement shell must read.
2. **Waive new tests on the reopened Task (`attest`-like policy rewrite).**
   - Cons: nothing would prove the attempt touched a test file, and nothing would refuse a production edit.
3. **Let I6 count a test-file write as the implementation write.**
   - Cons: it weakens I6 for every Task, and a red before a test edit is not the order I6 exists to prove.
4. **Refuse production writes in the edit guard (as ADR-0085 does for attestation).**
   - Cons: the guard sees only file-tool writes, not shell or generator writes, and it would need the Test-File Classification of every write target. The Proof sees every byte, so it is the gate. A guard could be added later as a convenience.

## Decision
**`reopen-task --needs implementation|tests` (default `implementation`) records what the Finding needs. Under `tests` each named Task carries a protected `reopen_scope`, and its Proof owes changed test files, unchanged implementation files and regression, and no I6 order.**

- One value, `TestsOnlyScope` (`{testFiles, implementationFiles, reopening}`), is the Task's `reopen_scope`, the Proof derivation's input and the settled Proof's record. The two lists are the frozen Test-File Classification of `file_list`. `reopening` is the position of the reopening's audit in `task_reopening_history`. Beside it, `reopen_baseline` is absent until the first attempt after the reopening registers, then holds that registration's declared-artifact snapshot (`registerTaskExecutionBaseline`). No `reopen_scope` means a full re-implementation, so a graph that never names `--needs` is unchanged byte for byte.
- `deriveProofObligations` takes the scope (`ArtifactScopeInput`: exactly one of an expectation or `testsOnly`; neither may be omitted) and derives `task-completed`, `regression-test-pass`, `test-files-changed` (which records `reopening`) and `implementation-files-unchanged`. It derives no `new-tests`, no `red-then-green` and no `declared-artifact-changed`. `taskArtifactScope(task)` is the one reader of a Task that builds this input. The revalidation transition takes each Task's scope (`returnWaveTasksToRevalidation(wave, ids, scopes)`), so a reopened Task is derived once.
- Settlement judges a tests-only Proof against `reopenScopeChangedPaths`, the declared paths whose bytes differ from the reopen baseline (`proofArtifactChanges`). An implementation file whose bytes differ at the end fails as `implementation-files-changed`, naming the files. An attempt that changed no test file fails as `test-files-not-changed`. A registered attempt with no captured baseline is refused by the State File, and the settlement shell's byte observation returns a typed refusal (an unavailable observation, never a throw).
- Refusals (`TaskReopeningRefusal`): `tests-only-distill-task`, `tests-only-contract-task`, `tests-only-regression-waived`, `tests-only-unclassified` (no frozen classification) and `tests-only-no-test-files`. A repeat of the same reopening is idempotent. The same Wave and Tasks, still awaiting their attempt, with other `--needs` are refused as `needs-conflict`.
- The audit records `needs: "tests"` only for a tests-only reopening.
- The State File proves a tests-only scope against data the scope does not supply. Whether live in `reopen_scope` or recorded in a settled Proof, the audit at `reopening` must be a `needs: "tests"` reopening of the Task's Wave that named the Task, and the two lists must equal the frozen classification of `file_list`. It also checks the partition, required regression, and that the Task is neither a Distill Task nor an Acceptance Contract writer. The stored obligations must then equal what the scope derives.
- The scope ends when the lineage settles terminally. `implemented` drops the scope and the baseline and keeps the satisfied tests-only Proof as the record. `escalation-required` drops both and derives the default pending Proof, so `remediate` dispatches a full re-implementation. A retry and an infrastructure block keep the scope. Any `returnToRevalidation` drops it and re-derives the default Proof.
- Shown by: the dispatch's tests-only appendix (status prints it, the spawn gate binds it, the brief renders it as the retry context), the brief's Verification Policy paragraph and engine-run command, and retro facts (`testsOnlyReopenings`).
- The Finding is re-checked where it was raised: the fresh Wave Gate's reviewers and its Owner Verification.

**Interactions.**
- *Distill Task sweep.* Unchanged: a tests-only reopening sweeps the settled Distill Task back (the new tests are code it distills). The swept Task takes no scope. Naming a Distill Task with `--needs tests` is refused.
- *Attestation.* `attest` refuses a tests-only Task (`tests-only-not-attestable`): attestation owes no change, a tests-only attempt owes a test change. The State File refuses the two together.
- *Retries (attempt 2).* Attempt 2 is still tests-only and is measured from the same baseline. A production write in attempt 1 fails attempt 2 unless it is reverted, so a retry cannot launder it.
- *`rescope-task`.* Before the first attempt, a re-scope re-classifies the scope over the new list and refuses a list with no test file. After the baseline is captured, it is refused (`tests-only-attempted`): the baseline would no longer cover the list.
- *Reconcile.* A tests-only Task is settled only by its attempt (`settledOnlyByAttempt`), as a Distill Task is. Re-reading the cumulative delta would count the original implementation as a production write.
- *Wave Gate test readiness.* Unchanged. A tests-only Task always owes a trusted regression pass (a waived regression is refused), so it reaches the gate with the same test evidence as any Task.
- *Task mutation check.* Unchanged. It mutates the Task's production lines since `start_sha`, so it checks that the new tests kill the mutants.

## Consequences

**Positive:**
- A Finding that new tests close costs one dispatch, and no production edit is needed or accepted.
- The obligation set is decided in one place and proven at the State File boundary against the reopening audit and the frozen classification, so a tests-only Proof cannot be mistaken for a full one or claim a reopening that never happened.

**Negative:**
- Two more protected Task fields to parse, and a settlement shell read of the reopen baseline.
- A Task whose `file_list` names no test file cannot be reopened for tests only. Reopen it in full, re-scope it to add the test file, let it settle, then reopen it with `--needs tests`. A tests-only Task can be re-scoped only before its first attempt; after that it can only settle or escalate.
- An escalated tests-only Task becomes a full re-implementation. An operator who wants another tests-only attempt reopens it again after it settles.
