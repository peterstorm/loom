# PR Remediation — Pi Interactive Phase Transport

- **Branch:** `feat/pi-interactive-subagent-questions`
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/review-20260822T215846Z-5865`
- **Canonical result:** `.claude/reviews/review-and-fix-runs/review-20260822T215846Z-5865/result.json`
- **Reviewed scope:** `CONTEXT.md`, `README.md`, `agents/architecture-agent.md`, `agents/specify-agent.md`, `artifacts/tests/test-validate-task-graph.sh`, `bun.lock`, `commands/loom.md`, `commands/templates/phase-architecture.md`, `commands/templates/phase-clarify.md`, `commands/templates/phase-specify.md`, `docs/README.md`, `docs/architecture.md`, `docs/deterministic-core.md`, `docs/migration-claude-code-to-pi.md`, `docs/pi-phase-agent-interviews.md`, `docs/pi-usage.md`, `docs/workflows.md`, `engine/src/core/spawn-admission.ts`, `engine/tests/core/spawn-admission.test.ts`, `engine/tests/pi-extension-review-events.test.ts`, `engine/tests/pi/ask-user-question.test.ts`, `engine/tests/pi/interactive-rpc.test.ts`, `engine/tests/pi/interactive-subagent.test.ts`, `pi/ask-user-question.ts`, `pi/extension.ts`, `pi/interactive-rpc.ts`, `pi/interactive-subagent.ts`, `scripts/smoke-pi-resources.sh`.
- **Support paths outside frozen scope:** `.claude/plans/2026-08-22-pr-remediation.md`, `engine/src/core/model-profiles.ts`

## Mandatory surviving critical findings

1. **`pr-test-analyzer-1` — spawn wiring is unpinned**
   - Add a shell test that captures the real child command/arguments supplied to `spawnChild`.
   - Assert RPC mode, extension isolation, both Loom extension paths, exact model selection, and inclusion of `AskUserQuestion` in the child tool list.

2. **`type-design-analyzer-1` — rendered option collisions lose identity**
   - Give every rendered option a deterministic ordinal identity so equal/colliding labels and descriptions remain distinct values at the Pi `select` seam.
   - Preserve semantic answers as the original option labels.
   - Add single- and multi-select collision regression coverage.

3. **`comment-analyzer-1` — decoder framing comment disagrees with accepted CRLF input**
   - Rewrite the comment to state that LF delimits frames and an immediately preceding CR is tolerated/stripped.

## Advisory dispositions

### Accepted

1. **`code-reviewer-1` — in-flight relay can outlive the child.** Sound liveness defect. Bind relay waiting to a child-lifetime abort signal and add a child-crash-with-open-dialog regression.
2. **`code-reviewer-2` — oversized remainder survives after a complete frame.** Sound parser invariant gap. Recheck the residual buffer after consuming lines and add `valid frame + oversized remainder` coverage.
3. **`silent-failure-hunter-1` — missing active Pi entry point falls back to PATH.** Sound runtime-identity risk. Retain fallback only when there is no filesystem-backed active script (including Bun virtual scripts); fail loudly when a named active script disappears.
4. **`silent-failure-hunter-2` — abort-frame write failure is swallowed.** Sound diagnostic loss. Preserve the write failure as protocol evidence before terminating the child.
5. **`silent-failure-hunter-3` — cleanup can mask the primary result.** Sound boundary defect. Isolate and report cleanup failures without replacing the already-computed child result/failure.
6. **`silent-failure-hunter-4` — task-id extraction failure disappears.** Sound diagnostic loss. Include the secondary extraction error in the outer reconciliation diagnostic.
7. **`silent-failure-hunter-5` — `loom-status` assumes `Error`.** Sound unknown-catch handling defect. Render non-`Error` throws with `String(e)` and add coverage if the existing command fixture permits it without widening scope.
8. **`pr-test-analyzer-2` — registered tool wrapper is untested.** Sound integration seam gap. Exercise `registerInteractiveSubagentTool` through a fake Pi registration and assert the subagent-compatible details envelope.
9. **`pr-test-analyzer-3` — interactive roles are excluded from the skill property.** Sound property-test gap. Select the required transport from catalog policy so every skill-bearing Agent participates in the same property.
10. **`pr-test-analyzer-4` — custom answers lack coverage.** Sound user-flow gap. Add single- and multi-select custom-answer tests, including cancellation.
11. **`type-design-analyzer-3` — interactive set accepts arbitrary strings.** Sound type/source-of-truth defect. Derive a `ReadonlySet<LoomAgentName>` from an explicit Agent Catalog transport trait.
12. **`comment-analyzer-2` — test helper comments encode historical counts.** Sound documentation rot. Replace counts with invariant-oriented rationale.
13. **`comment-analyzer-3` — shell-test comment is historical.** Sound documentation rot. State the stable requirement that the test execute the repository CLI and reach graph validation.
14. **`comment-analyzer-4` — spawn-admission comment claims historical first coverage.** Sound documentation rot. Retain only the current pure-core test purpose.
15. **`architecture-tech-lead-1` — transport policy duplicates the Agent Catalog.** Sound violation of the documented Agent Catalog invariant. Add transport to catalog traits and derive the interactive projection used by Spawn Admission.
16. **`code-simplifier-1` — repeated answer construction.** Sound local incidental complexity. Add one immutable answer factory while preserving the tool result interface.

### Deferred

1. **`type-design-analyzer-2` — response union is not request-indexed.** The relay implementation already switches exhaustively on the request ADT and constructs method-correct responses. A request-indexed generic response API would change the module interface and all relay callers; defer to a focused deepening rather than coupling it to correctness remediation.
2. **`code-simplifier-2` — repeated Pi session context fixture.** The duplication is real but spans a large pre-existing integration-test file and does not affect the changed transport behavior. Defer to a dedicated behavior-preserving test-fixture distillation to avoid broad unrelated churn.

### Dismissed

None.

## Refuted critical finding audit

The canonical result contains **no refuted critical findings**. The panel did record one minority refutation for `comment-analyzer-1`: the intent lens reasoned that LF remains the only delimiter even when a preceding CR is stripped. The finding nevertheless survived the 2-of-3 threshold because reproduction and blast-radius upheld that “LF-only” overstates accepted input. The mandatory remediation therefore clarifies both facts.

## Planned implementation order

1. Run the focused pre-change test baseline.
2. Add failing regression tests for option identity, spawn argument wiring, child-lifetime cancellation, residual frame size, wrapper details, skill policy, and custom answers.
3. Add the Agent Catalog transport trait/projection and update Spawn Admission tests.
4. Fix option identity and consolidate immutable answer construction.
5. Harden decoder residual bounds and framing documentation.
6. Harden child lifetime, abort diagnostics, invocation identity, and cleanup isolation.
7. Improve extension diagnostics and accepted comments.
8. Run focused tests after each move, then typecheck and the complete unit/smoke suite.
9. Apply the mandatory `distill` pass only from a green baseline; keep interfaces stable and report skipped opportunities.
10. Start registered remediation with this plan as a support path, resume to verified index installation, commit, and push without force.

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
