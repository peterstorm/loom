# PR Remediation — 2026-08-18

**Branch:** `feat/architecture-panel-mode-plan`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/run.raf20260818a`
**Scope:** frozen standalone-review scope, 444 files (full branch vs `main`), `kind: all`
**Reviewers:** 7 (code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer,
comment-analyzer, architecture-tech-lead, code-simplifier)
**Refutation Panel:** 3 lenses (`reproduction`, `intent`, `blast-radius`), threshold 2

**Adjudication:** 10 critical claims → **7 surviving**, **3 refuted**. 89 advisories.

---

## 1. Surviving critical findings — all mandatory

### C1 + C2 (same defect, two reviewer ids) — `exhaustive-discriminant-branching` false positive
`code-reviewer-1`, `code-reviewer-3` — `engine/src/linter/programmatic/exhaustive-discriminant-branching.ts:70`
Upheld 3/3 by all lenses.

`CHAIN_BRANCH`'s second alternative `\b(?:return|throw|continue|break)\b` is unanchored and has no
chain-continuity check, so three standalone guards in three *different* sibling functions, each
exiting with `return`/`throw`/`continue`/`break` within `MAX_CHAIN_GAP`, are credited as one
discriminant chain and reported. This is precisely the false positive the file's own docstring
(lines 60-69) and branch-HEAD commit `53001fd` claim was fixed — it was only fixed for guards whose
body is a side-effecting call.

**Fix:** a run of branches ends when a line closes the enclosing block at an indentation strictly
less than the branch indentation. A real `if`/`else if` chain and a fall-through chain of returns are
contiguous at one indentation; crossing a function boundary always dedents through a closing brace.
This is the principled invariant the `MAX_CHAIN_GAP` heuristic was approximating.

### C3 — linter config silently drops two documented fields
`silent-failure-hunter-1` — `engine/src/linter/programmatic/config.ts:70` — upheld 3/3.

`ProgrammaticConfig` declares and documents `maxDiscriminantBranches` and `discriminantTags`, and
`programmatic/index.ts:83-84` consumes them, but `parseConfig` never reads either key. A project that
sets them gets the defaults with no throw and no log, against the module's own documented fail-closed
contract.

**Fix:** validate-and-assign both fields in `parseConfig`, mirroring the `maxFunctionLines` /
`pureModules` branches, throwing on a bad value.

### C4 — no regression test for the whitespace-only block-cause rule
`pr-test-analyzer-1` — `engine/src/core/wave-gate-model.ts:122` — upheld 3/3.

Verified: zero references to `waveHasBlockCause` / `reconcileWaveBlock` anywhere in `engine/tests`,
despite 5 production call sites (`state-manager.ts:198`, `store-review-findings.ts:217`,
`review-panel.ts:322`, `store-spec-check-findings.ts:81`, `wave-gate-machine.ts:688`) and a doc
comment recording the whitespace-only finding as a previously shipped silent bug.

**Fix:** new `engine/tests/core/wave-gate-model.test.ts` pinning both directions of the whitespace
filter, the spec-check cause, and `reconcileWaveBlock`'s referential-identity no-op contract.

### C5 — `recoverViewOnlyClaims` caller count is wrong
`comment-analyzer-1` — `engine/src/handlers/helpers/store-review-findings.ts:79` — upheld 3/3.

Verified four production callers: `findings.ts:1374` (`mergeFindings`), `validate-task-graph.ts:375`
(`--fix`), `store-review-findings.ts:85`, and `findings.ts:1125` (`reviewRunPriorFindings`, reached
from `review-packet.ts:138`). The comment says "third caller". The comment exists to assure a reader
that every consumer agrees on one rule; an undercount defeats it.

**Fix:** drop the ordinal and name the callers, including `reviewRunPriorFindings`.

### C6 — `engine/src/core/` imports the imperative shell
`architecture-tech-lead-1` — `engine/src/core/block-direct-edits.ts:11` — upheld 3/3.

`import { readActiveAgentRoles } from "../machine/ledger"` — `machine/ledger` is the fs shell and is
denied by omission from `core/`'s fail-closed allowlist. **Reproduced mechanically:** running the
project's own `checkBoundaryViolation` over the real tree reports it.

**Fix:** inject the roster read as a port with a default that wraps today's
`existsSync`/`statSync`/`readActiveAgentRoles` sequence verbatim — the pattern `taskGraphExists`,
`SpawnAdmissionPorts` and `ArtifactProbe` already use. `core/` then drops its only edge into the
shell, and `block-direct-edits.ts` drops its `perFileAllow: ["node:fs"]` entry.

### C7 — the boundary rule is never run against the tree it protects
`architecture-tech-lead-2` — `engine/src/linter/programmatic/no-cross-boundary-imports.ts` — upheld 3/3.

`no-cross-boundary-imports.test.ts` feeds only synthetic inline strings. Nothing walks `engine/src`.
**Reproduced:** a 15-line walk over 169 real files reports **3 live violations** — C6, plus
`engine/src/orchestration/session-run-bindings.ts:4,17` importing `../machine/evidence`, a genuinely
pure module absent from `orchestration/`'s allowlist.

**Fix:** an acceptance test that walks the real `engine/src` tree and asserts zero violations, plus
adding `engine/src/machine/evidence` to the `orchestration/` allow list (pure, already sanctioned for
`core/`). C6's fix removes the other violation.

---

## 2. Refuted critical findings — audited, never fixed

| Finding | Claim | Panel |
|---|---|---|
| `pr-test-analyzer-2` — `engine/src/machine/evidence.ts:80` | No test drives `parseReportedAgentId`/`parseGrantedAgentId` with a self-reported `pi-grant-` id to prove producer-side spoofing rejection. | **Refuted 2/3** (`reproduction`, `blast-radius`; `intent` upheld). `engine/tests/machine/handlers-e2e.test.ts:147-174` — "a self-reported agent_id in the write-grant namespace never reaches the roster" — drives `pi-grant-0123456789abcdef` through the real SubagentStart handler (`mark-subagent-active.ts:78` → `parseReportedAgentId`) and asserts the refusal stderr, that no roster entry equals the forged id, and that every roster id is an `unparseable-` placeholder. The test the finding says is missing already exists. |
| `code-simplifier-1` — `engine/src/handlers/subagent-stop/update-task-status.ts:98` | The Vitest branch of `extractTestEvidence` accepts a pass when a nonzero failure count precedes it, because it omits the `=== "0"` check its Mocha/cargo/pytest/Bun siblings apply. | **Refuted 3/3.** The cause is inverted. `=== "0"` is a *disjunct* in `if (!fail \|\| fail[1] === "0" \|\| fail.index < pass.index)`, so omitting it makes Vitest **stricter**, not more permissive. Acceptance of a preceding nonzero failure comes from `fail.index < pass.index`, which Vitest *does* implement at line 101 identically to every sibling (92, 110, 122, 133) and which the Mocha comment documents as deliberate. |
| `code-simplifier-67` — duplicate of `code-simplifier-1` | Same claim. | **Refuted 3/3**, same evidence. |

---

## 3. Advisory dispositions

89 advisories. **9 accepted, 9 dismissed as exact duplicates, 71 deferred.**

### Accepted (9)

| ID | Site | Reason |
|---|---|---|
| `code-reviewer-2` | `engine/tests/linter/programmatic/style-rules.test.ts:172` | No regression test for a return-bodied sibling guard — the exact gap that let C1 ship. Pins C1's fix. |
| `pr-test-analyzer-3` | `exhaustive-discriminant-branching.ts:70` | `CHAIN_BRANCH` also scans the `if (…)` condition, so a discriminant literal like `"break-glass"` is false chain evidence. Same regex as C1; belongs in the same edit. |
| `pr-test-analyzer-4` | `pi/write-grant.ts:300` | Documented fail-closed errno handling on a security-critical path with no test. A real symlink loop reproduces `ELOOP` without mocks; the file's test already imports `symlinkSync`. |
| `pr-test-analyzer-5` | `engine/src/handlers/subagent-stop/dispatch.ts:128,163,166` | Three diagnostics this branch added *for observability* are unexercised, so a refactor could silently delete them. `dispatch-resilience.test.ts` already has the stderr-spy scaffolding. |
| `comment-analyzer-2` | `no-nested-ternary.ts:34` | Comment claims `ELSE_BRANCH` excludes `::` and type annotations; `/^\s*:\s*\S/` does neither — the type exclusion is the downstream `TYPE_LEVEL` check. |
| `comment-analyzer-3` | `prefer-array-methods.ts:30` | "WHAT THIS DOES NOT FLAG" omits `yield`, which `DISQUALIFYING` also exempts. |
| `type-design-analyzer-1` | `orchestration-contract/artifacts.ts:38` + siblings | The as-const allow-lists are the only arrays in these modules not frozen at construction; one-line fix restoring the module's own convention. |
| `code-simplifier-2` | `engine/src/core/findings.ts:349` | Section divider with no code beneath it — misleads the reader about where the section is. |
| `code-simplifier-39` | `engine/src/state-manager.ts:841` | Unreachable `return null` after an unconditional return — dead code. |

### Dismissed as exact duplicates (9)
`code-reviewer-4` (dup of `code-reviewer-2`); `code-simplifier-68/69/70/71/72/73/74/75` (dups of
`code-simplifier-2/5/10/22/23/34/51/56`). These are the same claims re-emitted in the reviewer's
attempt-2 payload. Reported once; `-68`'s original is accepted above.

### Deferred (71) — with reasons

- **Type branding / interface changes (5)** — `type-design-analyzer-2..6`: `ImmutableMap` reflection
  bypass, panel-authority nominal brands, `ReviewPacket` path branding, `BriefFinding` location
  collapse, `StandaloneReviewerEvidence` id branding. Each changes an exported type and its call
  sites. The reviewer itself found **zero constructible illegal states reachable through normal typed
  code** for all five, and explicitly recorded the `ImmutableMap` case as a known accepted residual.
  These are `deepen` work with their own review, not remediation riders.
- **Larger test suites / reviewer-acknowledged low value (3)** — `pr-test-analyzer-6` (`legacy-archive.ts`
  has indirect handler coverage; a direct 662-line suite is its own work item), `-7` (reviewer: "
  diagnostic-only and low value to trigger"), `-8` (reviewer: the existing 6-process concurrency test
  is "a strong real-world proxy").
- **Production duplication / DRY (≈33)** — `code-simplifier-3..38, 40..43`: repeated envelope checks,
  Set-size uniqueness tests, exclusive-write idioms, per-handler stdin boilerplate, nested ternaries.
  Real, but each is a signature- or module-boundary-touching extraction across load-bearing
  orchestration and contract code; the reviewer flagged `resumeWaveGateFacade` explicitly as "risky
  to extract given load-bearing ordering, recommend one-phase-at-a-time with tests between each".
  Batching ~33 of these into a commit alongside 7 critical fixes would make the diff unreviewable and
  couple unrelated regression risk. Deferred to a dedicated `distill` apply-mode pass.
- **Test-file duplication (≈23)** — `code-simplifier-44..66`: repeated fixtures and scaffolding across
  test files. Zero production risk; churning 4603 currently-passing tests inside a remediation commit
  trades real regression risk for tidiness. Deferred to the same `distill` pass.
- **Empty section divider / misc already covered** — remaining `code-simplifier` items whose fix is
  subsumed by an accepted item.

---

## 4. Validation

```bash
cd engine && npm run typecheck     # tsc --noEmit + no-unused pass
cd engine && npm run test:unit     # vitest, full suite
```

Baseline before any edit: **178 test files, 4603 tests passing; typecheck clean.**
Both must still pass, with the new tests added, before anything is staged.

Additional proof for C6/C7: the boundary walk that reproduced the violations must report **0**.

## 5. Support paths

Four touched paths fall outside the frozen 444-file reviewed scope and are registered as support
paths in the remediation start input. Every other changed path is in scope.

| Path | Why it is outside the reviewed scope |
|---|---|
| `.claude/plans/2026-08-18-pr-remediation.md` | This plan. |
| `engine/tests/core/wave-gate-model.test.ts` | New regression file — C4's fix. |
| `engine/tests/linter/programmatic/no-cross-boundary-imports.acceptance.test.ts` | New regression file — C7's fix. |
| `engine/src/handlers/pre-tool-use/block-direct-edits.ts` | Unchanged on this branch, so never entered the diff-derived scope. C6 moves the roster I/O out of `core/` and into this shell wrapper, which is the only place it can legally live. |
