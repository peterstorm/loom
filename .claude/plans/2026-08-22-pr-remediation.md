# PR Remediation — Adjudicated Interactive Phase Transport Review

- **Branch:** `feat/pi-interactive-subagent-questions`
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/20260822T232831Z-01a02bcd-review`
- **Canonical result:** `.claude/reviews/review-and-fix-runs/20260822T232831Z-01a02bcd-review/result.json`
- **Exact reviewed scope:** `.claude/plans/2026-08-22-pr-remediation.md`, `CONTEXT.md`, `README.md`, `agents/architecture-agent.md`, `agents/specify-agent.md`, `artifacts/tests/test-validate-task-graph.sh`, `bun.lock`, `commands/loom.md`, `commands/templates/phase-architecture.md`, `commands/templates/phase-clarify.md`, `commands/templates/phase-specify.md`, `docs/README.md`, `docs/architecture.md`, `docs/deterministic-core.md`, `docs/migration-claude-code-to-pi.md`, `docs/pi-phase-agent-interviews.md`, `docs/pi-usage.md`, `docs/workflows.md`, `engine/src/core/model-profiles.ts`, `engine/src/core/spawn-admission.ts`, `engine/tests/core/spawn-admission.test.ts`, `engine/tests/pi-extension-review-events.test.ts`, `engine/tests/pi/ask-user-question.test.ts`, `engine/tests/pi/interactive-rpc.test.ts`, `engine/tests/pi/interactive-subagent.test.ts`, `pi/ask-user-question.ts`, `pi/extension.ts`, `pi/interactive-rpc.ts`, `pi/interactive-subagent.ts`, `scripts/smoke-pi-resources.sh`.
- **Support paths outside frozen scope:** none.

## Surviving critical findings

None. The canonical result contains zero surviving critical findings.

## Advisory dispositions

### Accepted

1. **`code-reviewer-1` — an aborted editor relay leaves an undismissed parent modal.** The Pi API accepts `AbortSignal` for select/confirm/input but not editor. Fail closed by declining an editor relay whenever a child-lifetime signal is present, rather than opening an undismissable dialog. Add a regression that abort/cancellation does not call the parent editor.
2. **`silent-failure-hunter-1` — legacy roster cleanup loses non-`Error` diagnostics and caller-visible failure.** Sound boundary defect. Render unknown thrown values safely, append the contextual diagnostic to `processingErrors`, and test a non-`Error` rejection.
3. **`pr-test-analyzer-1` — duplicate option labels lack coverage.** Sound edge-case gap. Add duplicate-label coverage at the registered tool interface.
4. **`type-design-analyzer-1` — duplicate option labels collapse semantic identity.** Sound invariant defect. Parse questions before opening UI and reject duplicate semantic labels, making label-based answers unambiguous by construction.
5. **`type-design-analyzer-2` — interactive RPC can pass an external Agent through.** Sound transport-authority defect. Block external Agents on the Loom-only interactive transport before native pass-through policy is considered; add regression coverage.
6. **`type-design-analyzer-3` — running progress inhabits the completed result shape via exit code `-1`.** Sound illegal-state defect. Split running progress from completed results with a discriminated union and permit `exitCode` only on completed results.
7. **`comment-analyzer-1` — PostEdit comment says an already-applied edit is blocked.** Sound documentation mismatch. Clarify that the error result forces repair of the edit already on disk; it does not roll back the write.
8. **`architecture-tech-lead-2` — a frozen `Set` remains membership-mutable.** Sound Agent Catalog invariant defect. Replace the exported Set with a pure catalog-derived transport predicate and update all consumers/tests.
9. **`code-simplifier-1` — repeated Pi tool-context type.** Sound local duplication. Introduce one local `ToolContext` alias.
10. **`code-simplifier-2` — definition admission carries an unreachable fallback diagnostic.** Sound dead state. Separate expected-model and definition-identity failures so only the validated failure message is representable.
11. **`code-simplifier-3` — unknown-error rendering repeats in the interactive shell.** Sound boundary-policy duplication. Name it once and reuse it in protocol, abort, invocation, and cleanup paths.
12. **`code-simplifier-4` — progress and final paths duplicate the subagent details envelope.** Sound envelope-invariant duplication. Add one immutable envelope constructor shared by both paths.
13. **`code-simplifier-5` — parsed strings are redundantly coerced with `String()`.** Sound parser noise. Build the proven string array directly while retaining exact invalid-index diagnostics.

### Deferred

1. **`architecture-tech-lead-1` — extract the whole interactive RPC lifecycle into a pure reducer.** The diagnosis is sound, but this is a broad seam redesign spanning protocol ordering, process lifecycle, timers, relay effects, and cleanup. The current subprocess adapter already has focused integration coverage, and the accepted correctness changes do not require moving that seam. Defer to a dedicated deepening with explicit event/effect types and property tests so remediation does not combine a lifecycle rewrite with bug fixes.

### Dismissed

None.

## Refuted critical finding audit

The canonical result contains **no refuted critical findings** and no Refutation Panel was required (`panel: null`).

## Planned implementation

1. Keep the green focused baseline as the behavior oracle.
2. Add regressions for duplicate option labels, external-Agent interactive admission, cancellable editor relays, running/completed result separation, and non-`Error` legacy cleanup failures.
3. Replace the mutable interactive-Agent projection with a pure Agent Catalog predicate and tighten Spawn Admission.
4. Parse AskUserQuestion label uniqueness before any UI effect and consolidate its context type.
5. Introduce explicit running/completed interactive result states, fail closed for undismissable editor relays, and consolidate boundary/error/envelope helpers.
6. Correct the PostEdit comment and remove parser coercion/dead admission state.
7. Run focused tests after each coherent move, then typecheck and the full unit/smoke suites.
8. From a green baseline, apply the mandatory `distill` pass in catalog order and rerun covering tests after each accepted move.
9. Start registered remediation from the immutable review run, resume to verified-index installation, then commit and push without force.

## Validation commands

```bash
cd engine
bunx vitest run \
  tests/core/spawn-admission.test.ts \
  tests/pi/ask-user-question.test.ts \
  tests/pi/interactive-rpc.test.ts \
  tests/pi/interactive-subagent.test.ts \
  tests/pi-extension-review-events.test.ts
bun run typecheck
bun run test:unit
bun run test:smoke
```
