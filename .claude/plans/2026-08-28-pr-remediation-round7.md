# Post-merge Completion Oracle Remediation — Round 7

## Authority

- Branch: `fix/deterministic-task-completion-post-merge`
- Reviewed revision: `22900aa8157d4b909a66f1a1fdf1258baf776e28`
- Source review: `review-20260828T062512Z-deterministic-task-completion-oracle-post-remediation-11`
- Source digest: `8a49a93721df63f01259ca51ce7d1857fd31ede5869db8c96b07d3b7ab42b31d`
- Exact frozen scope: the 132 paths in immutable `result.json.scope`.
- Refuted criticals: none.

## Mandatory critical remediation

1. **Repository absence proof** — when Git reports `not a repository`, independently walk from the current directory to the filesystem root and inspect every `.git` candidate. Only ENOENT at every ancestor proves non-repository absence; any existing or inaccessible candidate throws. Add real unreadable-metadata, missing-Git, and empty-success-output subprocess regressions.
2. **Exact machine-binding cleanup** — correlate cleanup by parsed `agent_id` against persisted bindings even when the payload supplies a valid `agent_type`. A unique persisted binding is authoritative; disagreement is reported while the exact persisted identity is released. Make unbind return `released | not-owned` under its lock so a read/unbind race cannot masquerade as successful cleanup. Add disagreement and disposition regressions.
3. **Typed direct update boundary** — make direct `update-task-status` consume `parseSubagentStopStdin`; reject malformed domain shapes and unnameable direct Agent identities before any passthrough.
4. **Typed direct reviewer boundary** — make direct `store-reviewer-findings` consume the same parser and resolve Agent identity from trusted harness metadata when the payload omits it; reject an unnameable direct result rather than silently dropping findings.
5. **Missing-Git regression** — explicitly execute the `spawnSync.error` branch with an absolute Bun executable and a PATH containing no Git.

The shared SubagentStop parser will also replace duplicate syntax-only parsing in the other directly registered SubagentStop handlers (`advance-phase`, `capture-orchestration-result`, and `store-spec-check-findings`) so the same malformed-domain bypass cannot move to the next route.

## Advisory dispositions

### Accepted

- `pr-test-analyzer-1`: add the status-0/empty-stdout Git regression alongside the mandatory missing-Git test.

### Deferred

- `type-design-analyzer-1`: redesigning `TaskLocalByteObservation` into a derived closed state changes the completion application interface and warrants focused type work.
- `type-design-analyzer-2`: branding canonical paths throughout the persisted pointer lease registry is a broader wire-type migration.
- `architecture-tech-lead-1`: extracting TaskGraph parsing from StateManager is a dedicated core/shell module move.
- `architecture-tech-lead-2`: splitting the Wave Gate public surface is a dedicated deepening.
- `code-simplifier-1`: pointed-graph capture deduplication is unrelated StateManager cleanup.
- `code-simplifier-2`: shared Git bootstrap fixtures across inverse-policy suites are unrelated to these direct boundary regressions.

## Support paths

- `.claude/plans/2026-08-28-pr-remediation-round7.md`
- `engine/src/handlers/subagent-stop/advance-phase.ts`
- `engine/src/handlers/subagent-stop/capture-orchestration-result.ts`
- `engine/src/handlers/subagent-stop/store-spec-check-findings.ts`
- `engine/tests/handlers/store-spec-check-findings.test.ts`
- `engine/tests/handlers/subagent-stop/store-reviewer-findings.test.ts`
- `engine/tests/machine/fake-session-registry.ts`

## Validation

1. Focused Vitest for repository discovery, all direct SubagentStop routes, cleanup, ledger, and SessionRegistry properties.
2. `npm run typecheck` including unused checks.
3. Full bounded Vitest (`--testTimeout=30000 --maxWorkers=4 --minWorkers=1`).
4. `npm run test:smoke`.
5. Changed-production lint and `git diff --check`.
6. Registered remediation installs the exact verified index; commit and push without force.
7. Fresh canonical standalone review/refutation.
