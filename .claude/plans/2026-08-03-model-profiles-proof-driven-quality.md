# Explicit LLM Profiles and Proof-Driven Quality

**Date:** 2026-08-03
**Branch:** `feat/architecture-panel-mode-plan`
**Status:** Implemented and verified

## Goal

Stop Loom agents from inheriting an expensive orchestrator model, calibrate the
OpenAI models available under Pi instead of guessing at a Sonnet equivalent,
and move quality enforcement left so a Task cannot claim implementation without
explicit proof. At the same time, replace prose-owned panel dispatch policy with
a typed executable program and give reviewers an immutable, scoped packet.

## Decisions

1. **Model policy is role-based, not alias-based.** A semantic LLM Profile maps
to a Claude Code model and an exact Pi provider/model/thinking tuple. Missing or
mismatched bindings fail closed; current-model inheritance is never a fallback.
2. **The initial Pi mappings are conservative hypotheses.** Implementation,
general review, architecture/discovery panel design and judging, and refutation
use `openai-codex/gpt-5.6-sol`; focused review uses `openai-codex/gpt-5.5`;
mechanical work uses
`openai-codex/gpt-5.4-mini`. The calibration corpus is the authority for future
changes.
3. **A Task owns proof obligations.** The engine derives them from decomposition,
records observed evidence, and only writes `status: implemented` when all
obligations are satisfied. Legacy evidence fields remain derived compatibility
views for this PR, not independent authorities.
4. **Reviewers consume Review Packets.** A packet binds one Task, one git
snapshot, its declared/modified paths, exact diff/postimages, plan context, and
proof obligations with canonical hashes. Empty or unsafe scopes fail; there is
no fallback to all wave changes.
5. **Panel sequencing is executable.** Architecture and refutation remain
separate reducers over a shared Spawn Request ADT. The engine emits ordered
operations and exact model profiles; Markdown explains how to execute actions
but does not own counts, ordering, retry policy, or model choice.
6. **No universal panel framework.** Ranking Candidates and adjudicating
Findings remain distinct domain operations and continue to share only the panel
kernel and dispatch primitives.

## Domain model

### LLM Profile

A semantic execution policy with complete harness bindings:

```ts
type LlmProfile = Readonly<{
  id: LlmProfileId;
  claudeCode: { model: "haiku" | "sonnet" | "opus" };
  pi: { provider: "openai-codex"; model: PiOpenAiModel; thinking: PiThinkingLevel };
}>;
```

An exhaustive Agent Policy catalog assigns every Loom-owned agent one profile.
All phase, implementation, review, architecture-panel, and refutation-panel
sets are checked against this catalog.

### Proof Obligation

An engine-authored requirement and its state:

```ts
type TaskProof =
  | { state: "pending"; obligations: NonEmpty<ProofObligation> }
  | { state: "failed"; obligations: NonEmpty<ProofObligation>; failures: NonEmpty<ProofFailure> }
  | { state: "satisfied"; obligations: NonEmpty<ProofObligation>; evidence: NonEmpty<ProofEvidence> };
```

Initial deterministic obligations are regression-test pass, new tests (unless
explicitly waived), and changed declared artifacts. Trusted ledger evidence is
preferred; Pi structured tool-result evidence is recorded with its actual
provenance rather than relabeled as ledger evidence.

### Review Packet

Canonical immutable JSON plus hashed artifacts. Packet identity changes when
any Task context, path, diff, postimage, proof obligation, base SHA, or head SHA
changes. Review and refutation prompts read only manifest-listed artifacts.

### Panel Program

Two explicit state machines share a Spawn Request:

```ts
type SpawnRequest = Readonly<{
  id: string;
  agent: string;
  modelProfile: LlmProfileId;
  mode: "interactive" | "headless";
  attempt: 1 | 2;
  outputContract: string;
}>;
```

The program emits `engine-operation`, `spawn-batch`, `await-user`, `done`, or
`blocked` actions. Parallel batches can contain only headless requests.

## Implementation phases

### Phase 1 — LLM profiles and model enforcement

- Add `engine/src/core/model-profiles.ts` with profile parsers, exact Pi targets,
  Agent Policy catalog, harness lowering, and fail-closed resolution.
- Add `helper model-profiles <show|agent|validate|render-pi>`.
- Add `model-profile` and explicit Claude `model` frontmatter to Loom agents.
- Replace byte-copying in `scripts/sync-pi-agents.sh` with generated Pi
  definitions carrying exact OpenAI model IDs.
- Update `validate-agent-model` to handle Claude `Task`/`Agent` and Pi
  `subagent` field names, include both panel sets, and reject inheritance.
- Update Pi spawn validation and runbooks to require the resolved profile.

### Phase 2 — Proof-driven Task completion

- Add proof ADTs and pure evaluation in `engine/src/core/proof-obligations.ts`.
- Add `proof` and retained `plan_context` to `Task`.
- Derive pending obligations in `populate-task-graph`.
- Parse proof state at the task-graph boundary and enforce status/proof lockstep.
- Route Claude Code and Pi completion through the same evaluator.
- Keep a Task pending with precise failures when evidence is insufficient;
  `impl_complete` is derived only from proof-satisfied tasks.

### Phase 3 — Deterministic Review Packets

- Add pure packet canonicalization/hashing in `engine/src/core/review-packet.ts`.
- Add filesystem/git shell `helper review-packet <create|verify|show>`.
- Reuse run-boundary containment and reject traversal/symlinks/empty scope.
- Update wave-gate prompts to create one packet per Task and forbid broad live
  worktree discovery.

### Phase 4 — Historical model calibration

- Add `engine/src/core/model-calibration.ts` for corpus parsing, one-to-one
  deterministic finding matching, and profile scoring.
- Add `calibration/corpus.json` with vulnerable/fixed revisions from review
  remediation rounds and committed expected criticals.
- Add `helper model-calibration <validate|prompt|score>` and an opt-in Pi runner
  that always passes explicit provider/model/thinking arguments.
- Never count an unexecuted live calibration as passed and never classify novel
  Findings as false positives automatically.

### Phase 5 — Executable panel programs

- Add shared dispatch primitives and separate architecture/refutation reducers
  in `engine/src/core/panel-program.ts`.
- Add `helper panel-program <architecture|refutation>` that emits canonical
  action JSON from validated run artifacts.
- Encode ordering, parallelism, retry limits, and profile assignment in code.
- Reduce `commands/loom.md` and `commands/wave-gate.md` to action interpreters.

## Test strategy

- Unit and property tests for profile completeness, parser totality, deterministic
  resolution, and no parent-model fallback.
- Proof table/property tests: removing any required evidence prevents
  implementation; satisfied status/proof is a biconditional at the load boundary.
- Packet golden and mutation tests: input permutation stability, relevant-byte
  sensitivity, path safety, fixed-point serialization, and no broad fallback.
- Calibration tests: one prediction cannot satisfy two expectations; vulnerable
  and fixed snapshots score separately; malformed output fails loudly.
- Panel transition tests for every state/event, completion-order invariance,
  exact Spawn Requests, one retry, and no tally with pending slots.
- Pi/Claude parity tests over the same Agent Policy and proof evaluator.
- Existing unit, typecheck, panel smoke, and review-panel smoke suites remain the
  final merge gate.

## Acceptance criteria

- Every Loom-owned agent resolves to an explicit model on both harnesses.
- Pi uses only configured `openai-codex` targets and never current-model fallback.
- A Task with failed, missing, stale, or insufficient test proof remains pending.
- Every wave review is bound to a deterministic Task-scoped packet.
- Historical model outputs can be scored reproducibly without live calls in CI.
- Architecture and refutation dispatch order/model/retry policy have an
  executable source of truth.
- `npm test`, `npm run typecheck`, and both smoke suites pass.

## Verification

Completed on 2026-08-04:

- TypeScript typecheck passed.
- Full Vitest suite passed: 119 files, 2,439 tests.
- Panel-mode smoke passed: 22 checks.
- Review-panel smoke passed: 19 checks.
- Focused Loom lint passed for the new proof and Review Packet cores. The full
  project lint still reports pre-existing max-function findings outside this
  change; no new finding remains in those cores.
- All 28 agent policies validated and rendered to exact Pi model bindings.
- The eight-case historical calibration corpus validated without a live model
  call; live subscription calibration remains intentionally opt-in.
