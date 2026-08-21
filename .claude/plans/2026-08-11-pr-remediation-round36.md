# PR Remediation — Round 36

## Review authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Standalone run:** `.claude/reviews/review-and-fix-runs/run.3UuWlu3ZXA`
- **Exact scope:** the immutable 319-path `scope` array in `.claude/reviews/review-and-fix-runs/run.3UuWlu3ZXA/result.json`
- **Adjudication:** 25 surviving critical findings, 0 refuted critical findings, 2 accepted advisories
- **Audited remediation path set:** initialized from `result.json.scope`; regression tests/support files and this plan are added before staging

## Surviving critical remediation

### 1. Make the orchestration façade complete and semantic

1. **`code-reviewer-1`** — `engine/src/handlers/helpers/orchestration.ts:361`
   Claim: The orchestration facade cannot start Wave Gate, Standalone Review, or remediation programs.
   Fix: register typed start/resume adapters for Wave Gate, standalone review, and remediation alongside panel programs, using the existing machines/DAGs and durable run authority rather than caller-authored state.
   Validate: façade reachability tests for every registered program plus `cd engine && npm run typecheck`.

2. **`code-reviewer-2`** — `engine/src/handlers/helpers/orchestration.ts:233`
   Claim: Panel spawn contexts omit authoritative findings, candidates, interview, and manifest material.
   Fix: materialize role-specific immutable context packets from registered panel input and current artifacts; include exact finding/lens context for verifiers and interview/candidate/criterion context for designers and judges.
   Validate: context-packet golden/contract tests asserting complete role-specific sections and digest binding.

3. **`code-reviewer-3`** — `engine/src/handlers/helpers/orchestration.ts:480`
   Claim: Automatic harness capture leaves the panel pending and makes submit fail as a duplicate capture.
   Fix: make submit consume an already captured immutable transcript when present and advance the semantic machine exactly once; preserve exclusive capture and idempotent replay.
   Validate: integration test for reserve → automatic capture → resume/submit without duplicate capture.

4. **`code-reviewer-4`** — `engine/src/handlers/helpers/orchestration.ts:491`
   Claim: Arbitrary transcript bytes are treated as a successful semantic panel result.
   Fix: route captured bytes through the request-slot-specific candidate/judge/verdict parser before recording success; malformed output records a bounded failed attempt/retry outcome.
   Validate: malformed candidate, judge, and verifier transcript tests cannot advance to an engine operation.

5. **`code-reviewer-5`** — `engine/src/handlers/helpers/orchestration.ts:562`
   Claim: Caller-supplied success can complete aggregation/tally without evidence.
   Fix: execute registered deterministic engine operations internally and require their canonical artifact/receipt before appending success; remove caller self-certification for deterministic operations.
   Validate: garbage-result panel cannot reach `done`; successful aggregation/tally publishes and verifies canonical artifacts.

6. **`code-reviewer-6`** — `engine/src/handlers/helpers/orchestration.ts:219`
   Claim: Attempt-two requests reuse attempt-one request and reservation identities.
   Fix: derive request/effect authority from logical request plus semantic attempt while retaining a stable logical slot id.
   Validate: property/unit test proves request/effect ids differ by attempt and retry reservation succeeds.

### 2. Close harness evidence authority gaps

7. **`code-reviewer-7`** — `engine/src/orchestration/run-directory-handle.ts:700`
   Claim: A native harness id can be correlated to a request for a different Agent role.
   Fix: include observed Agent role and spawn receipt in correlator authority and verify both against the issued request during registration/capture.
   Validate: wrong-role correlator and capture tests fail closed for Pi and Claude.

8. **`code-reviewer-8`** — `engine/src/orchestration/harness-capture-runtime.ts:145`
   Claim: Evidence is accepted after immutable context deletion or tampering.
   Fix: read the reserved context through the run handle immediately before transcript publication and verify digest plus request identity.
   Validate: deleted, replaced, truncated, and cross-request context tests reject capture.

9. **`code-reviewer-9`** — `engine/src/handlers/subagent-stop/capture-orchestration-result.ts:60`
   Claim: Claude capture skips an invalid final record and salvages an earlier assistant message.
   Fix: parse the terminal transcript record strictly; malformed/ambiguous terminal records reject capture instead of scanning backward past them.
   Validate: truncated final JSONL and malformed final assistant cases return `no-final-payload`/rejection and never capture earlier text.

10. **`silent-failure-hunter-1`** — `pi/extension.ts:586`
    Claim: Pi request-bound captures are never correlated at spawn time.
    Fix: resolve each Loom-owned issued request in Pi `tool_call`, persist `piSpawnRosterId` through `recordHarnessCorrelator`, and reject/roll back the spawn batch if authority publication fails.
    Validate: Pi integration test covers tool_call → correlator artifact → tool_result → exact transcript capture.

11. **`silent-failure-hunter-2`** — `pi/extension.ts:1120`
    Claim: Standalone Pi results ignore failed request-bound capture outcomes.
    Fix: for a run-bound standalone result, require `captured`; surface `rejected`/missing reservation as a processing error while still avoiding task-state mutation.
    Validate: standalone Pi capture failure returns an error and leaves task state untouched.

12. **`architecture-tech-lead-1`** — `pi/extension.ts:586`
    Claim: Pi spawn tracking never records the durable correlator required by `capturePiSubagentResult`.
    Fix: satisfied by item 10; retain this duplicate source id in validation and traceability.
    Validate: same end-to-end Pi correlator/capture integration test.

### 3. Make run-directory concurrency and authority fail closed

13. **`code-reviewer-10`** — `engine/src/orchestration/no-follow-fs.ts:109`
    Claim: Stale-lock inspection removes a live lock and can admit concurrent appenders.
    Fix: replace rename-inspect-restore with an ownership protocol that never removes a lock before proving staleness; use exclusive claimant/recovery serialization and owner-token-checked release.
    Validate: concurrent live-owner/contender test proves no overlapping critical sections; stale-owner recovery remains bounded.

14. **`code-reviewer-11`** — `engine/src/orchestration/run-directory-handle.ts:829`
    Claim: Concurrent artifact publishers share a truncating `.staged` path.
    Fix: use publication-unique exclusive staging files under a destination/artifact-set lock, promote without replacement, and derive references from verified promoted bytes.
    Validate: high-contention publication test proves each successful receipt matches final bytes and no staging collision occurs.

15. **`silent-failure-hunter-3`** — `engine/src/orchestration/run-directory-handle.ts:383`
    Claim: Existing run authority is accepted without verification.
    Fix: on `EEXIST`, no-follow read and exactly parse existing authority; require canonical equality with the opened run id/root/directory. Strengthen `readRunAuthority` field validation.
    Validate: malformed, forged, and mismatched existing authority tests fail closed; identical reopen succeeds.

### 4. Preserve the Git index with real compare-and-swap behavior

16. **`code-reviewer-12`** — `engine/src/orchestration/git-remediation.ts:451`
    Claim: Concurrent staged work can be overwritten after the repository witness check.
    Fix: acquire Git's real index lock, recheck the index witness while holding it, build/install verified index bytes through the lockfile protocol, and atomically commit only if unchanged.
    Validate: deterministic concurrent `git add` test preserves unrelated staged work or rejects installation without mutation.

### 5. Stop silent proof and phase failures

17. **`silent-failure-hunter-4`** — `engine/src/utils/git.ts:149`
    Claim: Git tracking failures become false “new test” evidence.
    Fix: return a typed tracking result; only `ls-files --error-unmatch` exit 1 means untracked, while execution/repository/permission failures abort diff evidence collection.
    Validate: injected Git failure cannot produce untracked full-file evidence; genuine tracked/untracked cases remain correct.

18. **`silent-failure-hunter-5`** — `pi/extension.ts:1257`
    Claim: Pi phase-advancement update failures are swallowed.
    Fix: add update failures to `processingErrors` and return the existing caller-visible error response after cleanup.
    Validate: Pi phase update failure reports `isError: true` and leaves the previous durable phase intact.

### 6. Stabilize the canonical unit-test gate

19. **`pr-test-analyzer-1`** — `engine/package.json:8`
    Claim: the full `test:unit` command times out while targeted files pass.
    Fix: configure a realistic deterministic Vitest timeout for the full high-contention suite, without weakening assertions or excluding tests.
    Validate: run `cd engine && npm run test:unit` repeatedly and confirm all 3,868 tests pass.

### 7. Correct advisory-gate documentation

20. **`comment-analyzer-1`** — `README.md:287`
    Claim: “advisories do not block `/wave-gate`.”
    Fix: state that advisories bypass refutation but pause completion until accepted/deferred through advisory triage.
    Validate: prose contract tests and comparison with the Wave Gate state machine.

21. **`comment-analyzer-2`** — `commands/wave-gate.md:497`
    Claim: “advisory findings do not block advancement.”
    Fix: document the `awaiting-advisory-decision` gate and required disposition before advancement.
    Validate: runbook contract tests.

22. **`comment-analyzer-3`** — `commands/loom.md:518`
    Claim: “advisories do not block the gate.”
    Fix: align command documentation with explicit advisory triage before completion.
    Validate: runbook/prose contract tests.

23. **`comment-analyzer-4`** — no canonical file/line; claim names `README.md:287` and the advisory-triage contradiction.
    Fix: satisfied by item 20; retain this duplicate source id for audit.
    Validate: same README/prose contract validation.

24. **`comment-analyzer-5`** — no canonical file/line; claim names `commands/wave-gate.md:497` and the advisory-decision contradiction.
    Fix: satisfied by item 21; retain this duplicate source id for audit.
    Validate: same runbook contract validation.

25. **`comment-analyzer-6`** — no canonical file/line; claim names `commands/loom.md:518` and the advisory-decision contradiction.
    Fix: satisfied by item 22; retain this duplicate source id for audit.
    Validate: same runbook contract validation.

## Accepted advisories

26. **`silent-failure-hunter-6`** — `engine/src/orchestration/run-directory-handle.ts:650`
    Claim: malformed request authority files are silently skipped.
    Fix: make issued-request enumeration fail with the exact filename and read/parse diagnostic instead of omitting malformed authority.
    Validate: malformed/truncated/unreadable request artifact tests fail closed.

27. **`pr-test-analyzer-2`** — `engine/tests/orchestration/orchestration-acceptance.test.ts:183`
    Claim: the multi-block parity test exercises only Pi.
    Fix: exercise both Pi and Claude adapters with the same ambiguous multi-block payload and assert equivalent rejection semantics.
    Validate: targeted orchestration acceptance tests.

## Refuted Findings (not fixing)

None. The tally-authored `result.json` contains zero `refuted_critical_findings`.

## Validation commands

```bash
cd engine && npm run typecheck
cd engine && npm run test:unit
cd engine && npm run test:unit
cd engine && npm run test:smoke
git diff --check
```

Stage only audited remediation paths plus this plan, verify the staged set exactly, then commit and push without force.
