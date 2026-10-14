# G1 live pilot follow-ups

**Date:** 2026-10-14
**Branch:** `fix/g1-pilot-followups`
**Source:** the M6 operator interventions recorded in the vault G1 design note ("Live pilot results"), from the `helper contract-status` pilot (PR #87, issue #86).

Each fix removes a manual step the pilot needed. One PR, no `/loom` run: every change is a local rule with an existing seam.

## Fixes

### 1. Population proves the Requirement trace (findings 3 and 6)

The spec failed canonical parsing (no `## Appendix: Glossary`) and population only warned. Decompose claimed `NFR-001` and `SC-001`; population accepted them and brief rendering refused them later, which forced an `amend-spec-trace`.

- `core/requirement-coverage.ts`: `unprovenRequirementTrace(specIndex, edges)` is the one admission rule for new Task→Requirement edges. Every id must be a completable FR or AS entry of the observed Spec Index. Its result is a `spec-index-unavailable | unknown-requirement` union, rendered by each caller.
- `core/spec-trace-amendment.ts` uses it for added ids, with the same messages as before.
- `core/task-graph-population.ts` refuses:
  - a declared spec it cannot index (unreadable, not UTF-8, or not canonical), even when nothing claims from it;
  - any id the index does not define;
  - any trace when there is no `spec_file`.
- The decompose template's own example claimed `SC-001`. It now claims `AS-001`, and the template states that both arrays name only `FR-NNN` and `AS-NNN` ids.

### 2. A contract's entry point (finding 2)

Decompose let T2 claim AS-001..003 in Wave 2, but only T3's Wave 3 route could turn them green.

- A new optional `**Entry point:**` field on `CT-N` names the production file the acceptance tests drive. It is plan-only and never persisted. A frozen path or an unsafe path is a `ContractProblem`.
- Plan binding refuses a claimant of a covered Requirement that neither writes the entry point nor depends, directly or transitively, on a Task that does. It also refuses an entry point that no Task writes.
- This is the dependency formulation, which mirrors "every claimant waits for the contract Task". It is per claimant, not per due Wave, so no claimant is ever told to turn green tests it cannot reach.
- The ADR-wave half of finding 2 needs no change. `validate-task-graph` already refuses ADR tasks outside the final Wave, which is how the pilot caught it.

### 3. Import-boundary lint on every edit (finding 4, first half)

A forbidden `core/` import was caught only by full-tier lint at Wave Gate start, after the contract Task had settled.

- `ProgrammaticRule.tier` declares each rule's earliest tier.
- `no-cross-boundary-imports` and `no-io-in-pure-modules` are cheap single-file rules, so they are `immediate`: the per-edit `lint-file` hook and Pi's adapter refuse the import when it is written.
- The other programmatic rules stay full-tier.

### 4. A vetoed spawn no longer strands a reservation (finding 4, second half)

The skill hook vetoed a spawn after `validate-task-execution` had already reserved the Task. The reservation sat for the 10-minute grace.

- `handlers/pre-tool-use/spawn-vetoes.ts` runs every read-only sibling veto (phase order, template, model, skill) in-process.
- `validate-task-execution` reserves only when all of them admit the spawn.
- The sibling hooks stay wired. Pi already composed these vetoes in `spawn-admission`.

### 5. Wave Gate advisory decision docs (finding 5)

`commands/wave-gate.md`, `commands/loom.md` and `docs/operations.md` showed a `defer` disposition, but the engine accepts only `{"kind":"approve"}`. The docs now show approval as the only decision, and say to abandon, re-dispatch the Task, and restart in order to fix an advisory first.

### 6. Reviewers are told their payload kind (M5)

Four Wave reviewers emitted `kind: standalone-review` in a wave slot. The issued schema admits both arms, and the shared wire-contract example is standalone.

- The v2 reviewer bootstrap in `core/spawn-task-text.ts` now names the exact kind: `wave-review` with `packetId`, `generation` and `prior_findings`, or `standalone-review`.
- No packet, schema or stamped-fragment bytes change.

## Not in this PR

- **Finding 1** (the architecture subagent has no AskUserQuestion under Claude Code) is a harness capability, not an engine rule.
- **Finding 7** (contract review before the freeze) is a design decision, settled before more G1 use: see the vault note.

## Verification

`npm run verify` (typecheck, the full Vitest suite, all smokes). New tests:

- `task-graph-population-spec-authority.test.ts`, including properties for the admission rule;
- `acceptance-contract-entry-point.test.ts`, including a chain property: an error exactly when the claimant precedes the writer;
- `immediate-boundary-rules.test.ts`, which reproduces the pilot's import;
- `spawn-vetoes.test.ts`, which leaves the State File byte-identical behind a veto;
- `reviewer-payload-kind.test.ts`.
