# PR Remediation Plan — Round 3 (review-and-fix, 2026-09-20)

**Branch:** `fix/abandoned-gate-terminal-outcome` (HEAD at review time: `5ddf4399`)
**Scope reviewed:** `all` — frozen diff `9eacc301..5ddf4399` (88 files: engine production + tests + pi extension)
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/review-fix-20260920T161059Z-5ddf4399`
**Canonical result digest:** `5f3ea6dc98479c62d12d59893ff174deab571417d5fa8b5e83fab5c0c2a11c90`
**Advisory policy publication:** Run Directory `.claude/reviews/review-and-fix-runs/policy-20260920T164550Z-5ddf4399-r2`, revision `{"kind":"initial"}`, disposition digest `60bbee55431080ed8a2f5fc88fc65fc1512e848c0df2e73a0e17c1b9f84bb3c7` (source locator, runId and resultDigest copied unchanged from `inspect --lineage`).
**Mis-publication note:** an earlier policy attempt (`policy-20260920T164505Z-5ddf4399`) published a stale foreign input by parent tooling error; it was abandoned via `helper orchestration abandon` with a durable reason naming this correction. It binds a foreign source and does not chain to this review's source.

## Surviving critical (1) — after Refutation Panel

Review emitted/admitted 1 critical and 19 advisory; after refutation 1 surviving critical, 0 refuted.

### `pr-test-analyzer-1` — disposition `repaired`

- **ID copied exactly once from canonical `result.json`:** `pr-test-analyzer-1` (pi/extension.ts:2725).
- **Claim:** the Pi-side TaskGraph Project Boundary settlement wiring has no discriminating test in the frozen scope; reverting it to the removed ambient fallback chain would leave every frozen-scope suite green.
- **Refutation panel:** 3/3 lenses (reproduction, intent, security) upheld — no frozen-scope test discriminates the wiring; the only inaccuracy was a spurious `pi/` path segment in a cited test path, which does not change the substance.

### Declared Repair Group `group.repair.pi-settlement-regression`

- **findingIds:** `["pr-test-analyzer-1"]`
- **Root cause (DECLARED):** the only wiring-level enforcement of the Pi settlement invariant (RepositoryProbe built solely from `observeTaskGraphProjectBoundary(mgr.getPath())` in the extension result dispatcher) is unobservable by the frozen suite: applier tests inject `repositoryAt` probes and the extension-level harness pins `LOOM_STATE_PATH` inside the ambient checkout, where both wirings resolve identically.
- **Invariant (DECLARED):** an extension-level implementation settlement whose TaskGraph lies OUTSIDE any Git repository must fail closed with the typed non-repository refusal ("repository probe reports a non-Git working directory"), never settle against the ambient checkout or cwd; a regression to the ambient fallback chain turns this assertion red.
- **Sibling disposition:** `{"kind":"none-declared","provenance":"DECLARED","reason":"No sibling implementation paths share this enforcement point: the extension builds RepositoryProbe in exactly one place (pi/extension.ts:2726), and the boundary observer itself is separately pinned by engine/tests/pi/phase-artifact-boundary.test.ts."}`
- **Selected check:** `project:verify` (root `project:verify` command, required report `.loom/completion-reports/verify.junit.xml`, Git-ignored untracked Vitest report; normal zero exit also proves compiler and all smokes pass).
- **Historical RED (DECLARED):** the new assertion — the extension-level settlement outcome reports the non-repository refusal and the Task stays unsettled — fails against the vulnerable behavior: with the wiring reverted to `git.repositoryRootFrom(dirname(statePath)) ?? git.repositoryRoot() ?? process.cwd()`, the probe resolves the ambient repo root, `isRepo()` becomes true, and the refusal never fires. Reference: refutation panel verdicts in the review run (all three uphold the revert-would-be-green claim).

**Fix:** extension-level regression test in `engine/tests/pi-extension-review-events.test.ts` (in frozen scope): re-point `LOOM_STATE_PATH` at a loadable TaskGraph in a canonical temp dir outside any Git repository, drive the real extension dispatcher (`tool_call` reservation → `tool_result` settlement with assistant text and no structured test evidence), and assert the outcome reports the non-repository refusal while the Task stays pending (no settlement, untrusted evidence). Restore env in `finally`.

## Implementation note (round 3, post-implementation)

All 15 accepted advisories were implemented and validated; the two advisory fixes below touched files OUTSIDE the frozen review scope, so both paths are declared in the remediation start input `supportPaths` (registered at start, per the immutable-input rule):

- `engine/src/core/orchestration-contract/index.ts` — type-design-analyzer-1 added the one-line `batchPublicationIdentity` re-export to the curated kernel facade.
- `engine/tests/core/context-packet-projection.test.ts` — type-design-analyzer-2's regression pin (the projection test file was not part of the frozen diff).

The third support path is this plan file itself. Full `supportPaths`:

```json
[
  ".claude/plans/2026-09-20-pr-remediation-round3.md",
  "engine/src/core/orchestration-contract/index.ts",
  "engine/tests/core/context-packet-projection.test.ts"
]
```

Development validation (not P3 evidence): `npm run verify` green — typecheck clean, full engine unit suite green, 23/23 smokes; fresh `.loom/completion-reports/verify.junit.xml` (Git-ignored, untracked). The registered remediation runner must observe the check freshly.

## Advisory dispositions (19) — published via standalone-disposition

Matching runtime verified for P5 publication: `standalone-disposition` is a registered START_PROGRAM of the loaded runtime (revision handshake passed for this session's protected mutations), so the Skill-6 immediate-publication path was used. 15 accepted, 4 deferred, 0 dismissed. Complete ordered inventory (all 19 origins, issued order) is in the published record; the disposition digest above is authoritative.

### Accepted (15) — implemented this round

| ID | Fix |
| --- | --- |
| `code-reviewer-1` | `deriveImplementationRetryDisposition` refuses a protocol-2 predecessor seed on an empty attempt history (same invariant as the non-empty walk); regression pin in `engine/tests/core/implementation-retry.test.ts`. |
| `silent-failure-hunter-1` | `repair-task-graph.ts` pre-check uses `probePathFailClosed` (ENOENT-only-absent) instead of bare `existsSync`. |
| `pr-test-analyzer-2` | Three kill-mock tests pin the parent-close containment diagnostic kinds: initial probe error → termination-unconfirmed; wait expiry with surviving descendants → termination-unconfirmed ("post-close signalling was refused"); settled-probe error → termination-unconfirmed. |
| `pr-test-analyzer-3` | Parametrized refusal sweep for `parseTaskReasonArguments` through both operations (attest: missing --task, over-length --reason, duplicate --reason, non-conforming task id; remediate: missing --task, duplicate --receipt, duplicate --reason, over-length reason, non-conforming task id). |
| `pr-test-analyzer-4` | Assertion for the `registration-absent` arm of `abandonActiveWaveGateRegistration` in `engine/tests/state-manager.test.ts`. |
| `type-design-analyzer-1` | New `durablePublishedReceipt` accessor (validated `parseBatchPublishedReceipt` output) in helpers; `durablePublicationDigest` delegates to it; the resume missing-slots path carries the proven digest and parsed receipt — no second raw re-read. |
| `type-design-analyzer-2` | `sectionText` decides JSON shape by parse outcome (tagged try/catch): non-JSON text starting with `{`/`[` projects verbatim; genuine decode failures keep the typed diagnostic. |
| `comment-analyzer-1` | `findTaskGraphPath` comment rewritten to the actual rule: the return is relative whenever the resolved graph sits under cwd, whichever loop found it; absolute otherwise. |
| `comment-analyzer-2` | `no-cross-boundary-imports.ts` per-file block documents deliberate cross-branch pre-provisioning: absent-file entries are inert here and must not be pruned while the feature branch relies on them. |
| `architecture-tech-lead-3` | Attest and remediation shells extract outputs via `updateAndReturn` (lock-time committed decision) instead of mutating closure locals inside `update` callbacks. |
| `code-simplifier-1` | One named drift-kind predicate beside the `proofFailureKind` vocabulary (proof-obligations.ts) consumed by both the attestation-drift matcher and the escalation message selector. |
| `code-simplifier-2` | Dead export `projectRootForTaskGraph` deleted (zero references verified). |
| `code-simplifier-3` | Shared confirmed-empty passthrough adapter beside `observeGitProbe` in `utils/git-probe.ts`; `runGitProbingEmpty` and workspace-digest `runGit` delegate to it. |
| `code-simplifier-4` | Local `requireNonEmptyGitOutput` guard in `git-remediation.ts` states the emptiness refusal once, preserving exact evaluation order and exact failure messages. |
| `code-simplifier-6` | Canonical transient empty-stdout rationale lives at `observeGitProbe`; the three site comments (git-remediation, git.ts, config.ts) become one-line pointers with site-specific facts. |

### Deferred (4) — evidence-based, published in the record

| ID | Reason |
| --- | --- |
| `architecture-tech-lead-1` | Multi-site equality refactor across successor-lineage and attempt-2-compatibility paths; all live sites digest-verify or round-trip before comparing (no wrong answer today); belongs to a dedicated deepen pass. |
| `architecture-tech-lead-2` | Confirmed-empty observation reshape ripples through the three consumers the retry-policy change just touched; interface redesign for a dedicated pass. |
| `code-simplifier-5` | Exported-type surface reduction of ImmutableByteSequence is a type-shape change the reviewer routes to deepen; no production behavior misled today. |
| `code-simplifier-7` | Shared byte-grammar validator adds a packet-core export (seam addition routed to deepen); duplication is latent-only. |

## Refuted-finding audit

None: 0 refuted critical findings. No refuted Finding is repaired, and no refuted ID appears in `defectFamily`.

## Remediation inputs

- **sourceRunsRoot:** `.claude/reviews/review-and-fix-runs`
- **sourceRun:** `review-fix-20260920T161059Z-5ddf4399`
- **supportPaths:** `[".claude/plans/2026-09-20-pr-remediation-round3.md"]` (plan file; every code/test edit target is inside the frozen review scope — verified against `git diff --name-only 9eacc301..5ddf4399`)
- **defectFamily:** declared accounting for `pr-test-analyzer-1` → `group.repair.pi-settlement-regression` with check `project:verify`.

## Validation

- Development: `npm run verify` (typecheck + full engine unit suite + smokes) iterated to green.
- Registered: the remediation runner freshly observes `project:verify` with required report `.loom/completion-reports/verify.junit.xml` (Vitest JUnit; the runner deletes the old report through the retained Linux parent descriptor before launch).

## DECLARED vs ENGINE_OBSERVED

Root cause, invariant, sibling accounting, and Historical RED above are DECLARED. Only the remediation runner's fresh structured observation of `project:verify` is ENGINE_OBSERVED. The bounded result is `repair-checked`, not proven closure.
