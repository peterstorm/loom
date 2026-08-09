# Adjudicated PR Remediation — Round 32 (2026-08-09)

## Review authority

- **Branch:** `feat/architecture-panel-mode-plan`
- **Standalone run:** `.claude/reviews/review-and-fix-runs/run.qNngILS5qG`
- **Exact frozen scope:** the complete 249-path `result.json.scope` array in that run (the immutable sorted union of `main...HEAD`, staged, and unstaged changed paths)
- **Diff reviewed:** 47,174 additions, 3,058 deletions; 154 TypeScript, 84 Markdown, 5 shell, 4 JSON, and 2 `.gitignore` paths
- **Panel:** `reproduction`, `intent`, `security`; strict-majority threshold 2
- **Adjudication:** 5 canonical criticals → 5 surviving, 0 refuted; 3 advisories accepted

## Remediation order

### 1. Anchor standalone review directories and authority publication

- **Sources:**
  - `code-reviewer-1` (`code-reviewer`), `engine/src/handlers/helpers/standalone-review.ts:368`
  - `code-reviewer-2` (`code-reviewer`), `engine/src/handlers/helpers/standalone-review.ts:197`
  - accepted advisory `architecture-tech-lead-1` (`architecture-tech-lead`), `engine/src/handlers/helpers/standalone-review.ts:197`
- **Claims:** a pre-existing `reviewers` symlink is accepted; standalone `session.json`, `aggregate.json`, and clean-run `result.json` publication returns to path-string writes after anchored preflight.
- **Minimal fix:** create/validate `reviewers` through the existing anchored directory boundary; publish standalone authority files with descriptor-anchored exclusive writes, anchored staged reads, anchored cleanup, and `publishStagedRunFile`.
- **Regression tests:** reject a symlinked `reviewers` directory without publishing `session.json`; exercise standalone init/aggregate/finalize through the hardened helpers while retaining immutable staged-publication behavior.
- **Validation:** `cd engine && bunx vitest run tests/handlers/helpers/standalone-review.test.ts tests/core/round15.test.ts`

### 2. Anchor surplus-item cleanup

- **Source:** `code-reviewer-3` (`code-reviewer`), `engine/src/handlers/helpers/panel-run.ts:482`
- **Claim:** `pruneSurplusItems` lists, checks, and unlinks through replaceable path strings, so an item-directory swap can target an outside same-named file.
- **Minimal fix:** retain a no-follow descriptor for the item directory and perform listing, shape inspection, and unlink through `/proc/self/fd/<fd>`; close the descriptor on every path.
- **Regression test:** replace the item directory with a symlink to an outside directory and prove cleanup fails while its sentinel remains intact.
- **Validation:** `cd engine && bunx vitest run tests/core/round15.test.ts`

### 3. Reject surplus Pi lifecycle results

- **Source:** `silent-failure-hunter-1` (`silent-failure-hunter`), `pi/extension.ts:1004`
- **Claim:** when a reservation exists, result entries past `reservation.items.length` fall into the legacy unreserved compatibility path and can mutate lifecycle state.
- **Minimal fix:** report surplus cardinality as an evidence-processing error and process only the reservation-sized prefix; preserve compatibility behavior only when no reservation exists.
- **Regression test:** return one authorized reviewer result plus one surplus reviewer result and prove only the reserved evidence is stored while the tool result reports the rejected surplus.
- **Validation:** `cd engine && bunx vitest run tests/pi-extension-review-events.test.ts`

### 4. Parse task spec anchors at both graph boundaries

- **Source:** `type-design-analyzer-1` (`type-design-analyzer`), `engine/src/handlers/helpers/validate-task-graph.ts:236`
- **Claim:** `spec_anchors` is accepted as any array, allowing agent-controlled non-strings to inhabit `Task.spec_anchors: readonly string[]`.
- **Minimal fix:** require every present anchor to be a non-empty string in both decompose validation and `taskUnionError`, keeping persisted and pre-sanitization boundaries in lockstep.
- **Regression tests:** reject non-string and blank anchors from decompose payloads and persisted task graphs.
- **Validation:** `cd engine && bunx vitest run tests/handlers/validate-task-graph.test.ts tests/state-manager.test.ts tests/handlers/populate-task-graph.test.ts`

### 5. Enforce dependency-graph invariants at persistence

- **Source:** accepted advisory `type-design-analyzer-2` (`type-design-analyzer`), `engine/src/state-manager.ts:160`
- **Claim:** `parseTaskGraph` accepts self, unknown, and same/later-wave dependencies that operator validation rejects.
- **Minimal fix:** extract one pure dependency-invariant parser and call it from both `parseTaskGraph` and `validateFull`, preserving one answer for dependency existence and earlier-wave ordering.
- **Regression tests:** prove load/persist and operator-validation boundaries reject self, missing, same-wave, and later-wave dependencies and accept valid earlier-wave dependencies.
- **Validation:** `cd engine && bunx vitest run tests/state-manager.test.ts tests/handlers/validate-task-graph.test.ts`

### 6. Diagnose supplied transcript-path failures

- **Source:** accepted advisory `silent-failure-hunter-2` (`silent-failure-hunter`), `engine/src/utils/agent-transcript-path.ts:136`
- **Claim:** a supplied but unavailable transcript path silently degrades to derived lookup, hiding the trusted path failure.
- **Minimal fix:** inspect a supplied path with an error-reporting filesystem operation, retain existing supplied-path precedence and derivation fallback, and emit a path-specific fallback diagnostic on failure.
- **Regression test:** supply a missing path alongside a valid derived transcript and assert both successful fallback and the concrete diagnostic.
- **Validation:** `cd engine && bunx vitest run tests/utils/agent-transcript-path.test.ts tests/handlers/subagent-stop/store-reviewer-findings.test.ts`

## Refuted Findings (not fixing)

None. The panel refuted 0 critical findings. All five criticals survived; the security lens was uncertain only for `silent-failure-hunter-1` and `type-design-analyzer-1`, while reproduction and intent upheld both.

## Accepted advisories

All three advisories are accepted. `architecture-tech-lead-1` is remediated by the same anchored-publication change as surviving critical `code-reviewer-2`; `type-design-analyzer-2` and `silent-failure-hunter-2` receive dedicated fixes above. Deferred advisories: 0.

## Project validation

```bash
cd engine && bun run typecheck
cd engine && bun run test:unit
cd engine && bun run test:smoke
```

Only the exact audited remediation path set plus this plan may be staged. Run artifacts under `.claude/reviews/review-and-fix-runs/` must remain untracked/ignored.
