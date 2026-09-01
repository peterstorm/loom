# PR Remediation Round 18

## Authority

- Branch: `fix/deterministic-task-completion-post-merge`
- Source review: `review-20260828T161231Z-deterministic-task-completion-oracle-post-remediation-22`
- Frozen scope: the 61 paths recorded in the source review `result.json`

## Surviving criticals

1. **TSX operators mistaken for JSX** (`engine/src/utils/git.ts`): replace the line-local angle-bracket heuristic with stateful TSX projection that enters JSX only at an opening tag and preserves ordinary TypeScript operators.
2. **Rust raw strings launder evidence** (`engine/src/utils/git.ts`): represent arbitrary-hash Rust raw-string delimiters in lexical state and suppress their contents; track nested block comments.
3. **Multiline JSX prose launders assertions** (`engine/src/utils/git.ts`): retain JSX tag/text/expression state across postimage lines and expose only JavaScript expression-container code.
4. **Describe-only suites count as tests** (`engine/src/utils/git.ts`): count executable `it`/`test` declarations, not `describe` suites; update evidence wording and regressions.

## Advisory dispositions

### Accepted

- `comment-analyzer-1`: replace review-number comments with durable behavior language.
- `comment-analyzer-2`: replace the historical round reference with the persisted-state invariant.
- `code-simplifier-1`: remove impossible `result.task` nullish fallbacks after canonical parsing.
- `code-simplifier-2`: share the test-path predicate used by `filterTestFiles` and evidence classification.

### Deferred

- `type-design-analyzer-1`: review-status/evidence-failure ADT redesign changes a broad persisted public shape and is not required for this evidence-parser remediation.
- `type-design-analyzer-2`: suite-readiness non-empty collection types require a broader constructor/parser migration.
- `type-design-analyzer-3`: opaque Wave Gate lifecycle authority requires an interface redesign and caller migration.
- `architecture-tech-lead-1`: config/runtime discovery separation is a standalone deepening.
- `architecture-tech-lead-2`: StateManager aggregate/repository decomposition is a standalone deepening.
- `architecture-tech-lead-3`: Wave Gate module decomposition is a standalone deepening.
- `architecture-tech-lead-4`: Pi spawn-correlation FC/IS extraction is a standalone deepening.

### Dismissed

- `code-simplifier-3`: local test read helpers are taste-level cleanup with no correctness or invariant payoff in this remediation.

## Refuted-finding audit

- None. All four source-review criticals survived canonical refutation.

## Validation

- `npm run typecheck`
- Focused `git.test.ts`, `git.property.test.ts`, collection, and Pi result tests with bounded workers
- Full bounded Vitest suite with Pi environment isolated
- `npm run test:smoke` with Pi environment isolated
- Changed-production lint
- `git diff --check`
- Registered remediation and exact verified-index installation
- Commit and push without force
- Fresh canonical standalone review and engine-owned refutation
