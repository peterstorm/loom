# PR Remediation — Standalone Review `run.tx8nrM9gms`

- **Branch:** `feat/architecture-panel-mode-plan`
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/run.tx8nrM9gms`
- **Scope:** the frozen 370-path branch scope (engine, pi, agents, docs, scripts, plans)
- **Reviewers:** code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead
- **Refutation Panel:** lenses `reproduction`, `intent`, `security`; threshold 2-of-3
- **Adjudication:** 28 critical findings raised → **0 refuted**, **28 surviving**; 43 advisory findings

No critical finding drew two refutations, so `result.json` carries an empty
`refuted_critical_findings` set. Every dissenting single-lens vote is recorded
in the audit section below and none of them excuses a fix.

---

## Refuted-finding audit

`result.json.refuted_critical_findings` is **empty** — nothing was refuted by
the panel. Five findings attracted exactly one refuting vote each and therefore
survived; they are still mandatory, but the dissent shapes the fix:

| Finding | Refuting lens | Dissent | Effect on the fix |
|---|---|---|---|
| `pr-test-analyzer-7` (`isPristine` untested) | reproduction | `orchestration.test.ts:1908` exercises it end-to-end via the recover-orphan CLI (`must be pristine`) | Fix adds a **direct** unit test rather than assuming zero coverage |
| `type-design-analyzer-2` / `-9` (Task fields not `readonly`) | reproduction | `parseTaskGraph` freezes every task, so an in-place write throws rather than landing silently | Fix is the compile-time `readonly` gap only; runtime freeze already holds and stays |
| `type-design-analyzer-3` / `-10` (contradictory WaveGate) | intent | `blocked` is an intended orthogonal veto that legitimately coexists with `impl_complete`/`reviews_complete` | Fix does **not** reject `blocked + complete`. It proves the invariant the engine really holds: `blocked: true` must have a cause |

---

## Surviving critical findings — 28 ids, 19 distinct defects

### C1 — `guard-state-file.ts:1842` fail-open state-file guard
*(ids: `code-reviewer-1`, `code-reviewer-6`, `silent-failure-hunter-2`, `silent-failure-hunter-8`)*

`guardStateFile()` gates on bare `existsSync(TASK_GRAPH_PATH)`, which returns
`false` for EACCES/ELOOP/ENOTDIR/EIO, so an unreadable graph disarms the guard.

**Fix:** take an injectable `taskGraphExists` probe defaulting to
`pathExistsFailClosed(TASK_GRAPH_PATH)`, mirroring `block-direct-edits.ts`.

### C2 — `validate-template-substitution.ts:40` fail-open template guard
*(ids: `silent-failure-hunter-1`, `silent-failure-hunter-7`)*

Same bare-`existsSync` disarm on the unsubstituted-placeholder guard.

**Fix:** injectable probe defaulting to `pathExistsFailClosed(taskGraphPath())`.

### C3 — `validate-agent-model.ts:209` unanchored engine-authority rescue
*(ids: `code-reviewer-2`, `code-reviewer-7`)*

`spawnModelIsEngineAuthorized()` derives a run directory from the spawn
prompt's own `LOOM_CONTEXT_PATH` with no anchoring, then trusts any
self-consistent authority JSON found under it — so a forged authority at an
attacker-writable path proves an arbitrary model.

**Fix:** a new pure core parser `anchoredRunDirectoryFromContextPath(repoRoot,
contextPath)` that accepts a run directory only when it is
(a) lexically inside the repository (`parseRepositoryPath`),
(b) a direct child of a canonical run-layout root (`panel-runs`,
`review-runs`, `review-and-fix-runs`, `wave-gate-runs`, `orchestration-runs`)
under `.claude/`, and
(c) a valid Run Directory reference (`parseRunDirectoryReference`).
The run-layout component set moves to one shared exported constant so
`remediation-machine` and the gate cannot drift.

### C4 — `pi/write-grant.ts:68` consume-time schema-drift rejection untested
**Fix:** test writing a `version: 0` (and a shape-broken) stored grant, then
asserting `consumePiWriteGrant` throws `write grant is malformed` **and** burns
the record.

### C5 — `pi/extension.ts:1060` guard-crash fail-closed catch untested
**Fix:** force a guard to throw (unreadable/poisoned task-graph path) inside a
`tool_call` and assert `{ block: true }` carrying `crashed (failing closed)`.

### C6 — `pi/extension.ts:707` scoped-grant write-target verification untested
**Fix:** direct tests for `piWriteTargetPaths` (unrecognized shape → `[]`,
`edits` array → deduped multi-target) plus an extension-level test that a
scoped grant blocks an unverifiable target and blocks an out-of-scope member of
a multi-target `multi_edit`.

### C7 — `pi/extension.ts:885` spawn-integrity refusals untested
**Fix:** tests for the invalid-session-id refusal and the duplicate-`toolCallId`
refusal.

### C8 — `remediation-operations.ts:169` success/install DAG path untested
**Fix:** drive the audit + staged-set nodes to their **audited** arm and assert
the conditional edge reaches `EMIT_INTENT`.

### C9 — `git-remediation.ts:228` `observeStagedPaths` untested
**Fix:** real-repo tests: clean index → `[]`; staged add/modify → sorted paths;
staged rename → both halves; path containing a newline survives `-z` intact.

### C10 — `run-directory-handle.ts:858` `isPristine()` untested
**Fix:** direct tests — fresh run → `true`; stray root entry → `false`; stray
file inside a fixed subdirectory → `false`; `requests/correlators` allowed;
unreadable directory → typed failure.

### C11 — `effect-runner.ts:122` reserve partial-failure untested
**Fix:** drive `reserve-agent-requests` with a second request that fails after
the first was already reserved; assert the typed failure and that the first
reservation is still on disk (documented no-rollback semantics).

### C12 — `guard-state-file.ts:875` `busyboxExecutesStdin` untested
**Fix:** guard-decision tests for `busybox sh <<EOF`, `busybox ash`, `busybox`
alone (all script → block on a guarded body), and `busybox cat`/`busybox awk`
(data → allow).

### C13 — `guard-state-file.ts:256` brace zero-padding untested
**Fix:** export `expandBraces` and add a **differential sweep against real
bash** over padded, negative, stepped, and mixed forms, plus a fixture where
padding decides block-vs-allow.

### C14 — `validate-agent-model.ts:138` grandfathering allow untested
**Fix:** handler-level tests — a mismatched model backed by a *real anchored*
run-directory authority allows; the same spawn backed by a **forged
out-of-tree** authority still blocks (the C3 regression).

### C15 — `orchestration.ts:1150` decide/complete approval gate untested
**Fix:** tests for wrong decision id, wave-authority mismatch, wrong program
kind, non-approve shape, and caller-attested outcome refusal.

### C16 — `publication.ts:17` proof caches publicly exported
*(ids: `type-design-analyzer-1`, `type-design-analyzer-8`)*

Six `export const` WeakMap/WeakSet proof caches are the sole trust root; any
direct sub-module import can seed one and mint an accepted result/registration.

**Fix:** stop exporting the caches. Four are module-private already by usage;
the two real cross-volume needs get **narrow read/clear accessors**
(`readInitialPublicationIssuance`, `clearInitialPublicationIssuance`,
`issuedSpawnRequestFor`). No `set`/`add` capability leaves the module.

### C17 — `types.ts:295` `Task` optional fields not `readonly`
*(ids: `type-design-analyzer-2`, `type-design-analyzer-9`)*

**Fix:** mark every remaining `Task` field `readonly`, matching the doc comment.

### C18 — `wave-gate-model.ts:48` contradictory gate representable
*(ids: `type-design-analyzer-3`, `type-design-analyzer-10`)*

Per the panel's own intent evidence, `blocked + complete` is legitimate. The
real unproven invariant is the one `update-task-status.ts:404` already claims
("the flag now tracks its causes, exactly like the load boundary's cross-field
proof") — a proof that does not exist. `validate-task-execution.ts:80` states
the gate's blocked flag has exactly two causes: critical review findings and a
critical wave-scoped spec-check. A causeless `blocked: true` prints
"BLOCKED due to:" with no reason and stalls the wave.

**Fix:** add a graph-level load-boundary proof — `blocked: true` requires a
cause (a task in that wave with critical findings, or
`spec_check.wave === wave && spec_check.critical_count > 0`) — and document
`blocked` as an orthogonal veto on `WaveGate` so it is not misread again.

### C19 — `pi/extension.ts:1999` triplicated baseline check, divergent catches
*(ids: `architecture-tech-lead-1`, `architecture-tech-lead-4`)*

Three copies of the "did tracked artifacts change since the attempt baseline"
check with three different catch behaviors; only the third records **no** task
resolution and leaves the task pending.

**Fix:** one shared helper returning a typed result with a single fail-closed
contract; all three sites call it, and site 3's failure falls through to the
same untrusted resolution instead of `continue`.

---

## Advisory dispositions — 43 ids, 28 distinct

**Accepted: 27 distinct advisories.** Every one has a sound claim and a
complete in-scope fix.

| # | Advisory | Disposition |
|---|---|---|
| A1 | `advance-phase.ts:170` substring containment on `spec_file`/`plan_file` | **accepted** — replace with resolved-path containment |
| A2 | `populate-task-graph.ts:185` TOCTOU on the non-pending guard | **accepted** — re-check inside the locked transform |
| A3 | `review-output.ts:231` `CRITICAL(?!_COUNT)` over-matches `CRITICALITY:` | **accepted** — word-boundary anchor |
| A4 | `no-follow-fs.ts:247` blanket catch strands a lock | **accepted** — narrow to ENOENT, report the rest |
| A5 | `run-directory-handle.ts:506` discards the read error | **accepted** — surface the cause in both `readRunAuthority` and `readContext` |
| A6 | `git-remediation.ts:549` blanket catch on `.git/index.lock` unlink | **accepted** — narrow to ENOENT, log the rest |
| A7 | `agent-definition.ts:28` silent `git rev-parse` failure | **accepted** — log like `utils/git.ts` |
| A8 | `fugue-program-runtime.ts:274` `onRejected` / resume-corrupt untested | **accepted** |
| A9 | `git-remediation.ts:518` concurrent `index.lock` EEXIST untested | **accepted** |
| A10 | `session-run-bindings.ts:62` duplicate identity/requestIds untested | **accepted** |
| A11 | `panel-operations.ts:127` `proveRosterNode` success arm untested | **accepted** |
| A12 | `context-packets.ts:151` `requiredFieldProblem` untested | **accepted** |
| A13 | `guard-state-file.ts:821` `MODULE_CONTINUE_FLAGS` untested | **accepted** |
| A14 | `panel-program.ts:595` reducers lack exhaustive illegal-pair property test | **accepted** |
| A15 | `record-orchestration-spawn.ts:58,89` handler + branches untested | **accepted** |
| A16 | `programs/remediation.ts:66` `driveRemediationFacade` failure branches untested | **accepted** |
| A17 | `validate-agent-model.ts:121` no allow-result test | **accepted** (folded into C14) |
| A18 | `validate-agent-skill.ts:29` `review-verifier-agent` untested | **accepted** |
| A19 | `update-task-status.ts:656` path-traversal guard untested on the Claude handler | **accepted** |
| A20 | `programs/wave-gate.ts:1284` re-derivation spin-guard untested | **accepted** |
| A21 | `validate-task-graph.ts:442` `runInvalidated` review-clearing untested | **accepted** |
| A22 | `standalone-review.ts:250` `docsOnly && sourceOrTestChanged` representable | **accepted** — reject at the parse boundary |
| A23 | `review-packet.ts:35` `baseSha`/`headSha` swappable | **accepted** — brand both |
| A24 | `panel-program.ts:512` `SlotSettlement` optional `retry`/`reason` | **accepted** — discriminate on outcome, drop the `!` |
| A25 | `completion.ts:51` `as UnissuedResultCause` cast | **accepted** — construct both arms exhaustively |
| A26 | `publication.ts:44` stale `@deprecated SpawnRequestInput` alias | **accepted** — delete (zero callers) |
| A27 | `orchestration.ts:1022` refutation tally duplicated in the shell | **accepted** — delegate to `core/review-panel.ts` |

**Deferred: 1.**

| A28 | `pi/extension.ts:1265` `tool_result` dispatch is one large function mixing I/O and decisions | **deferred** |

*Reason:* the correctness defect inside that function is C19, which this
remediation fixes and tests. What remains is a pure restructuring of a
~970-line dispatch loop into a functional core — a change with no correctness
delta, a large regression surface across every Pi lifecycle path, and no
supporting test scaffold in this scope. Deferring keeps the verified fix
separable from an unverifiable refactor. Recorded for a dedicated pass.

---

## Validation commands

```bash
cd engine && bunx tsc --noEmit
cd engine && env -u PI_CODING_AGENT npx vitest run --testTimeout=30000
cd engine && env -u PI_CODING_AGENT npm run test:smoke
```

All three must pass before any staging or commit.

### Result

- `bunx tsc --noEmit` — clean.
- `vitest run` — **165 files, 4346 tests, all passing** (up from 159/4145).
- `npm run test:smoke` — all five smoke suites PASS (panel-mode, review-panel,
  standalone-review, orchestration-facades, pi-resources).

---

## Defects the remediation UNCOVERED

Three real bugs surfaced while satisfying the findings, each caught by a test
written for a coverage finding rather than by the finding itself:

1. **`guard-state-file.ts` over-padded brace sequences** (found by C13's
   differential-vs-bash sweep). `{0..10}` rendered `00 01 … 10` where bash
   renders `0 1 … 10`: the padded-form test was `startsWith("0")` alone, so a
   lone `0` endpoint became "padded" whenever its partner was wider. The single
   pre-existing padded fixture asserted `allow` and could never have failed.
   Fixed by requiring the endpoint's own digit run to exceed one character.

2. **`store-review-findings` never cleared a blocked gate** (found by C18's
   load-boundary proof). An override that downgraded the last critical — or
   `--dismiss-all` — emptied `critical_findings` and passed the task's review
   while leaving `blocked: true`. The wave then sat behind a "BLOCKED due to:"
   list with nothing in it, and no rerun could clear a block with no cause.

3. **The refutation tally had the same gap.** A panel that refuted a wave's last
   critical removed the gate's only cause and left the flag standing — a block
   the panel itself could never clear, having already refuted everything.

(2) and (3) are why `waveHasBlockCause`/`reconcileWaveBlock` exist: one rule,
shared by both writers and the load boundary, so a setter and a clearer cannot
disagree about what a cause is.

A fourth was surfaced by making `pi/extension.ts` statically importable so
`piWriteTargetPaths` could be tested (C6): the file had **never been
type-checked** — it was only ever imported dynamically. Four genuine
type-safety gaps came out of that (an unchecked `input.command` read and three
closures capturing mutable `let`s whose narrowing did not survive), all fixed.

---

## Coverage honestly NOT added

- **A2 (`populate-task-graph` TOCTOU).** The locked re-check is implemented and
  its refusal path is exercised, but the race itself — a task leaving `pending`
  between the pre-lock read and the locked transform — cannot be staged
  deterministically without a seam that does not exist. The pre-lock check keeps
  its existing tests; the locked re-check is defense in depth with no dedicated
  test.
- **A11 (`proveRosterNode` success arm).** Reaching it needs a fully proved
  panel roster, a fixture materially larger than the finding. The node's
  rejection arms remain covered; its success arm is exercised end-to-end through
  the panel smoke suites but not through the DAG directly.
