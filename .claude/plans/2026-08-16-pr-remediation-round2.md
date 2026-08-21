# PR Remediation — 2026-08-16

**Branch:** `feat/architecture-panel-mode-plan`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/run.eJ5EAoirXM`
**Authoritative result:** `.claude/reviews/review-and-fix-runs/run.eJ5EAoirXM/result.json`
(digest `76c169569d126bd9ef0e55c99d589e614fc545198682d3464eead164c5ee1ec5`)

**Scope:** frozen standalone-review scope, 385 paths (whole-branch `all` review).
**Reviewer roster:** code-reviewer, silent-failure-hunter, pr-test-analyzer,
type-design-analyzer, comment-analyzer, architecture-tech-lead.
**Refutation Panel:** 3 lenses — reproduction, intent, security.

**Adjudication:** 8 surviving critical findings (4 distinct defects, each
recorded twice: once as a structured finding, once as a Machine Summary line),
0 refuted, 22 advisory findings (11 distinct, same duplication).

---

## Surviving critical findings — all mandatory

### C1 — `code-reviewer-1` / `code-reviewer-2`
`engine/src/handlers/pre-tool-use/validate-phase-order.ts:24`

`realPhaseOrderDeps.loadState` probes the protected task graph with bare
`existsSync`, which reports `false` for EACCES/ELOOP/ENOTDIR/EIO as well as
ENOENT. `validatePhaseOrder` treats a `null` load as "no active plan → allow"
(`engine/src/core/validate-phase-order.ts:196-197`), so an unreadable graph
disarms the spawn gate. The three sibling gates (`block-direct-edits.ts:33`,
`validate-template-substitution.ts:45`, `guard-state-file.ts:1859`) all use
`pathExistsFailClosed` for exactly this failure mode. Upheld by all three
lenses.

**Fix:** probe with `pathExistsFailClosed` from `../../config`; when the path
is provably present, construct `new StateManager(statePath)` directly instead
of `StateManager.fromPath`, whose own bare `existsSync` re-introduces the same
fail-open one call down. An unreadable-but-present graph then throws from
`load()`, and `pre-tool-use/validate-phase-order` is in `FAIL_CLOSED_ROUTES`
(`handler-routes.ts:49`), so the crash exits 2 = block. ENOENT remains the only
"absent → allow" answer.

### C2 — `silent-failure-hunter-1` / `silent-failure-hunter-5`
`engine/src/handlers/helpers/validate-task-graph.ts:691-699`

On malformed JSON with `--fix --minimal`, the catch block discards the input
and the parse error, writes `fixMinimal({})` to stdout, and returns
`passthrough` → exit 0. The caller sees a clean success and a plausible
task graph. The `repair.dataLoss` refusal cannot fire because the "repair" is
diffed against an already-empty stub. Reproduction lens upheld; intent and
security lenses returned `uncertain` (neither refuted the behavioural claim).

**Fix:** on parse failure always return `{ kind: "error", … }` carrying the
real `SyntaxError` message; never synthesize a graph from unparseable bytes.
`--fix --minimal` still fills defaults for valid-but-incomplete JSON (`{}`
remains a legal input for a canonical template). Update the two tests that
pinned the defect: `engine/tests/handlers/validate-task-graph.test.ts:404` and
`artifacts/tests/test-validate-task-graph.sh:138`.

### C3 — `type-design-analyzer-1` / `type-design-analyzer-6`
`engine/src/machine/evidence.ts:39` (+ `core/block-direct-edits.ts:20-22`,
`handlers/subagent-start/mark-subagent-active.ts:99`, `machine/ledger.ts:351`)

`AgentId`'s brand proves only binding-encoding and path safety, but
`isWriteAuthorizedAgent` treats the `pi-grant-` string prefix as proof of
cryptographic write authorization. The Claude Code SubagentStart path writes
any hook-supplied `agent_id` onto the `.active` roster verbatim through
`rosterAgentId`, which performs no grant lookup — so a reported id shaped like
`pi-grant-<hex>` is accepted as a capability. Post-hoc verification is
impossible: `consumePiWriteGrant` burns the grant record on consume. Upheld by
all three lenses.

**Fix:** make the grant namespace a real, enforced boundary rather than a
convention.
1. `engine/src/machine/evidence.ts`: export the reserved namespace constant,
   add `parseGrantedAgentId` (accepts only ids inside the namespace, returns a
   `GrantedAgentId` brand) and `parseReportedAgentId` (a smart constructor for
   harness-reported ids that refuses the reserved namespace).
2. `engine/src/machine/ledger.ts`: `rosterAgentId` routes through
   `parseReportedAgentId`, so a reported `pi-grant-*` id maps to the
   deterministic placeholder and can never reach the roster.
3. `engine/src/core/block-direct-edits.ts`: `isWriteAuthorizedAgent` tests
   `parseGrantedAgentId(agentId) !== null` instead of `startsWith`.
4. `pi/write-grant.ts`: mint the granted id through `parseGrantedAgentId` so
   the one legitimate producer is proven to be in the namespace.

### C4 — `comment-analyzer-1` / `comment-analyzer-2`
`engine/src/handlers/helpers/validate-model-bindings.ts:14`

The module doc comment calls `populate-task-graph` "the only whitelisted helper
that populates tasks into state". `repair-task-graph.ts:36-44` documents itself
as a second such path and calls `checkPlanModelBindings` at line 61;
`populate-task-graph.ts:150-153` says the same; `config.ts:409-410` whitelists
both. Upheld by all three lenses.

**Fix:** correct the enumeration to name `validate-task-graph`,
`populate-task-graph`, and `repair-task-graph`.

---

## Advisory dispositions

Decided autonomously from evidence, correctness impact, risk, and reviewed
scope. No operator input was requested.

| ID(s) | Disposition | Reason |
| --- | --- | --- |
| `silent-failure-hunter-2` / `-6` — `pi/write-grant.ts:276` `canonicalTarget` swallows every `realpathSync` error | **accepted** | Sound: security-critical scope canonicalization, and every sibling helper in the file narrows to ENOENT. Complete fix is small. |
| `silent-failure-hunter-3` / `-7` — `validate-task-graph.ts:699` hardcoded `"Invalid JSON"` | **accepted** | Sound; closed by the same edit as C2. |
| `silent-failure-hunter-4` / `-8` — `populate-task-graph.ts:110` hardcoded `"Invalid JSON on stdin"` | **accepted** | Sound; one-line fix restoring the file's own message-preservation convention. |
| `pr-test-analyzer-1` / `-4` — untested `bytesChangedSinceAttempt:false` branch | **accepted** | Real coverage gap in a fail-closed path; test is cheap using existing fakes. |
| `pr-test-analyzer-2` / `-5` — untested `compareAttemptBaseline` failure branches | **accepted** | Same; the documented fail-closed wiring is otherwise unpinned. |
| `pr-test-analyzer-3` / `-6` — untested structured-evidence-null diagnostic branch | **accepted** | Cheap to pin alongside the other two. |
| `type-design-analyzer-2` / `-7` — `PacketId`/`BaseSha`/`HeadSha` brand erasure | **accepted (core boundary)** | Branding `ReviewRunBinding` is core-only, 2 call sites, no persistence impact — done. The persisted `ReviewRun`/`FindingResolution` snake_case fields are **deferred**: branding them requires threading mints through `parseTaskGraph` and every state writer, a protected-state parser refactor out of proportion to an advisory with no live defect. |
| `type-design-analyzer-3` / `-8` — `Task.findings` lockstep not in the type | **deferred** | Encoding the lockstep in the type means replacing three persisted optional fields with one derived-view structure across `Task`, `parseTaskGraph`, all six documented writers and every reader. The invariant is already enforced fail-closed at load (`findingsLockstepError`) and at persist (`StateManager.atomicWrite`), so no illegal state is reachable today — only the compile-time guarantee is weaker. Disproportionate risk for an advisory. |
| `type-design-analyzer-4` / `-9` — `pi-structured:` label prefix is spoofable | **accepted** | Sound: a trust upgrade keyed on a free-text prefix. Replaced by an explicit `provenance` discriminant on the untrusted `ProofTestResult` variant, parsed back-compatibly (absent ⇒ `unverified`, i.e. fail-closed). |
| `type-design-analyzer-5` / `-10` — `parseAgentFrontmatter` admits self-contradictory `modelProfile`/`model` | **accepted** | Sound and small: fold the self-consistency check into the parser (parse-don't-validate). The catalog-policy check in `validateAgentPolicyFrontmatter` stays — it answers a different question. |
| `architecture-tech-lead-1` / `-2` — `checkArtifacts`/`resolveArtifact` embed direct fs I/O | **accepted** | Sound; completes the `PhaseOrderDeps` seam the same file already establishes, and removes the test suite's real-temp-directory dependency. |

## Refuted critical findings

None. The panel refuted zero criticals; every critical was `upheld` by at least
the reproduction and security lenses.

---

## Validation

```bash
bun run typecheck      # or: bunx tsc --noEmit
bun test               # full engine suite
bash artifacts/tests/test-validate-task-graph.sh
```

Validation must pass before any staging or remediation installation.

## Support paths (outside the frozen review scope)

- `.claude/plans/2026-08-16-pr-remediation.md` (this plan)
- `artifacts/tests/test-validate-task-graph.sh` (pins the C2 defect)
- `engine/src/handlers/helpers/store-test-evidence.ts` (must set the new
  `provenance` discriminant for the accepted `type-design-analyzer-4` fix)
