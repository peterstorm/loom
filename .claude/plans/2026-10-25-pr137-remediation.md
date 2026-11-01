# PR 137 remediation: G5b orchestration engine gaps

Branch `fix/g5b-engine-gaps`, reviewed head `90a6ea6b`. The frozen diff against `origin/main` is 353 KB, over one reviewer's budget, so it was reviewed as three themed slices that cover all 75 changed files exactly once. Each slice was reviewed by 7 reviewers under `.claude/reviews/review-and-fix-runs`.

| Slice | Review run | Emitted/admitted | After refutation | Policy run | Disposition digest |
|---|---|---|---|---|---|
| s1 freeze + reopen | `pr137-s1-90a6ea6b` | 0 critical, 10 advisory | 0 surviving, 0 refuted | `pr137-policy-s1-90a6ea6b` | `92f5b202` |
| s2 I7 + guard + ts-pattern | `pr137-s2-90a6ea6b` | 1 critical, 8 advisory | 1 surviving (panel 3/3 upheld), 0 refuted | `pr137-policy-s2-90a6ea6b` | `40eb0a01` |
| s3 roster + shared docs | `pr137-s3-90a6ea6b` | 0 critical, 9 advisory | 0 surviving, 0 refuted | `pr137-policy-s3-90a6ea6b` | `9030c679` |

All advisory dispositions are `DECLARED`, published as initial P5 revisions; the exact reasons live in each policy run's `artifacts/disposition.json`.

## Surviving critical (s2)

**`code-reviewer-1`** — status `repaired`, Declared Repair Group `group.protected-dirs-outside-allow`.

- **Finding.** The new `placeEdit().kind === "outside"` early allow in `shouldBlockDirectEdit` lets the parent Edit/Write/MultiEdit the protected subagent directory and the machine-definitions directory:
  - the subagent directory holds the evidence ledger, the `.active` roster, `.machine` bindings and task-graph pointers;
  - both directories sit outside the Orchestrated Repository by default;
  - no file-tool guard covers them, because `guard-state-file` is matched to Bash only, on both Claude and Pi.
- **Root cause (DECLARED).** ADR-0046 reasoned that a write outside the repository cannot reach the orchestration. Loom's own protected directories (`protectedDirs()` in `engine/src/config.ts`) are exactly such writes that can. Placement was decided without consulting them.
- **Invariant (DECLARED).** A file-tool write by the parent into any protected Loom directory is refused while a graph is armed, wherever that directory lies relative to the Orchestrated Repository. "Outside" placement may only allow targets that are outside the repository and outside every protected directory.
- **Siblings (DECLARED).** The Pi `tool_call` guard calls the same core `shouldBlockDirectEdit` with its own `placeEdit`, and the Pi scoped-grant confinement also consults placement. Both are repaired by the same core rule plus a Pi test. No other file-tool allow path consults placement.
- **Selected check.** `project:verify`.
- **Historical RED (DECLARED).** A new regression test fails on the reviewed head: with a graph armed and a parent `Write` to `<subagentDir>/<session>.evidence.jsonl` or into `machinesDir()`, the reviewed core returns `allow`.

## Advisory dispositions (27: 22 accepted, 1 deferred, 4 dismissed)

### Deferred
- s2 `architecture-tech-lead-2`: a shared Pi placement resolver behind a port, with scoped-grant confinement folded into core. This restructures the Pi extension seam beyond this fix. Filed as #138.

### Dismissed
- s1 `architecture-tech-lead-3`: replay detection gives an identical outcome either way, so recording `review_generation` in the audit would add wire state with no behavioral consequence.
- s2 `comment-analyzer-1`: false against the PR. `docs/operations.md` is in slice s3's scope; line 1231 already carries the Orchestrated Repository rule, and line 946 documents the expected-RED excuse.
- s3 `pr-test-analyzer-2`: the lifecycle-contract tests check schema-1 agent files, and schema 1 never issues `architecture-tech-lead`.

### Accepted, by implementation group

**A — guard (s2): the critical repair plus guard advisories**
- Protected directories are always guarded; Claude and Pi parity; regression tests (critical).
- `shouldBlockDirectEdit` optional ports become one options object, removing Pi's `undefined, undefined` fillers (atl-1, cs-1).
- A valid Pi pointer to a second repository is guarded (pta-1).
- `orchestratedRepositoryOf` and ADR-0046 announcement wording narrowed to failures that have a cause (ca-2).

**B — I7 (s2)**
- One shared classify-a-failed-testcase function (attribution, collection error, verdict) used by the gate and I7, with one rendered file identity (atl-3).
- Single-pass blocking/excused partition (cs-2).

**C — freeze and reopen (s1)**
- Tests:
  - population drops `task_reopening_history` (pta-1);
  - spec-check authority presence (pta-1);
  - unresolvable-repository freeze refusal (pta-2);
  - observe-before-readiness order (pta-2);
  - completed-replay six-reviewer roster (pta-3).
- `TaskReopeningAudit.reopenedTaskIds` becomes `NonEmpty` (type-1); `abandonedRunId` doc corrected (ca-1).
- Frozen-path observation moves into the readiness snapshot; `commitWaveGateCompletion` back to one argument (atl-1).
- One shared pure Wave-reopening precondition for Contract Revision and Task Reopening, with typed refusal and no throw in the core (atl-2).
- Explicit `--wave`/`--reason` branches (cs-1); the operator procedure lives once in `commands/wave-gate.md` (cs-2).

**D — roster (s3)**
- Issuance derives rosters through `waveTaskReviewRoster(s)` (type-1, atl-1, cs-2).
- One pure `waveRunRosterProblem` used by membership, restart, install and retries (atl-2, cs-1).
- Owner-mapped restart and membership tests (pta-1); comment fixes (ca-1, ca-2).

## Validation
- `bun engine/scripts/typecheck.ts`, targeted vitest per group, full-tier lint (`bun scripts/lint-project.ts`, baseline 77 violations as on `main`), then root `npm run verify`.
- Registered remediation: one schema-v2 run against `pr137-s2-90a6ea6b` with the declared accounting above, check `project:verify`, and every touched path outside s2's frozen scope named in `supportPaths`. Separate `not-required` runs against `pr137-s1-90a6ea6b` and `pr137-s3-90a6ea6b` are not needed: one installation covers the whole candidate. Commit and push after the engine installs the verified index.
